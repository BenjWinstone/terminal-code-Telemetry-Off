import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { foreignBindings, holdsStamp, todeKeybindings, removalMasked } from "../profile";
import type { Binding } from "../profile";
import { extensionClaims } from "./imported";
import type { EditorHold, FreedMove, ProviderConflict, ShortcutProvider } from "./provider";
import { claimBindings, loadDecisions, overrideBindings } from "./store";
import { canonicalChord, defaultBinding } from "./vscode-keymap";
import { words } from "./words";

export function isGhostty(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "ghostty" || !!env.GHOSTTY_RESOURCES_DIR;
}

export function ghosttyBinary(): string | null {
  try {
    const found = execFileSync("which", ["ghostty"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** Ghostty reads a config from both of these when they exist and merges their
 * keybinds into one table — confirmed live, not assumed: a keybind only present
 * in the Application Support file shows up in `+list-keybinds` even when the
 * XDG file is what sets window-save-state. Either is a valid place to add
 * ours; whichever is already there is used so there is one file to look at,
 * and XDG is preferred when both exist since that is the more deliberate
 * choice for someone who set it up. */
function candidateConfigDirs(): string[] {
  const configHome =
    process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return [
    path.join(configHome, "ghostty"),
    path.join(os.homedir(), "Library", "Application Support", "com.mitchellh.ghostty"),
  ];
}

export function ghosttyConfigDir(): string {
  for (const dir of candidateConfigDirs()) {
    if (fs.existsSync(path.join(dir, "config"))) return dir;
  }
  // with no config anywhere, fall back to where this platform's ghostty makes
  // one itself: Application Support on macOS, XDG on linux
  return candidateConfigDirs()[process.platform === "darwin" ? 1 : 0];
}

export function parseKeybinds(output: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^keybind\s*=\s*(.+?)=(.+)$/.exec(line.trim());
    if (!match) continue;
    table.set(match[1].trim(), match[2].trim());
  }
  return table;
}

/** The currently effective set, defaults plus whatever the user's own config
 * files already changed — not just the compiled-in defaults, in case someone
 * already touched one of these. */
export function effectiveKeybinds(binary: string): Map<string, string> {
  const output = execFileSync(binary, ["+list-keybinds"], { encoding: "utf8" });
  return parseKeybinds(output);
}

let effectiveCache: Map<string, string> | null = null;

/** Test seam: replaces the `ghostty +list-keybinds` call so the whole
 * provider — scan, caches, freed-file writes — runs against a synthetic
 * config. Null restores the real binary. */
let listKeybindsSource: (() => string) | null = null;
export function setListKeybindsForTest(source: (() => string) | null): void {
  listKeybindsSource = source;
  effectiveCache = null;
  scanCache = null;
}

function effective(): Map<string, string> {
  effectiveCache ??= listKeybindsSource
    ? parseKeybinds(listKeybindsSource())
    : effectiveKeybinds(ghosttyBinary()!);
  return effectiveCache;
}

/** Ghostty documents every keybind action itself (+list-actions --docs), so
 * the wizard's descriptions are derived from the binary the user runs — the
 * first sentence of each action's docs, never a hand-written table. */
export function parseActionDocs(output: string): Map<string, string> {
  const docs = new Map<string, string>();
  let action: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (!action || lines.length === 0) return;
    const text = lines.join(" ");
    const sentence = /^(.+?)\.(?:\s|$)/.exec(text)?.[1] ?? text;
    docs.set(action, sentence);
  };
  for (const line of output.split("\n")) {
    const head = /^([a-z0-9_]+):\s*$/.exec(line);
    if (head) {
      flush();
      action = head[1];
      lines = [];
      continue;
    }
    if (action && /^\s+\S/.test(line)) lines.push(line.trim());
  }
  flush();
  return docs;
}

let docsCache: Map<string, string> | null = null;

function actionDocs(): Map<string, string> {
  if (docsCache) return docsCache;
  try {
    docsCache = parseActionDocs(
      execFileSync(ghosttyBinary()!, ["+list-actions", "--docs"], { encoding: "utf8" }),
    );
  } catch {
    docsCache = new Map();
  }
  return docsCache;
}

/** Editor chord syntax to ghostty trigger syntax: cmd is super, arrows,
 * paging and the backtick are spelled out, everything else matches. This must
 * invert every spelling fromTrigger produces, or a move targeting such a
 * chord writes a key name ghostty cannot parse and silently never lands. */
export function toTrigger(chord: string): string {
  return chord
    .split("+")
    .map((part) => {
      if (part === "cmd") return "super";
      if (["left", "right", "up", "down"].includes(part)) return `arrow_${part}`;
      if (part === "pageup") return "page_up";
      if (part === "pagedown") return "page_down";
      if (part === "`") return "grave_accent";
      return part;
    })
    .join("+");
}

/** Ghostty key names that the editor spells differently. Media keys (copy,
 * paste) have no editor chord at all and map to null. */
const TRIGGER_KEYS: Record<string, string | null> = {
  arrow_left: "left",
  arrow_right: "right",
  arrow_up: "up",
  arrow_down: "down",
  page_up: "pageup",
  page_down: "pagedown",
  grave_accent: "`",
  copy: null,
  paste: null,
};

/** A trigger's consumption flags, and the trigger with its prefixes removed.
 * unconsumed and performable binds pass the chord through (always, or when the
 * action cannot perform), so they never stand between the editor and a key. */
export function parseTrigger(raw: string): {
  trigger: string;
  passesThrough: boolean;
} {
  let trigger = raw.trim();
  let passesThrough = false;
  for (;;) {
    const found = /^(global|all|unconsumed|performable|physical):/.exec(trigger);
    if (!found) break;
    if (found[1] === "unconsumed" || found[1] === "performable") passesThrough = true;
    trigger = trigger.slice(found[0].length);
  }
  return { trigger, passesThrough };
}

/** Ghostty trigger syntax back to editor chord syntax, or null when the
 * trigger has no editor spelling (media keys, unrecognised names). */
export function fromTrigger(trigger: string): string | null {
  const parts = trigger.split("+").map((part) => {
    if (part === "super") return "cmd";
    if (/^digit_(\d)$/.test(part)) return part.slice("digit_".length);
    if (part in TRIGGER_KEYS) return TRIGGER_KEYS[part];
    return part;
  });
  if (parts.some((part) => part === null)) return null;
  return canonicalChord(parts.join("+"));
}

const HEADER = "# written by tode shortcut-setup — frees the chords the editor needs from ghostty\n";
export const INCLUDE_LINE = "config-file = ?tode/keybinds.ghostty";
const KEYBINDS_FILE = ["tode", "keybinds.ghostty"];

export function freedTriggers(configDir: string): Set<string> {
  try {
    const contents = fs.readFileSync(path.join(configDir, ...KEYBINDS_FILE), "utf8");
    return new Set(
      [...parseKeybinds(contents).entries()]
        // unbound, or rebound by tode to emit the chord's own bytes — both
        // mean the editor has the chord now; rebind targets (real ghostty
        // actions) are not freed triggers
        .filter(([, action]) => action === "unbind" || /^(esc:|csi:|text:)/.test(action))
        .map(([trigger]) => trigger),
    );
  } catch {
    return new Set();
  }
}

export function keybindsFileContents(moves: FreedMove[]): string {
  const lines = moves.flatMap((move) => [
    `keybind = ${move.trigger}=${move.emit ?? "unbind"}`,
    ...(move.to && move.action ? [`keybind = ${toTrigger(move.to)}=${move.action}`] : []),
  ]);
  return `${HEADER}${lines.join("\n")}\n`;
}

export function withInclude(config: string): string {
  if (config.split("\n").some((line) => line.trim() === INCLUDE_LINE)) return config;
  const separated = config.length > 0 && !config.endsWith("\n") ? `${config}\n` : config;
  return `${separated}${INCLUDE_LINE}\n`;
}

export function withoutInclude(config: string): string {
  return config
    .split("\n")
    .filter((line) => line.trim() !== INCLUDE_LINE)
    .join("\n");
}

/** Makes `triggers` exactly the set tode unbinds. Only the include file and the
 * one line that includes it are ever touched — the user's own config keeps
 * every byte, and an empty set removes both so nothing of ours is left. */
export function writeFreed(configDir: string, moves: FreedMove[]): string {
  const keybindsFile = path.join(configDir, ...KEYBINDS_FILE);
  const configFile = path.join(configDir, "config");
  if (moves.length === 0) {
    removeFreed(configDir);
    return keybindsFile;
  }
  fs.mkdirSync(path.dirname(keybindsFile), { recursive: true });
  fs.writeFileSync(keybindsFile, keybindsFileContents(moves));
  let config = "";
  try {
    config = fs.readFileSync(configFile, "utf8");
  } catch {}
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, withInclude(config));
  return keybindsFile;
}

export function removeFreed(configDir: string): boolean {
  const keybindsFile = path.join(configDir, ...KEYBINDS_FILE);
  const configFile = path.join(configDir, "config");
  let changed = false;
  if (fs.existsSync(keybindsFile)) {
    fs.rmSync(keybindsFile, { force: true });
    changed = true;
  }
  try {
    const config = fs.readFileSync(configFile, "utf8");
    const stripped = withoutInclude(config);
    if (stripped !== config) {
      fs.writeFileSync(configFile, stripped);
      changed = true;
    }
  } catch {}
  return changed;
}

/** What the editor would run on each chord: the user's own keybindings first,
 * then tode's, then extension contributions, then the workbench defaults. Any
 * hit means a terminal bind on the chord takes something from the editor.
 * Built as a closure so one scan pass reads keybindings.json and the decision
 * store once, not once per live terminal bind. */
export function makeEditorHolds(): (chord: string) => EditorHold[] {
  const own = new Map<string, EditorHold[]>();
  const record = (binding: Binding, claimant: string) => {
    if (!binding.key || !binding.command || binding.command.startsWith("-")) return;
    // a removal entry written later kills this rule the same way vscode does
    if (removalMasked(binding.key, binding.command)) return;
    const chord = canonicalChord(binding.key);
    const list = own.get(chord) ?? [];
    list.push({ command: binding.command, guard: binding.when, claimant });
    own.set(chord, list);
  };
  for (const binding of foreignBindings()) record(binding, "imported");
  for (const binding of todeKeybindings() as Binding[]) record(binding, "terminal-code");
  // the wizard's own written bindings — moved editor sides and remapped
  // claims — hold their chords like anything else the file carries; leaving
  // them out would let a future terminal bind land on them silently
  for (const binding of overrideBindings()) record(binding, "terminal-code");
  for (const binding of claimBindings()) record(binding, "terminal-code");
  return (chord) => {
    const held: EditorHold[] = [...(own.get(canonicalChord(chord)) ?? [])];
    for (const claim of extensionClaims(chord)) {
      held.push({
        command: claim.command,
        guard: claim.when,
        claimant: claim.claimant,
        describes: claim.describes,
      });
    }
    const fallback = defaultBinding(chord);
    if (fallback && !removalMasked(chord, fallback.command)) {
      held.push({ command: fallback.command, guard: fallback.when, claimant: "terminal-code" });
    }
    // one entry per command, higher-precedence spelling first — then the
    // unguarded holds lead: an always-on binding is the chord's real owner,
    // a guarded one only owns its own context, so it trails as one more
    // column rather than fronting the row
    const seen = new Set<string>();
    const unique = held.filter((hold) =>
      seen.has(hold.command) ? false : (seen.add(hold.command), true),
    );
    return [...unique.filter((hold) => !hold.guard), ...unique.filter((hold) => !!hold.guard)];
  };
}

/** Byte rewrites (text:, csi:, esc:) substitute the sequence the editor-side
 * emulation already understands, so they are not conflicts; unbind and ignore
 * consume nothing.
 *
 * The second group is ghostty's performable set: actions whose effect depends
 * on transient terminal state — a selection, an active search, prompt marks —
 * only consume the chord when that state exists, which it does not while the
 * editor pane has the keys. `+list-keybinds` does not print the performable
 * flag, so the semantics are classified by action here; an action this list
 * does not know stays a conflict, which over-reports rather than misses. */
const HARMLESS_ACTION =
  /^(unbind$|ignore$|text:|csi:|esc:|copy_to_clipboard|paste_from_clipboard|paste_from_selection|adjust_selection|scroll_to_selection|search_selection|end_search|navigate_search|jump_to_prompt|scroll_to_prompt)/;

/** Ghostty's tabs on macOS are native macOS tabs, and AppKit cycles them on
 * ctrl+tab before ghostty's own key handling runs — so an unbind hands the
 * chord to the OS, not to the editor. A chord that stays *bound* is claimed
 * by ghostty before the menu layer, so these are freed by rebinding them to
 * emit the chord itself as bytes: ghostty consumes the press, the terminal
 * program decodes the bytes back into the same chord. */
const MACOS_APP_LEVEL_ACTION = /^(next_tab|previous_tab)\b/;

/** Completes moves whose trigger the OS would otherwise reclaim: freeing an
 * app-level chord means rebinding it to emit its own bytes, and the move's
 * action says whether this trigger is one of those. The action is known both
 * on a live free (the scan's current) and on a re-apply (the decision kept
 * it), so this is the one place the emit is decided. */
export function withEmits(moves: FreedMove[]): FreedMove[] {
  if (process.platform !== "darwin") return moves;
  return moves.map((move) => {
    if (move.emit || !move.action || !MACOS_APP_LEVEL_ACTION.test(move.action)) return move;
    const chord = fromTrigger(move.trigger);
    const emit = chord ? emitSequence(chord) : null;
    return emit ? { ...move, emit } : move;
  });
}

/** xterm's modifyOtherKeys encoding (CSI 27;mods;codepoint~) of a chord, as a
 * ghostty esc: action — or null when the key has no simple codepoint. */
export function emitSequence(chord: string): string | null {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const codepoint =
    key === "tab" ? 9 : key === "enter" ? 13 : key === "escape" ? 27 : key === "space" ? 32
    : key.length === 1 ? key.charCodeAt(0) : null;
  if (codepoint === null) return null;
  const mods =
    1 +
    (parts.includes("shift") ? 1 : 0) +
    (parts.includes("alt") ? 2 : 0) +
    (parts.includes("ctrl") ? 4 : 0) +
    (parts.includes("cmd") ? 8 : 0);
  return `esc:[27;${mods};${codepoint}~`;
}

/** What a freed trigger used to run. The live keybind table no longer knows —
 * the free unbound it — but the decision that freed it kept the action,
 * whether it was recorded from the row itself or from a claimant column in
 * another row's duel. */
function decidedAction(chord: string): string | null {
  const choices = loadDecisions()?.choices ?? {};
  const direct = choices[chord]?.action;
  if (direct) return direct;
  for (const [id, decision] of Object.entries(choices)) {
    const owns = id === `claim:${chord}` || id.startsWith(`claim:${chord}:`);
    if (owns && decision.owner === "terminal" && decision.action) {
      return decision.action;
    }
  }
  return null;
}

/** Every conflict this terminal presents, derived live: any bind that always
 * consumes a chord the editor holds, whether it came from ghostty's defaults
 * or the user's own config. New ghostty releases and custom binds surface
 * here without anyone editing a table. */
export function allConflicts(
  effective: Map<string, string>,
  freed: Set<string>,
  holds: (chord: string) => EditorHold[] = makeEditorHolds(),
  past: (chord: string) => string | null = decidedAction,
  docs: Map<string, string> = actionDocs(),
): ProviderConflict[] {
  const seen = new Set<string>();
  const conflicts: ProviderConflict[] = [];

  const consider = (raw: string, action: string | null) => {
    const { trigger, passesThrough } = parseTrigger(raw);
    if (passesThrough) return;
    if (action !== null && HARMLESS_ACTION.test(action)) return;
    const chord = fromTrigger(trigger);
    if (!chord || seen.has(chord)) return;
    // the OS-level chords need the emit rebind to be freeable at all; one
    // that cannot be encoded cannot be freed, so it is not offered
    if (
      process.platform === "darwin" &&
      action !== null &&
      MACOS_APP_LEVEL_ACTION.test(action) &&
      !emitSequence(chord)
    ) {
      return;
    }
    const held = holds(chord);
    if (held.length === 0) return;
    const [primary, ...others] = held;
    seen.add(chord);
    // action is null for a trigger tode already freed; the decision that
    // freed it remembers what it ran, so the texts can still name it
    const ran = action ?? past(chord);
    const doing = ran ? words(ran) : "what it ran before";
    // ghostty's own docs for the action, when the binary offers them; the
    // cleaned identifier is only the fallback
    const described = ran ? (docs.get(ran.split(":")[0]) ?? doing) : doing;
    conflicts.push({
      editorId: chord,
      trigger,
      // the binding's identity: what the trigger runs, or ran before a free —
      // the mirror between a row and the claim records about it needs the
      // action even after the free landed
      current: ran,
      editor: {
        means: primary.describes ?? words(primary.command),
        command: primary.command,
        // the label above is generated from the command id; the id and the
        // source binding's own guard are the real metadata, shown small
        // under the label
        guard: primary.guard,
      },
      others,
      short: described,
      inTerminal: `runs ${doing} in Ghostty, so ${primary.describes ?? words(primary.command)} never reaches the editor`,
      freed: `${doing} goes`,
      tradeoff: `Ghostty's ${doing} stops working`,
    });
  };

  for (const [raw, action] of effective) {
    const { trigger } = parseTrigger(raw);
    consider(raw, freed.has(trigger) ? null : action);
  }
  for (const raw of freed) {
    if (!effective.has(raw)) consider(raw, null);
  }
  return conflicts;
}

interface ProcessInfo {
  ppid: number;
  command: string;
}

function processInfo(pid: number): ProcessInfo | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    const match = /^(\d+)\s+(.*)$/.exec(out);
    if (!match) return null;
    return { ppid: Number(match[1]), command: match[2] };
  } catch {
    return null;
  }
}

/** Ghostty reloads its configuration on SIGUSR2 — the same latent trick the
 * graphics engine ships. Walk our own ancestry to the ghostty process and
 * signal it, so an apply takes effect without the cmd+shift+, ritual. */
export function reloadGhostty(
  info: (pid: number) => ProcessInfo | null = processInfo,
  signal: (pid: number) => void = (pid) => process.kill(pid, "SIGUSR2"),
): boolean {
  let pid = process.pid;
  for (let hop = 0; hop < 16; hop++) {
    const me = info(pid);
    if (!me || me.ppid <= 1) return false;
    const parent = info(me.ppid);
    if (!parent) return false;
    const basename = parent.command.split("/").pop() ?? parent.command;
    if (basename.toLowerCase() === "ghostty") {
      try {
        signal(me.ppid);
        return true;
      } catch {
        return false;
      }
    }
    pid = me.ppid;
  }
  return false;
}

/** The manager asks for a scan several times per interaction — the decision
 * callback, the fresh steps, the confirm table — and nothing it stages changes
 * what the terminal holds, so one result serves until apply or undo rewrites
 * the config. */
let scanCache: { stamp: string; conflicts: ProviderConflict[] } | null = null;

export const ghosttyProvider: ShortcutProvider = {
  id: "ghostty",
  name: "Ghostty",
  detect: isGhostty,
  ready() {
    return ghosttyBinary() ? null : "the ghostty cli is not on PATH, so its keybinds cannot be read";
  },
  scan(): ProviderConflict[] {
    // keyed on every holds input, so an import or a boot that lands new
    // keybindings mid-session refreshes the scan instead of hiding conflicts
    const stamp = holdsStamp();
    if (scanCache?.stamp !== stamp) {
      scanCache = { stamp, conflicts: allConflicts(effective(), freedTriggers(ghosttyConfigDir())) };
    }
    return scanCache.conflicts;
  },
  takenAs(chord: string): string | null {
    // the same normalization the conflict scan applies: prefixed triggers
    // (global:, physical:) still hold their chord, pass-through and harmless
    // binds do not — vetting and scan must agree on what "held" means
    for (const [raw, action] of effective()) {
      const { trigger, passesThrough } = parseTrigger(raw);
      if (passesThrough) continue;
      if (action === "unbind" || action === "ignore" || HARMLESS_ACTION.test(action)) continue;
      if (fromTrigger(trigger) === chord) return action;
    }
    return null;
  },
  trigger: toTrigger,
  describe(action: string): string {
    return actionDocs().get(action.split(":")[0]) ?? words(action);
  },
  apply(moves: FreedMove[]): string {
    // the freed file changes what is effectively bound — both caches restart
    effectiveCache = null;
    scanCache = null;
    return writeFreed(ghosttyConfigDir(), withEmits(moves));
  },
  onApplied(): boolean {
    return reloadGhostty();
  },
  undo(): boolean {
    effectiveCache = null;
    scanCache = null;
    return removeFreed(ghosttyConfigDir());
  },
  reloadHint(): string {
    const chord = process.platform === "darwin" ? "cmd+shift+," : "ctrl+shift+,";
    return `reload ghostty (${chord}) or restart it for this to take effect`;
  },
};

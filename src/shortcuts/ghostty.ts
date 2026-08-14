import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { foreignBindings, todeKeybindings } from "../profile";
import type { Binding } from "../profile";
import { extensionHolder } from "./imported";
import type { FreedMove, ProviderConflict, ShortcutProvider } from "./provider";
import { canonicalChord, defaultBinding } from "./vscode-keymap";

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

function effective(): Map<string, string> {
  effectiveCache ??= effectiveKeybinds(ghosttyBinary()!);
  return effectiveCache;
}

/** Editor chord syntax to ghostty trigger syntax: cmd is super, arrows are
 * spelled out, everything else matches. */
export function toTrigger(chord: string): string {
  return chord
    .split("+")
    .map((part) => {
      if (part === "cmd") return "super";
      if (["left", "right", "up", "down"].includes(part)) return `arrow_${part}`;
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

interface Target {
  editorId: string;
  trigger: string;
  inTerminal: string;
  short: string;
  freed: string;
  tradeoff: string;
}

/** Quit is a conflict only when someone's own config bound the chord — no
 * platform of ghostty ships either one bound — so these two ride in both
 * platform tables and the texts say so. */
const QUIT_TARGETS: Target[] = [
  {
    editorId: "ctrl+q",
    short: "runs your own bind",
    freed: "your ctrl+q bind goes",
    trigger: "ctrl+q",
    inTerminal: "is bound in your Ghostty config, not by default, so quitting tode never reaches the editor",
    tradeoff: "whatever you bound ctrl+q to in Ghostty stops working",
  },
  {
    editorId: "ctrl+c",
    short: "runs your own bind",
    freed: "your ctrl+c bind goes",
    trigger: "ctrl+c",
    inTerminal: "is bound in your Ghostty config, not by default, so quitting tode never reaches the editor",
    tradeoff: "whatever you bound ctrl+c to in Ghostty stops working",
  },
];

/** What stands between Ghostty's shipped macOS defaults and the chords the
 * editor needs, checked against a live 1.3.1 install rather than assumed.
 * Every one of these silently substitutes a different byte sequence or
 * consumes the chord inside Ghostty itself, so the app never even sees a cmd
 * chord to have its own opinion about. */
const MAC_TARGETS: Target[] = [
  ...QUIT_TARGETS,
  {
    editorId: "cmd+w",
    short: "close the pane",
    freed: "panes close from the menu",
    trigger: "super+w",
    inTerminal: "closes the whole terminal pane, which can end a tode session by accident",
    tradeoff: "close panes from Ghostty's menu or with the mouse instead",
  },
  {
    // ghostty's undo is scoped to surfaces: per its docs it "can undo actions
    // such as closing tabs or windows" (windows, tabs, splits), within
    // undo-timeout — it never touches what a program in the terminal shows
    editorId: "cmd+z",
    short: "reopen a closed pane",
    freed: "closed panes stay closed",
    trigger: "super+z",
    inTerminal: "undoes Ghostty's last close — restoring a closed window, tab or split",
    tradeoff: "an accidentally closed Ghostty window, tab or split cannot be restored",
  },
  {
    editorId: "cmd+shift+z",
    short: "re-close a reopened pane",
    freed: "no Ghostty redo",
    trigger: "super+shift+z",
    inTerminal: "redoes the close that Ghostty's undo just restored",
    tradeoff: "Ghostty's redo of a restored close goes away",
  },
  {
    editorId: "cmd+shift+t",
    short: "reopen a Ghostty tab",
    freed: "cmd+z reopens tabs",
    trigger: "super+shift+t",
    inTerminal: "reopens Ghostty's last closed tab, which duplicates its undo",
    tradeoff: "reopen a closed Ghostty tab with cmd+z instead",
  },
  {
    editorId: "cmd+a",
    short: "select scrollback",
    freed: "mouse selects scrollback",
    trigger: "super+a",
    inTerminal: "selects all of the terminal's own scrollback",
    tradeoff: "select scrollback with the mouse instead",
  },
];

/** Ghostty's linux defaults live on ctrl+shift chords, and leave undo, redo,
 * select_all and quit unbound — so the only shipped default that shadows an
 * editor chord is new_tab. */
const LINUX_TARGETS: Target[] = [
  ...QUIT_TARGETS,
  {
    editorId: "ctrl+shift+t",
    short: "open a new tab",
    freed: "tabs open from the menu",
    trigger: "ctrl+shift+t",
    inTerminal: "opens a new Ghostty tab, so reopening a closed editor never reaches the workbench",
    tradeoff: "open new Ghostty tabs from the menu or your window manager instead",
  },
];

export function targetsFor(platform: NodeJS.Platform = process.platform): Target[] {
  return platform === "darwin" ? MAC_TARGETS : LINUX_TARGETS;
}

const HEADER = "# written by tode shortcuts — frees the chords the editor needs from ghostty\n";
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

/** A target is a conflict while the terminal still holds it, and stays listed
 * with current=null once tode's own file is what freed it. A chord the user
 * unbound themselves is not tode's to manage, so it does not appear at all. */
export function conflictsFrom(
  effective: Map<string, string>,
  freed: Set<string>,
  targets: Target[] = targetsFor(),
): ProviderConflict[] {
  return targets.flatMap((target): ProviderConflict[] => {
    const current = effective.get(target.trigger);
    if (freed.has(target.trigger)) return [{ ...target, current: null }];
    if (current === undefined || current === "unbind" || current === "ignore") return [];
    return [{ ...target, current }];
  });
}

/** What the editor would run on each chord: the user's own keybindings first,
 * then tode's, then extension contributions, then the workbench defaults. Any
 * hit means a terminal bind on the chord takes something from the editor.
 * Built as a closure so one scan pass reads keybindings.json and the decision
 * store once, not once per live terminal bind. */
export function makeEditorHolds(): (chord: string) => { command: string; guard?: string } | null {
  const own = new Map<string, { command: string; guard?: string }>();
  for (const binding of [...foreignBindings(), ...(todeKeybindings() as Binding[])]) {
    if (!binding.key || !binding.command || binding.command.startsWith("-")) continue;
    const chord = canonicalChord(binding.key);
    if (!own.has(chord)) own.set(chord, { command: binding.command, guard: binding.when });
  }
  return (chord) => {
    const mine = own.get(canonicalChord(chord));
    if (mine) return mine;
    const contributed = extensionHolder(chord);
    if (contributed) return { command: contributed.command, guard: contributed.when };
    const fallback = defaultBinding(chord);
    if (fallback) return { command: fallback.command, guard: fallback.when };
    return null;
  };
}

export function editorHolds(chord: string): { command: string; guard?: string } | null {
  return makeEditorHolds()(chord);
}

/** "workbench.action.reopenClosedEditor" -> "reopen closed editor",
 * "start_search" -> "start search": labels for rows nobody hand-wrote. A tail
 * too short to mean anything alone ("up", "toggle") keeps its parent. */
function words(id: string): string {
  const segments = id.split(".");
  let tail = segments.pop() ?? id;
  if (tail.length <= 6 && segments.length > 1) tail = `${segments.pop()} ${tail}`;
  return tail
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/** Terminal actions that are usually worth more than the chord they sit on:
 * freeing them removes a core piece of the terminal, so the wizard's cursor
 * starts on keep rather than on freeing. */
const PRECIOUS_ACTIONS =
  /^(new_tab|new_window|new_split|close_surface|close_tab|close_window|goto_tab|goto_split|previous_tab|next_tab|toggle_fullscreen|toggle_tab_overview|quit)\b/;

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

/** Every conflict this terminal presents: the curated targets with their
 * hand-written copy, then everything else derived live — any bind that always
 * consumes a chord the editor holds, whether it came from ghostty's defaults
 * or the user's own config. New ghostty releases and custom binds surface
 * here without anyone editing a table. */
export function allConflicts(
  effective: Map<string, string>,
  freed: Set<string>,
  targets: Target[] = targetsFor(),
  holds: (chord: string) => { command: string; guard?: string } | null = makeEditorHolds(),
): ProviderConflict[] {
  const curated = conflictsFrom(effective, freed, targets);
  const curatedTriggers = new Set(targets.map((target) => target.trigger));
  const seen = new Set(curated.map((conflict) => conflict.editorId));
  const derived: ProviderConflict[] = [];

  const consider = (raw: string, action: string | null) => {
    const { trigger, passesThrough } = parseTrigger(raw);
    if (passesThrough || curatedTriggers.has(trigger)) return;
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
    if (!held) return;
    seen.add(chord);
    const doing = action ? words(action) : "what it ran before";
    derived.push({
      editorId: chord,
      trigger,
      current: action,
      editor: {
        means: words(held.command),
        command: held.command,
        when: "!terminalFocus",
        recommend: action && PRECIOUS_ACTIONS.test(action) ? "keep" : "terminal",
        // the label above is generated from the command id; the id and its
        // guard are the real metadata, shown small under the label
        detail: held.guard ? `${held.command} · when ${held.guard}` : held.command,
      },
      short: doing,
      inTerminal: `runs ${doing} in Ghostty, so ${words(held.command)} never reaches the editor`,
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
  return [...curated, ...derived];
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
let scanCache: ProviderConflict[] | null = null;

export const ghosttyProvider: ShortcutProvider = {
  id: "ghostty",
  name: "Ghostty",
  detect: isGhostty,
  ready() {
    return ghosttyBinary() ? null : "the ghostty cli is not on PATH, so its keybinds cannot be read";
  },
  scan(): ProviderConflict[] {
    scanCache ??= allConflicts(effective(), freedTriggers(ghosttyConfigDir()));
    return scanCache;
  },
  takenAs(chord: string): string | null {
    const action = effective().get(toTrigger(chord));
    return action === undefined || action === "unbind" || action === "ignore" ? null : action;
  },
  apply(moves: FreedMove[]): string {
    scanCache = null;
    return writeFreed(ghosttyConfigDir(), withEmits(moves));
  },
  onApplied(): boolean {
    return reloadGhostty();
  },
  undo(): boolean {
    scanCache = null;
    return removeFreed(ghosttyConfigDir());
  },
  reloadHint(): string {
    const chord = process.platform === "darwin" ? "cmd+shift+," : "ctrl+shift+,";
    return `reload ghostty (${chord}) or restart it for this to take effect`;
  },
};

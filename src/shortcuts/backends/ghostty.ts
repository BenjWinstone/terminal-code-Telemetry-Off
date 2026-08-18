import { makeEditorHolds } from "../holds";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { holdsStamp } from "../../profile";
import type { EditorHold, FreedMove, ProviderConflict, ShortcutProvider } from "../provider";
import { loadDecisions } from "../store";
import { canonicalChord } from "../vscode-keymap";
import { words } from "../words";

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
  return candidateConfigDirs()[process.platform === "darwin" ? 1 : 0];
}

export function parseKeybinds(output: string): Map<string, string> {
  // okay 
  const table = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^keybind\s*=\s*(.+?)=(.+)$/.exec(line.trim());
    if (!match) continue;
    table.set(match[1].trim(), match[2].trim());
  }
  return table;
}

export function effectiveKeybinds(binary: string): Map<string, string> {
  const output = execFileSync(binary, ["+list-keybinds"], { encoding: "utf8" });
  return parseKeybinds(output);
}

let effectiveCache: Map<string, string> | null = null;

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

const HEADER = "# written by tode --shortcut-setup — frees the chords the editor needs from ghostty\n";
export const INCLUDE_LINE = "config-file = ?tode/keybinds.ghostty";
const KEYBINDS_FILE = ["tode", "keybinds.ghostty"];

export function freedTriggers(configDir: string): Set<string> {
  try {
    const contents = fs.readFileSync(path.join(configDir, ...KEYBINDS_FILE), "utf8");
    return new Set(
      [...parseKeybinds(contents).entries()]
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

// sus read into
const HARMLESS_ACTION =
  /^(unbind$|ignore$|text:|csi:|esc:|copy_to_clipboard|paste_from_clipboard|paste_from_selection|adjust_selection|scroll_to_selection|search_selection|end_search|navigate_search|jump_to_prompt|scroll_to_prompt)/;

  // sus readinot
const MACOS_APP_LEVEL_ACTION = /^(next_tab|previous_tab)\b/;

export function withEmits(moves: FreedMove[]): FreedMove[] {
  if (process.platform !== "darwin") return moves;
  return moves.map((move) => {
    if (move.emit || !move.action || !MACOS_APP_LEVEL_ACTION.test(move.action)) return move;
    const chord = fromTrigger(move.trigger);
    const emit = chord ? emitSequence(chord) : null;
    return emit ? { ...move, emit } : move;
  });
}

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
    const ran = action ?? past(chord);
    // slop copy
    const doing = ran ? words(ran) : "what it ran before";
    const described = ran ? (docs.get(ran.split(":")[0]) ?? doing) : doing;
    conflicts.push({
      editorId: chord,
      trigger,
      current: ran,
      editor: {
        means: primary.describes ?? words(primary.command),
        command: primary.command,
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

let scanCache: { stamp: string; conflicts: ProviderConflict[] } | null = null;

export const ghosttyProvider: ShortcutProvider = {
  id: "ghostty",
  name: "Ghostty",
  detect: isGhostty,
  ready() {
    return ghosttyBinary() ? null : "the ghostty cli is not on PATH, so its keybinds cannot be read";
  },
  scan(): ProviderConflict[] {
    const stamp = holdsStamp();
    if (scanCache?.stamp !== stamp) {
      scanCache = { stamp, conflicts: allConflicts(effective(), freedTriggers(ghosttyConfigDir())) };
    }
    return scanCache.conflicts;
  },
  takenAs(chord: string): string | null {
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
  // porque?
  reloadHint(): string {
    const chord = process.platform === "darwin" ? "cmd+shift+," : "ctrl+shift+,";
    return `reload ghostty (${chord}) or restart it for this to take effect`;
  },
};

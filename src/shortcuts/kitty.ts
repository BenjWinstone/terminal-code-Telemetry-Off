import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeEditorHolds } from "./ghostty";
import type { FreedMove, ProviderConflict, ShortcutProvider } from "./provider";
import { loadDecisions } from "./store";
import { canonicalChord } from "./vscode-keymap";
import { words } from "./words";

export function isKitty(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM === "xterm-kitty" || !!env.KITTY_WINDOW_ID || !!env.KITTY_PID;
}

export function kittyBinary(): string | null {
  try {
    const found = execFileSync("which", ["kitty"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** One key kitty holds, as kitty's own config parser resolved it: kitty_mod
 * expanded, aliases applied, later maps already overriding earlier ones.
 * `action` is null when the key only opens multi-key sequences — the first
 * press is consumed as a prefix even though no single action runs. */
export interface KittyBind {
  trigger: string;
  action: string | null;
  sequences: { keys: string; action: string }[];
}

export interface KittyKeymap {
  binds: KittyBind[];
  /** Action name to kitty's own one-line description, from its action registry
   * — the same text its documentation is generated from. */
  docs: Record<string, string>;
}

/** Runs inside kitty's python (`kitty +runpy`), so the keymap comes from the
 * exact parser the running terminal used: kitty_mod, includes, action aliases
 * and custom maps are all resolved by kitty, not re-implemented here. The
 * effective-definition selection mirrors kitty's own matching_key_actions:
 * a terminal (non-sequence) map last in the list wins alone; otherwise the
 * sequence maps after the last terminal one survive as prefixes.
 *
 * Everything lives inside main() because `kitty +runpy` execs the source with
 * the caller's frame as globals — names imported at top level are invisible
 * from nested scopes. */
const DUMP_SCRIPT = `
def main():
    import json
    from kitty.actions import get_all_actions
    from kitty.config import load_config
    from kitty.constants import defconf
    from kitty.fast_data_types import SingleKey
    from kitty.types import human_repr_of_single_key

    def spell(k):
        name = human_repr_of_single_key(SingleKey(mods=k.mods, is_native=k.is_native, key=k.key), 0)
        # the raw '+' key would read back as an empty part when kitty splits
        # the trigger on '+'; 'plus' is its parseable spelling
        return name[:-1] + 'plus' if name.endswith('++') or name == '+' else name

    opts = load_config(defconf)
    binds = []
    for key, defs in opts.keyboard_modes[""].keymap.items():
        matches = list(defs)
        if any(d.is_sequence for d in matches):
            last_terminal = -1
            for i, d in enumerate(matches):
                if not d.rest:
                    last_terminal = i
            if last_terminal > -1:
                matches = matches[last_terminal:] if last_terminal == len(matches) - 1 else matches[last_terminal + 1:]
        else:
            matches = matches[-1:]
        entry = {"trigger": spell(key), "action": None, "sequences": []}
        for d in matches:
            if d.is_sequence and d.definition:
                entry["sequences"].append({
                    "keys": " > ".join(spell(k) for k in (d.trigger,) + d.rest),
                    "action": d.definition,
                })
            elif not d.is_sequence and d.definition:
                entry["action"] = d.definition
        if entry["action"] or entry["sequences"]:
            binds.append(entry)
    docs = {}
    for group in get_all_actions().values():
        for action in group:
            docs[action.name] = action.short_help
    print(json.dumps({"binds": binds, "docs": docs}))
main()
`;

export function dumpKeymap(binary: string): KittyKeymap {
  const output = execFileSync(binary, ["+runpy", DUMP_SCRIPT], { encoding: "utf8" });
  return JSON.parse(output) as KittyKeymap;
}

let keymapCache: KittyKeymap | null = null;

function keymap(): KittyKeymap {
  keymapCache ??= dumpKeymap(kittyBinary()!);
  return keymapCache;
}

/** kitty looks here in this order; KITTY_CONFIG_DIRECTORY overrides, and the
 * Preferences path only exists on macOS installs that chose it. */
function candidateConfigDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.KITTY_CONFIG_DIRECTORY;
  if (override && path.isAbsolute(override)) dirs.push(override);
  const configHome =
    process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  dirs.push(path.join(configHome, "kitty"));
  dirs.push(path.join(os.homedir(), "Library", "Preferences", "kitty"));
  return dirs;
}

export function kittyConfigDir(): string {
  for (const dir of candidateConfigDirs()) {
    if (fs.existsSync(path.join(dir, "kitty.conf"))) return dir;
  }
  // with no config anywhere, kitty itself would create one under XDG (or the
  // override); the Preferences path is never the default it makes
  return candidateConfigDirs()[0];
}

/** Editor chord syntax to kitty trigger syntax: cmd is super, page keys grow
 * an underscore, everything else matches kitty's plain-character naming. */
export function toTrigger(chord: string): string {
  return chord
    .split("+")
    .map((part) => {
      if (part === "cmd") return "super";
      if (part === "pageup") return "page_up";
      if (part === "pagedown") return "page_down";
      return part;
    })
    .join("+");
}

/** kitty spellings the editor writes differently. Keys with no editor chord at
 * all (keypad, media, the bare plus key) map to null. */
const TRIGGER_KEYS: Record<string, string | null> = {
  page_up: "pageup",
  page_down: "pagedown",
  plus: null,
  insert: null,
  menu: null,
  print_screen: null,
};

/** kitty trigger syntax back to editor chord syntax, or null when the trigger
 * has no editor spelling. */
export function fromTrigger(trigger: string): string | null {
  const parts = trigger.split("+").map((part) => {
    if (part === "super" || part === "cmd" || part === "command") return "cmd";
    if (part === "opt" || part === "option") return "alt";
    if (part === "control") return "ctrl";
    if (part.startsWith("kp_")) return null;
    if (part in TRIGGER_KEYS) return TRIGGER_KEYS[part];
    return part;
  });
  if (parts.some((part) => part === null)) return null;
  return canonicalChord(parts.join("+"));
}

const HEADER = "# written by tode shortcuts — frees the chords the editor needs from kitty\n";
export const INCLUDE_LINE = "include tode/keybinds.kitty.conf";
const KEYBINDS_FILE = ["tode", "keybinds.kitty.conf"];

/** A bare `map <trigger>` empties the definition, and because this file is
 * included last it is also the last definition kitty considers — its own
 * dispatch then hands the key to the program, sequences and all. */
export function freedTriggers(configDir: string): Set<string> {
  try {
    const contents = fs.readFileSync(path.join(configDir, ...KEYBINDS_FILE), "utf8");
    const freed = new Set<string>();
    const compatible = new Set(Object.values(SHARED_REBINDS));
    for (const line of contents.split("\n")) {
      // bare, or rebound to a compatible action — both mean the editor has
      // the chord now; rebind targets (real kitty actions the user moved
      // somewhere else) are not freed triggers
      const match = /^map\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line.trim());
      if (match && (!match[2] || compatible.has(match[2]))) freed.add(match[1]);
    }
    return freed;
  } catch {
    return new Set();
  }
}

/** Actions kitty itself refuses to consume when they cannot perform, verified
 * against kitty 0.45's window.py: the scroll family returns pass-through
 * whenever the program is on the alternate screen — which the editor pane
 * always is — and copy_or_noop passes through without a selection, which the
 * editor pane never gives kitty since it owns the mouse. None of these ever
 * stand between the editor and a key. */
const HARMLESS_ACTION =
  /^(copy_or_noop|scroll_line_up|scroll_line_down|scroll_page_up|scroll_page_down|scroll_home|scroll_end|scroll_to_prompt|scroll_prompt_to_top|scroll_prompt_to_bottom)\b/;

/** Actions with a compatible spelling: the replacement does the same thing
 * whenever kitty can act, and passes the chord through whenever it cannot.
 * Freeing these costs nothing, so the wizard presents an acknowledgement
 * rather than a choice. */
const SHARED_REBINDS: Record<string, string> = {
  copy_to_clipboard: "copy_or_noop",
};

/** Completes moves whose action has a compatible spelling: the free becomes a
 * rebind to it rather than an unmap. The action is known both on a live free
 * (the scan's current) and on a re-apply (the decision kept it), so this is
 * the one place the rebind is decided — unless the user moved the action to
 * another chord, which keeps the plain unmap. */
export function withSharedRebinds(moves: FreedMove[]): FreedMove[] {
  return moves.map((move) => {
    if (move.emit || move.to || !move.action) return move;
    const rebind = SHARED_REBINDS[move.action.split(/\s+/)[0]];
    return rebind ? { ...move, emit: rebind } : move;
  });
}

/** A sequence prefix has no single action to carry to another chord, so its
 * conflicts are freeable but not movable; the marker `current` starts with
 * this prefix and apply refuses to write it as a rebind. */
const SEQUENCE_MARKER = "key sequence";

function rebindable(action: string | undefined): action is string {
  return !!action && !action.startsWith(SEQUENCE_MARKER);
}

export function keybindsFileContents(moves: FreedMove[]): string {
  const lines = moves.flatMap((move) => [
    `map ${move.trigger}${move.emit ? ` ${move.emit}` : ""}`,
    ...(move.to && rebindable(move.action) ? [`map ${toTrigger(move.to)} ${move.action}`] : []),
  ]);
  return `${HEADER}${lines.join("\n")}\n`;
}

export function withInclude(config: string): string {
  if (config.split("\n").some((line) => line.trim() === INCLUDE_LINE)) return config;
  const separated = config.length > 0 && !config.endsWith("\n") ? `${config}\n` : config;
  // appended, never inserted: kitty's later maps override earlier ones, and
  // the frees only win by coming after everything the user wrote
  return `${separated}${INCLUDE_LINE}\n`;
}

export function withoutInclude(config: string): string {
  return config
    .split("\n")
    .filter((line) => line.trim() !== INCLUDE_LINE)
    .join("\n");
}

/** Makes `moves` exactly the set tode frees or moves — only the include file
 * and the one line that includes it are ever touched, and an empty set removes
 * both so nothing of ours is left. */
export function writeFreed(configDir: string, moves: FreedMove[]): string {
  const keybindsFile = path.join(configDir, ...KEYBINDS_FILE);
  const configFile = path.join(configDir, "kitty.conf");
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
  const configFile = path.join(configDir, "kitty.conf");
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

/** What a freed trigger used to run. The live keymap no longer knows — the
 * free emptied it — but the decision that freed it kept the action. */
function decidedAction(chord: string): string | null {
  return loadDecisions()?.choices[chord]?.action ?? null;
}

/** The label for an action string: the action's own name, and for a kitten the
 * kitten's name with it, since `kitten` alone says nothing. */
function actionLabel(action: string): string {
  const tokens = action.split(/\s+/);
  return words(tokens[0] === "kitten" && tokens[1] ? `${tokens[0]}_${tokens[1]}` : tokens[0]);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Every conflict this terminal presents, derived live from kitty's own
 * parser: any bind that consumes a chord the editor holds, whether it came
 * from kitty's defaults, kitty_mod changes, or the user's own maps. New kitty
 * releases and custom keymaps surface here without anyone editing a table. */
export function allConflicts(
  { binds, docs }: KittyKeymap,
  freed: Set<string>,
  holds: (chord: string) => { command: string; guard?: string } | null = makeEditorHolds(),
  past: (chord: string) => string | null = decidedAction,
): ProviderConflict[] {
  const seen = new Set<string>();
  const conflicts: ProviderConflict[] = [];

  const consider = (trigger: string, bind: KittyBind | null) => {
    const chord = fromTrigger(trigger);
    if (!chord || seen.has(chord)) return;
    const held = holds(chord);
    if (!held) return;
    seen.add(chord);
    // bind is null for a trigger tode already freed; the decision that freed
    // it remembers what it ran, so the texts can still name it
    const ran = bind ? bind.action : past(chord);
    const doing = ran
      ? actionLabel(ran)
      : bind
        ? `${bind.sequences.length} key sequences`
        : "what it ran before";
    const doc = ran ? docs[ran.split(/\s+/)[0]] : undefined;
    const current = bind
      ? (bind.action ?? `${SEQUENCE_MARKER} (${bind.sequences.map((s) => s.keys).join(", ")})`)
      : null;
    const means = words(held.command);
    // a compatible rebind sticks to the row whether the free is still pending
    // (action from the live bind) or already applied (kept by the decision)
    const rebind = ran ? SHARED_REBINDS[ran.split(/\s+/)[0]] : undefined;
    conflicts.push({
      editorId: chord,
      trigger,
      current,
      editor: { means, command: held.command, guard: held.guard },
      short: doing,
      inTerminal: `runs ${doing} in kitty${doc ? ` (${lowerFirst(doc)})` : ""}, so ${means} never reaches the editor`,
      freed: rebind ? `${doing} stays whenever kitty can act` : `${doing} goes`,
      tradeoff: rebind ? "none — the chord is shared" : `kitty's ${doing} stops working`,
      shared: rebind
        ? {
            action: rebind,
            note:
              `kitty currently swallows ${trigger} even when it has nothing to copy. ` +
              `Rebinding it to ${rebind} keeps kitty's ${doing} whenever kitty has its own selection, ` +
              `and passes the chord through to ${means} the rest of the time — nothing is lost.`,
          }
        : undefined,
    });
  };

  for (const bind of binds) {
    if (freed.has(bind.trigger)) {
      consider(bind.trigger, null);
      continue;
    }
    if (bind.action && HARMLESS_ACTION.test(bind.action)) continue;
    consider(bind.trigger, bind);
  }
  for (const trigger of freed) {
    if (!binds.some((bind) => bind.trigger === trigger)) consider(trigger, null);
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

/** kitty reloads its configuration on SIGUSR1. Walk our own ancestry to the
 * kitty process and signal it, so an apply takes effect without the
 * ctrl+shift+f5 ritual. */
export function reloadKitty(
  info: (pid: number) => ProcessInfo | null = processInfo,
  signal: (pid: number) => void = (pid) => process.kill(pid, "SIGUSR1"),
): boolean {
  let pid = process.pid;
  for (let hop = 0; hop < 16; hop++) {
    const me = info(pid);
    if (!me || me.ppid <= 1) return false;
    const parent = info(me.ppid);
    if (!parent) return false;
    const basename = parent.command.split("/").pop() ?? parent.command;
    if (basename.toLowerCase() === "kitty") {
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

/** One scan serves each interaction, like ghostty's — nothing the manager
 * stages changes what the terminal holds until apply or undo rewrites disk. */
let scanCache: ProviderConflict[] | null = null;

export const kittyProvider: ShortcutProvider = {
  id: "kitty",
  name: "kitty",
  detect: isKitty,
  ready() {
    return kittyBinary() ? null : "the kitty cli is not on PATH, so its keymap cannot be read";
  },
  scan(): ProviderConflict[] {
    scanCache ??= allConflicts(keymap(), freedTriggers(kittyConfigDir()));
    return scanCache;
  },
  takenAs(chord: string): string | null {
    const wanted = canonicalChord(chord);
    const bind = keymap().binds.find((entry) => fromTrigger(entry.trigger) === wanted);
    if (!bind || freedTriggers(kittyConfigDir()).has(bind.trigger)) return null;
    return bind.action ?? SEQUENCE_MARKER;
  },
  apply(moves: FreedMove[]): string {
    scanCache = null;
    keymapCache = null;
    return writeFreed(kittyConfigDir(), withSharedRebinds(moves));
  },
  onApplied(): boolean {
    return reloadKitty();
  },
  undo(): boolean {
    scanCache = null;
    keymapCache = null;
    return removeFreed(kittyConfigDir());
  },
  reloadHint(): string {
    return "reload kitty (ctrl+shift+f5) or restart it for this to take effect";
  },
};

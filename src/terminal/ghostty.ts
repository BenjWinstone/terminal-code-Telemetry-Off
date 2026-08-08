import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // this is where a fresh macOS install of ghostty creates one itself
  return candidateConfigDirs()[1];
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

export interface ChordTarget {
  trigger: string;
  blocks: string;
  tradeoff: string;
}

/** What stands between Ghostty's shipped defaults and the chords vscode needs,
 * checked against a live 1.3.1 install rather than assumed. Every one of these
 * silently substitutes a different byte sequence or consumes the chord inside
 * Ghostty itself, so the app never even sees a cmd chord to have its own
 * opinion about. */
export const CHORD_TARGETS: ChordTarget[] = [
  {
    trigger: "super+backspace",
    blocks: "cmd+delete — delete to the start of the line",
    tradeoff:
      "the same jump at a bare shell prompt, which Ghostty currently gives you by sending ctrl+u instead",
  },
  {
    trigger: "super+arrow_left",
    blocks: "cmd+left — move to the start of the line",
    tradeoff: "the same jump at a bare shell prompt (currently sent as ctrl+a)",
  },
  {
    trigger: "super+arrow_right",
    blocks: "cmd+right — move to the end of the line",
    tradeoff: "the same jump at a bare shell prompt (currently sent as ctrl+e)",
  },
  {
    trigger: "super+z",
    blocks: "cmd+z — undo",
    tradeoff: "Ghostty's own undo of its terminal buffer, which nothing at a shell prompt relies on",
  },
  {
    trigger: "super+shift+z",
    blocks: "cmd+shift+z — redo",
    tradeoff: "the matching Ghostty-only redo",
  },
  {
    trigger: "super+shift+t",
    blocks: "cmd+shift+t — reopen the last closed editor",
    tradeoff: "Ghostty's own tab-reopen, which duplicates super+z for the same underlying action",
  },
  {
    trigger: "super+a",
    blocks: "cmd+a — select all",
    tradeoff: "selecting all of the terminal's own scrollback with the same chord",
  },
  {
    trigger: "super+w",
    blocks: "cmd+w — close the current editor tab",
    tradeoff:
      "right now cmd+w closes the whole terminal pane instead, which can end the tode session by " +
      "accident — freeing it removes that trap rather than adding one",
  },
];

export interface Conflict extends ChordTarget {
  current: string;
}

export function findConflicts(effective: Map<string, string>): Conflict[] {
  return CHORD_TARGETS.filter((target) => {
    const current = effective.get(target.trigger);
    return current !== undefined && current !== "unbind" && current !== "ignore";
  }).map((target) => ({ ...target, current: effective.get(target.trigger)! }));
}

const HEADER = "# written by tode doctor — frees the chords vscode needs from ghostty's defaults\n";
export const INCLUDE_LINE = "config-file = ?tode/keybinds.ghostty";

export function keybindsFileContents(conflicts: Conflict[]): string {
  return `${HEADER}${conflicts.map((c) => `keybind = ${c.trigger}=unbind`).join("\n")}\n`;
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

export function applyFix(configDir: string, conflicts: Conflict[]): void {
  const keybindsDir = path.join(configDir, "tode");
  fs.mkdirSync(keybindsDir, { recursive: true });
  fs.writeFileSync(path.join(keybindsDir, "keybinds.ghostty"), keybindsFileContents(conflicts));
  const configFile = path.join(configDir, "config");
  let config = "";
  try {
    config = fs.readFileSync(configFile, "utf8");
  } catch {}
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, withInclude(config));
}

/** Undoes exactly what applyFix did: the override file and the one line that
 * includes it, and nothing else in the user's own config. */
export function undoFix(configDir: string): boolean {
  const keybindsFile = path.join(configDir, "tode", "keybinds.ghostty");
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

import fs from "node:fs";
import path from "node:path";

/** The workbench's default keymap for this platform, generated from the pinned
 * code-server by scripts/generate-keymaps.js — never written by hand. This is
 * the editor's half of conflict detection: a terminal bind only matters when
 * the chord it consumes would have done something in the editor. */

/**
 * i guess somewhere we have to read from
 * vscode so that we know the when clause
 * 
 * theres also a question i have in the program which is
 * how does when clause actually get interpreted? it seems like
 * something with a when clause seems only like a partial conflict
 * (something with a when clause will conflict if there exists a ghostty keybind, but will not conflict with any other termianl code keybind since theres at least 1 case a shortcut does not run and the other does unless they are identical or the where condiiton leads to a case that never actually runs)
 */
export interface KeymapEntry {
  key: string;
  command: string;
  when?: string;
}

interface KeymapFile {
  bindings: KeymapEntry[];
}

const MODS = ["ctrl", "shift", "alt", "cmd"];
/**
 * 
 * what the fuck is this doing?
 * 
 * i guess this will be a question i can dig into
 * 
 * what is this doing?
 * 
 */

/**
 * this is actually bonkers i have no idea what this code could bhe doign
 * 
 * okay i really dont know what this does, and i still dont know the data source! thats what im 
 * interested in, at least one data source!
 * 
 * 
 * so this is getting a chord from at least the ghostty list keybinds
 */

export function canonicalChord(chord: string): string {
  const opener = chord.trim().split(/\s+/)[0] ?? "";
  const parts = opener.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const key = parts.pop()!;
  const mods = new Set(parts.map((part) => (part === "meta" || part === "super" ? "cmd" : part)));
  return [...MODS.filter((mod) => mods.has(mod)), key].join("+");
}

/**
 * 
 * so theres soa
 */
function keymapAsset(): string | null {
  // so i guess there just exists these files here, what what is the pasepath? path.dirname of dir. what?

  // this is batshit crazy, first im not even sure the form of for loops now
  // anyways, this might be able to be simplified a ton
  const name = `vscode-${process.platform === "darwin" ? "mac" : "linux"}.json`;
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "keymaps", name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

let cache: Map<string, KeymapEntry[]> | null = null;
/**
 * 
 * it seems like there is some file reading/writing?
 * 
 * why is it doing this? it seems like its using this for
 * 
 * in this specific instance, like what could this code possibly do? like we are reading and writing files?
 * and then we are comparing that to somehting else in the ghostty file? i think somehow we are deriving shortcuts
 * from vscode and using that to compare to ghsotty. i actually even thought about the nuance of performing this sort
 * of comparison
 * 
 */

function load(): Map<string, KeymapEntry[]> {
  if (cache) return cache;
  cache = new Map();
  // a file is keymap asset
  const file = keymapAsset();
  if (!file) return cache;
  try {
    // so its getting some keybinds form a file, what file?
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as KeymapFile;
    for (const entry of parsed.bindings ?? []) {
      // negative commands are the dump's own removal syntax, not bindings
      if (!entry.key || !entry.command || entry.command.startsWith("-")) continue;
      const chord = canonicalChord(entry.key);
      const list = cache.get(chord);
      if (list) list.push(entry);
      else cache.set(chord, [entry]);
    }
  } catch {}
  return cache;
}
/**
 * 
 * what is the entrypoint of this program? 
 * 
 * 
 * 
 */

export function defaultBinding(chord: string): KeymapEntry | null {
  const entries = load().get(canonicalChord(chord));
  if (!entries || entries.length === 0) return null;
  const core = (entry: KeymapEntry) =>
    /^(editor\.|workbench\.|actions\.|cursor|list\.|search\.)/.test(entry.command);
  return (
    entries.find((entry) => !entry.when && core(entry)) ??
    entries.find((entry) => !entry.when) ??
    entries.find(core) ??
    entries[0]
  );
}

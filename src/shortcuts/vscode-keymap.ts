import fs from "node:fs";
import path from "node:path";

/** The workbench's default keymap for this platform, generated from the pinned
 * code-server by scripts/generate-keymaps.js — never written by hand. This is
 * the editor's half of conflict detection: a terminal bind only matters when
 * the chord it consumes would have done something in the editor. */

export interface KeymapEntry {
  key: string;
  command: string;
  when?: string;
}

interface KeymapFile {
  bindings: KeymapEntry[];
}

const MODS = ["ctrl", "shift", "alt", "cmd"];

/** "shift+cmd+p" and "cmd+shift+p" are the same chord; map keys use one
 * spelling. Sequences ("cmd+k cmd+s") canonicalise to their opening chord,
 * because a terminal that eats the opener eats the whole sequence. */
export function canonicalChord(chord: string): string {
  const opener = chord.trim().split(/\s+/)[0] ?? "";
  const parts = opener.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const key = parts.pop()!;
  const mods = new Set(parts.map((part) => (part === "meta" || part === "super" ? "cmd" : part)));
  return [...MODS.filter((mod) => mods.has(mod)), key].join("+");
}

function keymapAsset(): string | null {
  const name = `vscode-${process.platform === "darwin" ? "mac" : "linux"}.json`;
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "keymaps", name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

let cache: Map<string, KeymapEntry[]> | null = null;

function load(): Map<string, KeymapEntry[]> {
  if (cache) return cache;
  cache = new Map();
  const file = keymapAsset();
  if (!file) return cache;
  try {
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

/** What the workbench runs on this chord by default, or null. A chord the
 * terminal eats never reaches any part of the page, so guards do not matter
 * for detection — but for the label, an unguarded core command beats a
 * contributed one that only fires inside some panel. */
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

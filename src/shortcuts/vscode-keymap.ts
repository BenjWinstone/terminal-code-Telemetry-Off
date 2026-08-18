import fs from "node:fs";
import path from "node:path";

export interface KeymapEntry {
  key: string;
  command: string;
  when?: string;
}

interface KeymapFile {
  bindings: KeymapEntry[];
}

const MODS = ["ctrl", "shift", "alt", "cmd"];

export function canonicalChord(chord: string): string {
  const opener = chord.trim().split(/\s+/)[0] ?? "";
  const parts = opener.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const key = parts.pop()!;
  const mods = new Set(parts.map((part) => (part === "meta" || part === "super" ? "cmd" : part)));
  return [...MODS.filter((mod) => mods.has(mod)), key].join("+");
}
let platformOverride: "mac" | "linux" | null = null;
export function setKeymapPlatformForTest(platform: "mac" | "linux" | null): void {
  platformOverride = platform;
  cache = null;
}

function keymapAsset(): string | null {
  const platform = platformOverride ?? (process.platform === "darwin" ? "mac" : "linux");
  const name = `vscode-${platform}.json`;
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
      if (!entry.key || !entry.command || entry.command.startsWith("-")) continue;
      const chord = canonicalChord(entry.key);
      const list = cache.get(chord);
      if (list) list.push(entry);
      else cache.set(chord, [entry]);
    }
  } catch {}
  return cache;
}

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

import fs from "node:fs";
import path from "node:path";

import { EXTENSIONS_DIR, builtinKeybindings, foreignBindings } from "../profile";

/** Chord equality the way vscode reads keys: modifier order and case do not
 * matter. */
function sameChord(a: string, b: string): boolean {
  const canon = (chord: string) =>
    chord
      .toLowerCase()
      .split("+")
      .map((part) => part.trim())
      .sort()
      .join("+");
  return canon(a) === canon(b);
}

/** What an imported or hand-written keybinding runs on this chord, or null
 * when nothing sits there. Entries whose command starts with "-" remove a
 * binding rather than hold the chord, so they do not count. */
export function importedHolder(chord: string): string | null {
  const found = foreignBindings().find(
    (entry) =>
      !!entry.key &&
      !!entry.command &&
      !entry.command.startsWith("-") &&
      sameChord(entry.key, chord),
  );
  return found?.command ?? null;
}

export interface ImportedConflict {
  key: string;
  /** the tode builtin command this claim shadows */
  builtin: string;
  command: string;
  /** who holds the chord: "imported" for keybindings.json, or the display
   * name of the extension that contributes it */
  claimant: string;
  /** a human reading of what the binding does, when one can be derived */
  describes?: string;
}

/** Every claimant sitting on a chord tode itself binds — quit, the pane
 * chords, all of them the same way. User keybindings outrank extension
 * keybindings in vscode, and both are written above tode's, so a claim here
 * silently wins over the builtin; the wizard surfaces each one next to the
 * terminal's conflicts. A guarded extension claim is already split
 * structurally — the builtin yields inside the claim's own when clause (see
 * store.carvedWhen) — so only unguarded claims still need a decision. */
export function importedConflicts(): ImportedConflict[] {
  const out: ImportedConflict[] = [];
  const seen = new Set<string>();
  for (const bind of builtinKeybindings()) {
    if (!bind.key || !bind.command || seen.has(bind.key)) continue;
    seen.add(bind.key);
    const command = importedHolder(bind.key);
    if (command && command !== bind.command) {
      out.push({ key: bind.key, builtin: bind.command, command, claimant: "imported" });
      continue;
    }
    const held = extensionClaims(bind.key).find((claim) => !claim.when);
    if (held && held.command !== bind.command) {
      out.push({ key: bind.key, builtin: bind.command, ...held });
    }
  }
  return out;
}

/** What an installed extension binds to a chord. Every installed extension's
 * contributed keybindings are scanned — nothing is special-cased to one chord
 * or one extension — because any of them is the same kind of claimant an
 * imported keybinding is: another editor-side holder the user should hear
 * about. */
export interface ExtensionClaim {
  command: string;
  claimant: string;
  when?: string;
  /** the command's contributed title when the extension declares one, else
   * the command id cleaned up for reading */
  describes: string;
}

function describeCommand(
  pkg: { contributes?: { commands?: { command?: string; title?: string }[] } },
  command: string,
): string {
  const declared = pkg.contributes?.commands?.find((entry) => entry.command === command);
  if (declared?.title) return declared.title;
  return command.replace(/^extension\./, "").replace(/[_.]/g, " ");
}

type ContributedBinding = ExtensionClaim & { key: string };

/** The scan walks every installed extension's package.json, and callers ask
 * per chord — sometimes ninety times in one pass — so the walk is cached and
 * keyed on extensions.json's mtime: an install or removal rewrites that file,
 * anything else leaves the cache warm. */
let contributedCache: { stamp: number; bindings: ContributedBinding[] } | null = null;

function contributedKeybindings(): ContributedBinding[] {
  const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
  let stamp: number;
  try {
    stamp = fs.statSync(manifest).mtimeMs;
  } catch {
    return [];
  }
  if (contributedCache && contributedCache.stamp === stamp) return contributedCache.bindings;

  const bindings: ContributedBinding[] = [];
  let listed: {
    identifier?: { id?: string };
    relativeLocation?: string;
    location?: { path?: string };
  }[] = [];
  try {
    listed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {}
  for (const entry of listed) {
    const dir = entry.relativeLocation
      ? path.join(EXTENSIONS_DIR, entry.relativeLocation)
      : entry.location?.path;
    if (!dir) continue;
    let pkg: {
      name?: string;
      displayName?: string;
      contributes?: {
        keybindings?: { key?: string; mac?: string; command?: string; when?: string }[];
        commands?: { command?: string; title?: string }[];
      };
    };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (pkg.name === "tode-bridge") continue;
    for (const bind of pkg.contributes?.keybindings ?? []) {
      const key = (process.platform === "darwin" && bind.mac) || bind.key;
      if (!key || !bind.command) continue;
      bindings.push({
        key,
        command: bind.command,
        claimant: pkg.displayName ?? pkg.name ?? "an extension",
        when: bind.when,
        describes: describeCommand(pkg, bind.command),
      });
    }
  }
  contributedCache = { stamp, bindings };
  return bindings;
}

/** Every extension binding on this chord, in install order. */
export function extensionClaims(chord: string): ExtensionClaim[] {
  return contributedKeybindings()
    .filter((bind) => sameChord(bind.key, chord))
    .map(({ key: _key, ...claim }) => claim);
}

export function extensionHolder(chord: string): ExtensionClaim | null {
  return extensionClaims(chord)[0] ?? null;
}


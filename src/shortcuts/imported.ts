import fs from "node:fs";
import path from "node:path";

import { EXTENSIONS_DIR, builtinKeybindings, foreignBindings, removalMasked } from "../profile";

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
      sameChord(entry.key, chord) &&
      !removalMasked(entry.key, entry.command),
  );
  return found?.command ?? null;
}

export interface ImportedConflict {
  key: string;
  builtin: string;
  command: string;
  claimant: string;
  describes?: string;
}

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
    const carved = (claim: ExtensionClaim) =>
      !!claim.when && (bind.when ?? "").includes(`!(${claim.when})`);
    const held = extensionClaims(bind.key).find(
      (claim) => claim.command !== bind.command && !carved(claim),
    );
    if (held) {
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

let contributedCache: { stamp: string; bindings: ContributedBinding[] } | null = null;

function contributedKeybindings(): ContributedBinding[] {
  const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
  const mtime = (file: string) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };
  const stamp = `${mtime(manifest)}:${mtime(EXTENSIONS_DIR)}`;
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
  const dirs = new Set<string>();
  for (const entry of listed) {
    const dir = entry.relativeLocation
      ? path.join(EXTENSIONS_DIR, entry.relativeLocation)
      : entry.location?.path;
    if (dir) dirs.add(dir);
  }
  try {
    for (const entry of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(path.join(EXTENSIONS_DIR, entry.name));
    }
  } catch {}
  for (const dir of dirs) {
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

export function extensionClaims(chord: string): ExtensionClaim[] {
  return contributedKeybindings()
    .filter((bind) => sameChord(bind.key, chord))
    .filter((bind) => !removalMasked(chord, bind.command))
    .map(({ key: _key, ...claim }) => claim);
}

export function extensionHolder(chord: string): ExtensionClaim | null {
  return extensionClaims(chord)[0] ?? null;
}


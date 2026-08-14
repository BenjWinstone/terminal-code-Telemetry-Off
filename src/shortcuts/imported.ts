import fs from "node:fs";
import path from "node:path";

import { EXTENSIONS_DIR, foreignBindings } from "../profile";
import { editorChord } from "./catalog";
import { QUIT_CHORD } from "./store";

/** Extensions whose quit-chord claims are resolved structurally: the hint and
 * quit bindings carry vim-mode guards, so each side gets the mode where the
 * chord means something to them, and there is nothing left to decide. */
export const VIM_EXTENSIONS = ["vscodevim.vim", "asvetliakov.vscode-neovim"];

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
  command: string;
  /** who holds the chord: "imported" for keybindings.json, or the display
   * name of the extension that contributes it */
  claimant: string;
  /** a human reading of what the binding does, when one can be derived */
  describes?: string;
}

/** User keybindings outrank extension keybindings in vscode, so an imported
 * entry on the quit chord silently wins over tode.quit. The wizard surfaces
 * this as its own case, next to the terminal's. */
export function importedQuitConflict(): ImportedConflict | null {
  const quit = editorChord(QUIT_CHORD);
  const command = importedHolder(quit.id);
  if (command && command !== quit.command) return { key: quit.id, command, claimant: "imported" };
  return extensionQuitClaim();
}

/** What an installed extension binds to this chord, or null. Every installed
 * extension's contributed keybindings are scanned — nothing is special-cased
 * to one chord — because any of them is the same kind of claimant an imported
 * keybinding is: another editor-side holder the user should hear about. */
export interface ExtensionClaim {
  command: string;
  claimant: string;
  /** the extension's id from extensions.json, like "vscodevim.vim" */
  extensionId?: string;
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
        extensionId: entry.identifier?.id,
        when: bind.when,
        describes: describeCommand(pkg, bind.command),
      });
    }
  }
  contributedCache = { stamp, bindings };
  return bindings;
}

export function extensionHolder(chord: string): ExtensionClaim | null {
  const found = contributedKeybindings().find((bind) => sameChord(bind.key, chord));
  if (!found) return null;
  const { key: _key, ...claim } = found;
  return claim;
}

export function extensionQuitClaim(): ImportedConflict | null {
  const held = extensionHolder(QUIT_CHORD);
  if (!held) return null;
  // a vim extension's hold on ctrl+c is already split by mode guards — the
  // wizard only surfaces contests that still need a decision
  if (QUIT_CHORD === "ctrl+c" && VIM_EXTENSIONS.includes(held.extensionId ?? "")) return null;
  return { key: QUIT_CHORD, ...held };
}

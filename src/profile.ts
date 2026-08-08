import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CSS_FILE } from "./codeserver/server";
import { injectedCss } from "./codeserver/inject";
import { parseJsonc, readKey, setKeys } from "./jsonc";
import { DATA_DIR } from "./runtime/paths";
import { queryTerminal, withFallbacks } from "./terminal/osc";
import type { TerminalPalette } from "./terminal/osc";
import { hex, legible, mix } from "./theme/color";
import {
  THEME_NAME,
  generateTheme,
  liveSettings,
  paletteFingerprint,
  semanticColors,
  surfaces,
} from "./theme/generate";

export const VSCODE_DIR = path.join(DATA_DIR, "vscode");
export const USER_DIR = path.join(VSCODE_DIR, "user-data", "User");
export const EXTENSIONS_DIR = path.join(VSCODE_DIR, "extensions");
const THEME_EXTENSION_ID = "tode.tode-theme";

/** code-server serves extension resources with a year-long cache-control, on the
 * assumption that a given (id, version, path) never changes its bytes — true for
 * a real published extension, false for ours, which rewrites the same theme
 * repeatedly. Chromium stays warm across tode sessions for speed, so a stable
 * folder name would mean a palette change is invisible until that cache clears
 * on its own. Folding the fingerprint into the folder name makes each distinct
 * palette its own URL, so a real change always misses the cache while an
 * unchanged one keeps hitting it for free. */
function themeExtensionDir(fingerprint: string): string {
  return path.join(EXTENSIONS_DIR, `${THEME_EXTENSION_ID}-${fingerprint}`);
}

function forgetOldThemeExtensions(keep: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return;
  }
  const prefix = `${THEME_EXTENSION_ID}-`;
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry !== keep) {
      fs.rmSync(path.join(EXTENSIONS_DIR, entry), { recursive: true, force: true });
    }
  }
}
const PALETTE_CACHE = path.join(DATA_DIR, "palette.json");
export const LIVE_SETTINGS_FILE = path.join(DATA_DIR, "live-settings.json");
export const LIVE_COLORS_FILE = path.join(DATA_DIR, "live-colors.raw.json");

export const FONT_FAMILY = "JetBrains Mono";
const FONT_FILE = "JetBrainsMono-Regular.ttf";

export function assetPath(name: string): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`bundled font missing: ${name}`);
  }
}

/** Chromium resolves editor fonts through the operating system, so a bundled
 * font has to actually be installed before vscode can use it. */
export const FONT_ASSET = FONT_FILE;

export function ensureFont(): "installed" | "present" {
  const target = path.join(os.homedir(), "Library", "Fonts", FONT_FILE);
  if (fs.existsSync(target)) return "present";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(assetPath(FONT_FILE), target);
  return "installed";
}

export function cachedPalette(): TerminalPalette | null {
  try {
    return JSON.parse(fs.readFileSync(PALETTE_CACHE, "utf8")) as TerminalPalette;
  } catch {
    return null;
  }
}

/** A palette learned some other way than the tty query — a live change coming
 * through terminal-browser — is still worth remembering, so the next open
 * falls back to it if the terminal happens not to answer that time. */
export function cachePalette(palette: TerminalPalette): void {
  fs.mkdirSync(path.dirname(PALETTE_CACHE), { recursive: true });
  fs.writeFileSync(PALETTE_CACHE, `${JSON.stringify(palette, null, 2)}\n`);
}

/** Ask the terminal, and keep the answer, so a pane that cannot be queried still
 * gets the colours this terminal reported last time. */
export async function readPalette(): Promise<{ palette: TerminalPalette; source: "terminal" | "cache" | "default" }> {
  const asked = await queryTerminal();
  if (asked?.background) {
    const palette = withFallbacks(asked);
    fs.mkdirSync(path.dirname(PALETTE_CACHE), { recursive: true });
    fs.writeFileSync(PALETTE_CACHE, `${JSON.stringify(palette, null, 2)}\n`);
    return { palette, source: "terminal" };
  }
  const cached = cachedPalette();
  if (cached) return { palette: cached, source: "cache" };
  return { palette: withFallbacks(null), source: "default" };
}

function writeIfChanged(file: string, contents: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return true;
}

/** A contributed theme rather than colorCustomizations, so it shows up as a real
 * theme and can carry token colours instead of only workbench ones. */
export function installTheme(palette: TerminalPalette): { changed: boolean; fingerprint: string } {
  const fingerprint = paletteFingerprint(palette);
  const dir = themeExtensionDir(fingerprint);
  // this exact fingerprint already has a folder, so the palette has not moved
  // and there is nothing to regenerate or re-register
  const already = fs.existsSync(path.join(dir, "themes", "tode-terminal.json"));
  if (!already) {
    const theme = generateTheme(palette);
    const manifest = {
      name: `tode-theme-${fingerprint}`,
      displayName: "tode terminal theme",
      publisher: "tode",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      categories: ["Themes"],
      contributes: {
        themes: [
          {
            label: THEME_NAME,
            uiTheme: theme.type === "dark" ? "vs-dark" : "vs",
            path: "./themes/tode-terminal.json",
          },
        ],
      },
    };
    fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, "themes", "tode-terminal.json"),
      `${JSON.stringify(theme, null, 2)}\n`,
    );
  }
  registerThemeExtension(dir);
  forgetOldThemeExtensions(path.basename(dir));
  return { changed: !already, fingerprint };
}

interface ExtensionEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  relativeLocation?: string;
  location?: { path?: string; scheme?: string; $mid?: number };
  metadata?: Record<string, unknown>;
}

function newestThemeExtensionDir(): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return null;
  }
  const prefix = `${THEME_EXTENSION_ID}-`;
  const withMtime = entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const full = path.join(EXTENSIONS_DIR, entry);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { full: string; mtime: number } => entry !== null);
  if (withMtime.length === 0) return null;
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].full;
}

/** Once an extensions.json exists, vscode reads that instead of looking at the
 * folder, so an import that writes one would hide the theme unless it is listed
 * there too. With no folder given, whichever one was written most recently is
 * what "the current theme" means. */
export function registerThemeExtension(dir?: string): void {
  const themeDir = dir ?? newestThemeExtensionDir();
  if (!themeDir) return;
  const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
  let listed: ExtensionEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (Array.isArray(parsed)) listed = parsed;
  } catch {
    return;
  }
  const folder = path.basename(themeDir);
  const entry: ExtensionEntry = {
    identifier: { id: THEME_EXTENSION_ID },
    version: "1.0.0",
    relativeLocation: folder,
    location: { $mid: 1, path: themeDir, scheme: "file" },
    metadata: { isApplicationScoped: false, isMachineScoped: false, installedTimestamp: 0 },
  };
  const without = listed.filter((item) => item.identifier?.id !== entry.identifier.id);
  fs.writeFileSync(manifest, `${JSON.stringify([...without, entry], null, 2)}\n`);
}

const SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": THEME_NAME,
  "editor.fontFamily": `"${FONT_FAMILY}", Menlo, monospace`,
  "terminal.integrated.fontFamily": `"${FONT_FAMILY}", Menlo, monospace`,
  "chat.editor.fontFamily": `"${FONT_FAMILY}", Menlo, monospace`,
  "debug.console.fontFamily": `"${FONT_FAMILY}", Menlo, monospace`,
  "markdown.preview.fontFamily": `"${FONT_FAMILY}", Menlo, monospace`,
  "terminal.integrated.enableImages": true,
  "workbench.startupEditor": "none",
  // the chat view lives in the secondary side bar, which opens itself for a
  // folder unless it is told not to
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.commandCenter.enabled": false,
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "editor.cursorBlinking": "solid",
  "editor.smoothScrolling": false,
  "workbench.list.smoothScrolling": false,
  "terminal.integrated.smoothScrolling": false,
  "editor.minimap.enabled": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "workbench.enableExperiments": false,
};

/** Starting points rather than rules. These are written only when the file does
 * not already say something, so an import or an edit of your own wins. */
const SEEDED: Record<string, unknown> = {
  // a pane is short of width long before it is short of height, and the upright
  // activity bar spends about fifty pixels of it
  "workbench.activityBar.location": "top",
  "editor.fontSize": 13,
  "workbench.tree.indent": 12,
};

/** The proxy reads this on each document, so a palette change reaches the page
 * on the next load without restarting anything. */
export function installCss(palette: TerminalPalette): boolean {
  const surface = surfaces(palette.background, palette.foreground);
  return writeIfChanged(
    CSS_FILE,
    injectedCss(
      hex(palette.background),
      FONT_FAMILY,
      { sidebar: hex(surface.sunken), line: hex(surface.raised) },
      {
        accent: hex(legible(semanticColors(palette).blue, surface.editor, 3)),
        text: hex(mix(palette.foreground, palette.background, 0.25)),
        faint: hex(mix(palette.foreground, palette.background, 0.55)),
        rule: hex(surface.border),
      },
    ),
  );
}

/** Every open tode bridge instance watches this file and applies whatever it
 * finds through the settings API, which is what makes a change reflect without
 * a reload — the contributed theme extension only takes effect on the next
 * one. Written on every open as well as on a live change, so a fresh window
 * gets full fidelity immediately rather than waiting on the next terminal
 * colour change to arrive. */
export function installLiveSettings(palette: TerminalPalette): boolean {
  const settings = liveSettings(palette);
  return writeIfChanged(LIVE_SETTINGS_FILE, `${JSON.stringify(settings)}\n`);
}

export function managedSettings(): Record<string, unknown> {
  return { ...SETTINGS };
}

/** Seeds first, so anything already written stays, then the managed keys, which
 * are the ones that make the editor match the terminal it sits in. */
export function applySettings(source: string): string {
  const absent = Object.fromEntries(
    Object.entries(SEEDED).filter(([key]) => readKey(source, key) === undefined),
  );
  return setKeys(setKeys(source, absent), SETTINGS);
}

export function installSettings(): boolean {
  const file = path.join(USER_DIR, "settings.json");
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {}
  return writeIfChanged(file, applySettings(source || "{}"));
}

/** Ctrl chords the terminal always delivers, added alongside the cmd chords
 * vscode already binds, so both reach the same command. Plain ctrl+letter stops
 * at the integrated terminal, where those belong to the shell. */
/** Deliberately short. A plain ctrl+letter is worth more to vim, emacs bindings
 * and the shell than it is as a second way to reach a command that already has a
 * cmd chord, so only the ones nothing else wants are taken.
 *
 * Left alone on purpose: a and e (line ends), b and f (page and character
 * motion), d and u (half page), n and p (completion and history), w (windows and
 * delete word), k (delete to end), r (reverse search), o and i (jump list),
 * v (visual and paste). */
const CTRL_ALIASES: { key: string; command: string; vimWants?: boolean }[] = [
  // vim binds ctrl+p itself, so it only reaches quick open where vim is not running
  { key: "ctrl+p", command: "workbench.action.quickOpen", vimWants: true },
  { key: "ctrl+s", command: "workbench.action.files.save" },
  { key: "ctrl+j", command: "workbench.action.togglePanel" },
  { key: "ctrl+/", command: "editor.action.commentLine" },
];

const CTRL_CHORDS: [string, string][] = [
  ["ctrl+shift+p", "workbench.action.showCommands"],
  ["ctrl+shift+f", "workbench.action.findInFiles"],
  ["ctrl+shift+e", "workbench.view.explorer"],
  ["ctrl+shift+g", "workbench.view.scm"],
  ["ctrl+shift+d", "workbench.view.debug"],
  ["ctrl+shift+x", "workbench.view.extensions"],
  ["ctrl+shift+m", "workbench.actions.view.problems"],
  ["ctrl+shift+o", "workbench.action.gotoSymbol"],
  ["ctrl+shift+k", "editor.action.deleteLines"],
  ["ctrl+shift+z", "redo"],
  ["ctrl+`", "workbench.action.terminal.toggleTerminal"],
  ["ctrl+,", "workbench.action.openSettings"],
];

/** Panes, on opt. The workbench keymap is the Linux one, so ctrl+1..8 already
 * focus editor groups — but ctrl belongs to the shell in a terminal pane, and
 * focusing a pane is mostly something you do from another pane. Opt is free on
 * both sides, so these are bound without a !terminalFocus guard: the chord has
 * to work from wherever you happen to be.
 *
 * The cost is opt+w, which readline and emacs read as copy. Add a
 * "!terminalFocus" when clause to that one entry if the shell needs it back. */
const PANE_CHORDS: [string, string][] = [
  ["alt+1", "workbench.action.focusFirstEditorGroup"],
  ["alt+2", "workbench.action.focusSecondEditorGroup"],
  ["alt+3", "workbench.action.focusThirdEditorGroup"],
  ["alt+4", "workbench.action.focusFourthEditorGroup"],
  ["alt+5", "workbench.action.focusFifthEditorGroup"],
  ["alt+6", "workbench.action.focusSixthEditorGroup"],
  ["alt+7", "workbench.action.focusSeventhEditorGroup"],
  ["alt+8", "workbench.action.focusEighthEditorGroup"],
  // nine is the last one there is rather than the ninth, the way a browser
  // treats it, because eight is as far as the named commands go
  ["alt+9", "workbench.action.focusLastEditorGroup"],
  ["alt+w", "workbench.action.closeEditorsInGroup"],
];

/** Terminals tend to swallow cmd, so every cmd chord is offered on ctrl too.
 * The mirror is generated rather than listed, so anything imported gets one. */
const NOT_MIRRORED = new Set([
  // a modal editor and the shell own the bare ctrl+letter chords
  // and these already mean something on ctrl in vscode for macos
  "tab",
  "space",
  "`",
  "-",
  "=",
  // cursor motion is not the same idea on each side
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "pageup",
  "pagedown",
  "backspace",
  "delete",
]);

export function mirrorKey(key: string): string | null {
  const parts = key.trim().toLowerCase().split(/\s+/)[0].split("+");
  if (!parts.includes("cmd") && !parts.includes("meta")) return null;
  if (parts.includes("ctrl")) return null;
  const base = parts[parts.length - 1];
  if (NOT_MIRRORED.has(base)) return null;
  const onlyModifier = parts.length === 2;
  if (onlyModifier && /^[a-z]$/.test(base)) return null;
  // a chord such as "cmd+k cmd+s" would need both halves rewritten; leave it
  if (key.trim().includes(" ")) return null;
  return parts.map((part) => (part === "cmd" || part === "meta" ? "ctrl" : part)).join("+");
}

interface MirrorSource {
  key?: string;
  command?: string;
  when?: string;
}

export function ctrlMirrors(bindings: MirrorSource[]): MirrorSource[] {
  const made: MirrorSource[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!binding.key || !binding.command) continue;
    // a leading minus removes a binding rather than adding one, and mirroring a
    // removal only risks cancelling something on the ctrl side
    if (binding.command.startsWith("-")) continue;
    const key = mirrorKey(binding.key);
    if (!key) continue;
    const signature = `${key} ${binding.command} ${binding.when ?? ""}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    made.push({ ...binding, key });
  }
  return made;
}

export function todeKeybindings(): unknown[] {
  return [
    ...CTRL_ALIASES.map(({ key, command, vimWants }) => ({
      key,
      command,
      when: vimWants ? "!terminalFocus && !vim.active" : "!terminalFocus",
    })),
    ...CTRL_CHORDS.map(([key, command]) => ({ key, command })),
    ...PANE_CHORDS.map(([key, command]) => ({ key, command })),
  ];
}

interface Binding {
  key?: string;
  command?: string;
  when?: string;
}

const KEYBINDINGS_FILE = path.join(USER_DIR, "keybindings.json");
/** What tode put in the file last time, so its own entries can be replaced
 * without touching anything else in there. */
const KEYBINDINGS_RECORD = path.join(DATA_DIR, "keybindings.tode.json");

function sameBinding(a: Binding, b: Binding): boolean {
  return a.key === b.key && a.command === b.command && (a.when ?? "") === (b.when ?? "");
}

function readBindings(file: string): Binding[] {
  try {
    const parsed = parseJsonc<Binding[]>(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Rewrites only the entries tode owns. Anything else in the file, whether it
 * was imported or written by hand, is carried across untouched — including
 * entries that used to be tode's and no longer are. */
export function installKeybindings(): boolean {
  const mine = todeKeybindings() as Binding[];
  const previouslyMine = readBindings(KEYBINDINGS_RECORD);
  const theirs = readBindings(KEYBINDINGS_FILE).filter(
    (entry) =>
      !previouslyMine.some((old) => sameBinding(old, entry)) &&
      !mine.some((current) => sameBinding(current, entry)),
  );
  return writeBindings(mine, theirs);
}

/** Writes the file as tode's chords, then yours, then a ctrl mirror of every cmd
 * chord among them that does not collide with something else. */
function writeBindings(mine: Binding[], theirs: Binding[]): boolean {
  const mirrors = ctrlMirrors(theirs).filter(
    (mirror) =>
      !mine.some((entry) => entry.key === mirror.key) &&
      !theirs.some((entry) => sameBinding(entry, mirror)),
  );
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(KEYBINDINGS_RECORD), { recursive: true });
  // the mirrors are recorded alongside tode's own entries so the next write
  // regenerates them instead of treating last time's as something you wrote
  fs.writeFileSync(KEYBINDINGS_RECORD, `${JSON.stringify([...mine, ...mirrors], null, 2)}\n`);
  return writeIfChanged(
    KEYBINDINGS_FILE,
    `// tode's ctrl chords, then yours, then a ctrl mirror of each cmd chord\n${JSON.stringify([...mine, ...theirs, ...mirrors], null, 2)}\n`,
  );
}

/** Adds imported bindings to whatever is already there, keeping tode's on top. */
export function mergeKeybindings(theirs: Binding[]): number {
  const mine = todeKeybindings() as Binding[];
  const previouslyMine = readBindings(KEYBINDINGS_RECORD);
  const existing = readBindings(KEYBINDINGS_FILE).filter(
    (entry) =>
      !previouslyMine.some((old) => sameBinding(old, entry)) &&
      !mine.some((current) => sameBinding(current, entry)),
  );
  const added = theirs.filter((entry) => !existing.some((have) => sameBinding(have, entry)));
  writeBindings(mine, [...existing, ...added]);
  return added.length;
}

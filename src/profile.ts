import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CSS_FILE } from "./codeserver/server";
import { FONT_FALLBACKS, injectedCss } from "./codeserver/inject";
import { parseJsonc, readKey, setKeys } from "./jsonc";
import { DATA_DIR } from "./runtime/paths";
import { claimBindings, fallbackBindings, hintBindings, overrideBindings, quitBindings } from "./shortcuts/store";
import { queryTerminal, withFallbacks } from "./terminal/osc";
import type { TerminalPalette } from "./terminal/osc";
import { hex } from "./theme/color";
import {
  THEME_NAME,
  generateTheme,
  paletteFingerprint,
  themeFingerprint,
  surfaces,
} from "./theme/generate";

export const VSCODE_DIR = path.join(DATA_DIR, "vscode");
export const USER_DIR = path.join(VSCODE_DIR, "user-data", "User");
export const EXTENSIONS_DIR = path.join(VSCODE_DIR, "extensions");
export const THEME_EXTENSION_ID = "tode.tode-theme";

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
export const LIVE_THEME_FILE = path.join(DATA_DIR, "live-theme.json");

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

function userFontsDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Fonts");
  const dataHome =
    process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "fonts");
}

export function ensureFont(): "installed" | "present" {
  const target = path.join(userFontsDir(), FONT_FILE);
  if (fs.existsSync(target)) return "present";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(assetPath(FONT_FILE), target);
  if (process.platform !== "darwin") {
    // fontconfig only sees a new file after its cache moves; best effort, the
    // workbench chrome gets the same font over http either way
    try {
      execFileSync("fc-cache", ["-f", path.dirname(target)], { stdio: "ignore" });
    } catch {}
  }
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

/** A vscode theme document — the shape generateTheme produces, and the shape
 * an actual theme file on disk parses to. Everything downstream of generation
 * speaks this, which is what lets a file and an inline theme travel the same
 * road. */
export interface ThemeDocument {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  semanticHighlighting?: boolean;
}

export function installTheme(palette: TerminalPalette): { changed: boolean; fingerprint: string } {
  return installThemeJson(generateTheme(palette), paletteFingerprint(palette));
}

/** A contributed theme rather than colorCustomizations, so it shows up as a real
 * theme and can carry token colours instead of only workbench ones. */
export function installThemeJson(
  theme: ThemeDocument,
  fingerprint: string,
): { changed: boolean; fingerprint: string } {
  const dir = themeExtensionDir(fingerprint);
  // this exact fingerprint already has a folder, so the theme has not moved
  // and there is nothing to regenerate or re-register
  const already = fs.existsSync(path.join(dir, "themes", "tode-terminal.json"));
  if (!already) {
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
            uiTheme: theme.type === "light" ? "vs" : "vs-dark",
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

const FONT_STACK = `"${FONT_FAMILY}", ${FONT_FALLBACKS}`;

const SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": THEME_NAME,
  "editor.fontFamily": FONT_STACK,
  "terminal.integrated.fontFamily": FONT_STACK,
  "chat.editor.fontFamily": FONT_STACK,
  "debug.console.fontFamily": FONT_STACK,
  "markdown.preview.fontFamily": FONT_STACK,
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
  // The default title format ends in ${appName} — "code-server". The folder is
  // already on the window above this bar, so the file name is the only part
  // left worth showing. ${dirty} puts a dot in front of unsaved work.
  "window.title": "${dirty}${activeEditorShort}",
  "editor.smoothScrolling": false,
  "workbench.list.smoothScrolling": false,
  "terminal.integrated.smoothScrolling": false,
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
  // tode's taste, not tode's requirements: an import or a hand edit wins
  "editor.cursorBlinking": "solid",
  "editor.minimap.enabled": false,
  // changed files as a tree reads like the project does
  "scm.defaultViewMode": "tree",
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
    ),
  );
}

/** The live slot holds a whole vscode theme document. Every open tode bridge
 * instance watches it and applies the theme's colours through the settings
 * API, which is what makes a change reflect without a reload — the contributed
 * theme extension only takes effect on the next one. Written on every open as
 * well as on a live change, so a fresh window gets full fidelity immediately
 * rather than waiting on the next terminal colour change to arrive. */
export function setLiveTheme(theme: ThemeDocument): boolean {
  return writeIfChanged(LIVE_THEME_FILE, `${JSON.stringify(theme)}\n`);
}

/** An actual vscode theme file becomes the editor theme: installed as the
 * contributed theme so the next load has it, and dropped into the live slot so
 * the window already open takes it without a reload. Theme files ship with
 * comments and trailing commas, so jsonc. Returns what went wrong, or null. */
export function setThemeFile(file: string): string | null {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return `could not read ${file}`;
  }
  const theme = parseJsonc<ThemeDocument>(source);
  if (!theme || typeof theme !== "object" || (!theme.colors && !theme.tokenColors)) {
    return `${file} is not a vscode theme (expected a json document with colors or tokenColors)`;
  }
  installThemeJson(theme, themeFingerprint(theme));
  setLiveTheme(theme);
  return null;
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

/** Panes, on opt. The workbench's own group-focus chords sit on the platform
 * modifier (cmd or ctrl plus a digit), which a terminal pane cannot always
 * spare — and focusing a pane is mostly something you do from another pane.
 * Opt is free on both sides, so these are bound without a !terminalFocus
 * guard: the chord has to work from wherever you happen to be.
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

/** The pane chords, then whatever the shortcut wizard decided belongs on the
 * editor side. There is deliberately no blanket cmd-to-ctrl transformation any
 * more: which chords need help differs per terminal and per user, and the
 * wizard (tode shortcuts) is where that gets decided, one chord at a time. */
export function todeKeybindings(): unknown[] {
  return [
    ...PANE_CHORDS.map(([key, command]) => ({ key, command })),
    ...quitBindings(),
    ...hintBindings(),
    ...fallbackBindings().map(({ key, command, when }) =>
      when ? { key, command, when } : { key, command },
    ),
  ];
}

export interface Binding {
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

/** The entries in keybindings.json that are not tode's: imported or written
 * by hand. Also what the wizard's import-conflict scan reads. */
export function foreignBindings(): Binding[] {
  const mine = [...(todeKeybindings() as Binding[]), ...overrideBindings(), ...claimBindings()];
  const previouslyMine = readBindings(KEYBINDINGS_RECORD);
  return readBindings(KEYBINDINGS_FILE).filter(
    (entry) =>
      !previouslyMine.some((old) => sameBinding(old, entry)) &&
      !mine.some((current) => sameBinding(current, entry)),
  );
}

/** Rewrites only the entries tode owns. Anything else in the file, whether it
 * was imported or written by hand, is carried across untouched — including
 * entries that used to be tode's and no longer are. */
export function installKeybindings(): boolean {
  return writeBindings(todeKeybindings() as Binding[], foreignBindings());
}

/** Writes the file as tode's chords, then yours, then the chords the wizard
 * decided must win over an import — vscode reads the file bottom-up. */
function writeBindings(mine: Binding[], theirs: Binding[]): boolean {
  const winners = [...overrideBindings(), ...claimBindings()];
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(KEYBINDINGS_RECORD), { recursive: true });
  fs.writeFileSync(KEYBINDINGS_RECORD, `${JSON.stringify([...mine, ...winners], null, 2)}\n`);
  return writeIfChanged(
    KEYBINDINGS_FILE,
    `// tode's chords, then yours, then what tode shortcuts decided must win\n${JSON.stringify([...mine, ...theirs, ...winners], null, 2)}\n`,
  );
}

/** Adds imported bindings to whatever is already there, keeping tode's on top. */
export function mergeKeybindings(theirs: Binding[]): number {
  const existing = foreignBindings();
  const added = theirs.filter((entry) => !existing.some((have) => sameBinding(have, entry)));
  writeBindings(todeKeybindings() as Binding[], [...existing, ...added]);
  return added.length;
}

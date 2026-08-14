import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Editor {
  name: string;
  userDir: string;
  extensionsDir: string | null;
  lastUsed: number;
}

/** The folder an editor keeps its extensions in is not derivable from the one it
 * keeps its settings in, so a few known names are tried before falling back to
 * the shape the rest of them follow. */
const KNOWN_EXTENSION_DIRS: Record<string, string> = {
  Code: ".vscode",
  "Code - Insiders": ".vscode-insiders",
  "code-oss-dev": ".vscode-oss",
  VSCodium: ".vscode-oss",
};

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findExtensionsDir(name: string): string | null {
  const home = os.homedir();
  const candidates = [
    KNOWN_EXTENSION_DIRS[name],
    `.${slug(name)}`,
    `.${slug(name.split(/\s+/)[0])}`,
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const dir = path.join(home, candidate, "extensions");
    if (fs.existsSync(path.join(dir, "extensions.json"))) return dir;
  }
  return null;
}

function modified(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Everything vscode shaped keeps its state in the platform's config home —
 * Application Support on macOS, ~/.config on linux — with a User folder and a
 * state database, whatever the product decided to call itself. */
export function findEditors(): Editor[] {
  const support =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
        ? process.env.XDG_CONFIG_HOME
        : path.join(os.homedir(), ".config");
  let names: string[];
  try {
    names = fs.readdirSync(support);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, userDir: path.join(support, name, "User") }))
    .filter((entry) => fs.existsSync(path.join(entry.userDir, "globalStorage", "state.vscdb")))
    .map((entry) => ({
      ...entry,
      extensionsDir: findExtensionsDir(entry.name),
      lastUsed: modified(path.join(entry.userDir, "globalStorage", "state.vscdb")),
    }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

export interface EditorContents {
  settings: boolean;
  keybindings: boolean;
  snippets: number;
  tasks: boolean;
  extensions: number;
}

function countExtensions(dir: string | null): number {
  if (!dir) return 0;
  try {
    const listed = JSON.parse(fs.readFileSync(path.join(dir, "extensions.json"), "utf8"));
    return Array.isArray(listed) ? listed.length : 0;
  } catch {
    return 0;
  }
}

export function describe(editor: Editor): EditorContents {
  const at = (name: string) => path.join(editor.userDir, name);
  let snippets = 0;
  try {
    snippets = fs.readdirSync(at("snippets")).filter((f) => f.endsWith(".json") || f.endsWith(".code-snippets")).length;
  } catch {}
  return {
    settings: fs.existsSync(at("settings.json")),
    keybindings: fs.existsSync(at("keybindings.json")),
    snippets,
    tasks: fs.existsSync(at("tasks.json")),
    extensions: countExtensions(editor.extensionsDir),
  };
}

export function summarise(contents: EditorContents): string {
  const parts = [
    contents.extensions ? `${contents.extensions} extensions` : null,
    contents.settings ? "settings" : null,
    contents.keybindings ? "keybindings" : null,
    contents.snippets ? `${contents.snippets} snippet files` : null,
    contents.tasks ? "tasks" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing to import";
}

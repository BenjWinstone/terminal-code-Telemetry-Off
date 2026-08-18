import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./runtime/paths";
import { EXTENSIONS_DIR, LIVE_THEME_FILE } from "./profile";
import { IMPORT_DECISION_ID, QUIT_CHORD, QUIT_COMMAND, hintWhen, loadDecisions, quitWhen } from "./shortcuts/store";

const BRIDGE_ID = "tode.tode-bridge";
const BRIDGE_VERSION = "1.5.1";

// what is this?
const STARTUP_VIEW_FILE = path.join(DATA_DIR, "startup-view.json");

/** tode --review writes this just before launching; the bridge consumes it on
 * activation and focuses the view. One-shot, so a normal open stays normal. */
export function requestStartupView(view: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_VIEW_FILE, `${JSON.stringify({ view, at: Date.now() })}\n`);
}
export const BRIDGE_DIR = path.join(EXTENSIONS_DIR, `${BRIDGE_ID}-${BRIDGE_VERSION}`);

/**
 * 
 * i need to map out the code this is basically gonna be a giant code review session
 * 
 * the obvious question is where is the entrypoint of the program
 * so i can start traversing it
 * 
 * 
 */
function manifest(): unknown {
  const quitBinding = { command: QUIT_COMMAND, key: QUIT_CHORD, when: quitWhen() };
  const hintBinding =
    QUIT_CHORD === "ctrl+c"
      ? []
      : [{ command: "tode.quitHint", key: "ctrl+c", when: hintWhen() }];
  return {
    name: "tode-bridge",
    displayName: "terminal-code",
    publisher: "tode",
    version: BRIDGE_VERSION,
    engines: { vscode: "^1.80.0" },
    main: "./extension.js",
    // "*" on purpose: onStartupFinished is deferred until the workbench has
    // idled, which makes tode --review flip the view seconds late. The bridge
    // is a few file reads and a socket, cheap enough to run during startup.
    activationEvents: ["*"],
    contributes: {
      // registerCommand alone makes a command exist — a keybinding can run it
      // without any declaration here. Declaring it is what lists it in the
      // command palette, so only the one deliberate action is declared:
      // confirmQuit (the ctrl+c reflex) and quitHint (the redirect toast) are
      // keybinding targets, and a palette full of quit flavours reads as noise
      commands: [{ command: "tode.quit", title: "Quit", category: "terminal-code" }],
      keybindings: [quitBinding, ...hintBinding],
    },
  };
}

/** The chord the hint promises has to be the chord that actually quits, and
 * the shortcut wizard's decisions are the source of truth. Two can exist for
 * ctrl+q — the terminal held it, or an imported keybinding did — and the
 * import one speaks for the editor's own file, so it wins. Freed or undecided
 * means ctrl+q itself, moved means the chord it moved to, and surrendered
 * means there is no chord, so the hint says what to do instead. Read at
 * install time; a new decision lands on the next open, the same way the
 * wizard's keybindings do. */
export function quitHintMessage(): string {
  const choices = loadDecisions()?.choices ?? {};
  const decision = choices[IMPORT_DECISION_ID] ?? choices[QUIT_CHORD];
  if (decision?.choice === "editor" && decision.key) return `Press ${decision.key} to quit terminal-code`;
  if (decision?.choice === "keep") {
    return `${QUIT_CHORD} is taken — quit terminal-code from the command palette, or run: tode shortcut-setup`;
  }
  return `Press ${QUIT_CHORD} to quit terminal-code`;
}

function extensionSource(
  tode: string[],
  liveThemeFile: string,
  quitHint: string,
  startupViewFile: string,
): string {
  return `const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const TODE = ${JSON.stringify(tode)};
const LIVE_THEME_FILE = ${JSON.stringify(liveThemeFile)};
const QUIT_HINT = ${JSON.stringify(quitHint)};
const STARTUP_VIEW_FILE = ${JSON.stringify(startupViewFile)};

/** The views tode knows how to ask for; "scm" is the git panel. */
const VIEW_COMMANDS = { scm: "workbench.view.scm" };

function focusView(view) {
  const command = VIEW_COMMANDS[view];
  if (command) vscode.commands.executeCommand(command);
}

/** The marker is one-shot and short-lived: a crashed launch must not redirect
 * an open that happens minutes later. */
function applyStartupView() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STARTUP_VIEW_FILE, "utf8"));
  } catch (error) {
    return;
  }
  try {
    fs.rmSync(STARTUP_VIEW_FILE, { force: true });
  } catch (error) {}
  if (!parsed || Date.now() - (parsed.at || 0) > 120000) return;
  focusView(parsed.view);
}
const NL = String.fromCharCode(10);

function quitTode() {
  spawn(TODE[0], TODE.slice(1).concat("quit"), { detached: true, stdio: "ignore" }).unref();
}

/** Vim's own rule: closing the last window quits the editor. vscodevim maps
 * :q onto closing the active editor, so the reliable signal for that rule is
 * the tab count reaching zero — no parsing of ex commands, which vscodevim
 * does not expose anyway. It only arms once tabs have existed and only when a
 * vim extension is installed, because plain vscode leaves an empty window
 * open on purpose. */
function watchVimQuit() {
  const vim =
    vscode.extensions.getExtension("vscodevim.vim") ||
    vscode.extensions.getExtension("asvetliakov.vscode-neovim");
  if (!vim) return null;
  let sawTabs = false;
  return vscode.window.tabGroups.onDidChangeTabs(function () {
    let open = 0;
    for (const group of vscode.window.tabGroups.all) open += group.tabs.length;
    if (open > 0) {
      sawTabs = true;
      return;
    }
    if (sawTabs) quitTode();
  });
}

/** The live file is a whole vscode theme document; its colors and tokenColors
 * are projected into settings here. The contributed theme is correct on the
 * next full window load, but a theme change should not need one — this is what
 * makes it live. settings applied through the configuration api reflect
 * instantly, unlike a plain edit of settings.json on disk, which vscode does
 * not react to on its own. tode writes the theme here on every open too, so a
 * fresh window has full fidelity immediately rather than waiting on the next
 * change to arrive. */
function applyThemeDocument(theme) {
  if (!theme || typeof theme !== "object") return;
  const cfg = vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Global;
  if (theme.colors) {
    cfg.update("workbench.colorCustomizations", theme.colors, target);
  }
  if (theme.tokenColors) {
    cfg.update("editor.tokenColorCustomizations", { textMateRules: theme.tokenColors }, target);
  }
}

function applyLiveTheme() {
  let theme;
  try {
    theme = JSON.parse(fs.readFileSync(LIVE_THEME_FILE, "utf8"));
  } catch (error) {
    return;
  }
  applyThemeDocument(theme);
}

/** A theme that arrived over the socket is also put where a reloading window
 * will look for it, so the state at rest keeps up with the events. Rename,
 * for the same watcher reasons as every other writer of this file. */
function persistLiveTheme(theme) {
  try {
    fs.mkdirSync(path.dirname(LIVE_THEME_FILE), { recursive: true });
    fs.writeFileSync(LIVE_THEME_FILE + ".tmp", JSON.stringify(theme) + NL);
    fs.renameSync(LIVE_THEME_FILE + ".tmp", LIVE_THEME_FILE);
  } catch (error) {}
}

/** The writer replaces the file with an atomic rename, which on some
 * platforms stops a watch on the file's own path from firing again once the
 * rename swaps the inode out from under it, so the directory is watched and
 * filtered by name instead. */
function watchLiveTheme() {
  applyLiveTheme();
  const dir = path.dirname(LIVE_THEME_FILE);
  const name = path.basename(LIVE_THEME_FILE);
  let timer = null;
  let watcher = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, { persistent: false }, function (_event, filename) {
      if (filename && filename !== name) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(applyLiveTheme, 30);
    });
  } catch (error) {}
  return function () {
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
  };
}

/** Running tode from inside tode should change this window rather than open
 * another one, which is what the socket is for: the cli finds it through an
 * environment variable set on every terminal this window opens. */
function socketPath() {
  const stateHome =
    process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  const dir = path.join(stateHome, "tode", "ipc");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "w" + process.pid + "-" + Date.now() + ".sock");
}

/** Workspace roots in code-server are vscode-remote uris. Handing vscode a
 * file:// one for the same path is quietly ignored, or worse leaves the window
 * with no folder at all, so the scheme is taken from the window itself. */
function workspaceUri(target) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.with({ path: target });
  if (vscode.env.remoteAuthority) {
    return vscode.Uri.from({ scheme: "vscode-remote", authority: vscode.env.remoteAuthority, path: target });
  }
  return vscode.Uri.file(target);
}

function sameUri(a, b) {
  return a.toString() === b.toString();
}

function alreadyOpen(uri) {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.some(function (folder) {
    return sameUri(folder.uri, uri);
  });
}

/** Opening a folder reloads the window, which tears down this socket. The
 * caller is answered first, because after the reload there is nobody left to
 * answer it, and it would sit there until it gave up. */
async function open(request, acknowledge) {
  if (request.theme) {
    applyThemeDocument(request.theme);
    persistLiveTheme(request.theme);
    return;
  }
  if (request.view) focusView(request.view);
  if (request.diff && request.diff.length === 2) {
    const left = vscode.Uri.file(request.diff[0]);
    const right = vscode.Uri.file(request.diff[1]);
    await vscode.commands.executeCommand("vscode.diff", left, right);
  }
  const opened = [];
  for (const file of request.files || []) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    opened.push(document.uri.toString());
    if (file.line) {
      const line = Math.max(0, file.line - 1);
      const column = Math.max(0, (file.column || 1) - 1);
      const at = new vscode.Position(line, column);
      editor.selection = new vscode.Selection(at, at);
      editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
    }
  }

  const wanted = (request.folders || [])
    .map(workspaceUri)
    .filter(function (uri) {
      // asking for the folder that is already open should do nothing at all,
      // rather than reload the window to arrive back where it started
      return !alreadyOpen(uri);
    });

  if (wanted.length === 0) {
    if (request.wait && opened.length > 0) await untilClosed(opened);
    acknowledge();
    return;
  }

  acknowledge();
  for (const uri of wanted) {
    if (request.add) {
      const at = (vscode.workspace.workspaceFolders || []).length;
      vscode.workspace.updateWorkspaceFolders(at, 0, { uri: uri });
    } else {
      await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
    }
  }
}

/** What --wait is for: a commit message editor has to block until the file is
 * shut, or git carries on with an empty message.
 *
 * Tabs are what to watch, not documents. Closing a tab leaves the document
 * loaded for a while, so onDidCloseTextDocument can be a long time coming. */
function untilClosed(uris) {
  const waiting = uris.slice();
  const anyStillOpen = function () {
    const open = {};
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input && input.uri) open[input.uri.toString()] = true;
        if (input && input.modified) open[input.modified.toString()] = true;
      }
    }
    return waiting.some(function (uri) {
      return open[uri];
    });
  };
  if (!anyStillOpen()) return Promise.resolve();
  return new Promise(function (resolve) {
    const subscription = vscode.window.tabGroups.onDidChangeTabs(function () {
      if (anyStillOpen()) return;
      subscription.dispose();
      resolve();
    });
  });
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("tode.quit", quitTode));

  /** The quit chord asks first. The thenable settles when the dialog closes;
   * the flag keeps a held-down chord from stacking dialogs. */
  let confirmShowing = false;
  context.subscriptions.push(
    vscode.commands.registerCommand("tode.confirmQuit", function () {
      if (confirmShowing) return;
      confirmShowing = true;
      vscode.window.showErrorMessage("Do you want to quit terminal-code?", { modal: true }, "Quit").then(
        function (picked) {
          confirmShowing = false;
          if (picked === "Quit") quitTode();
        },
        function () {
          confirmShowing = false;
        },
      );
    }),
  );

  /** Modal on purpose: the corner toast was invisible to the person who just
   * tried to quit. The thenable settles when the dialog closes, and holding
   * the flag until then keeps a held-down ctrl+c from stacking dialogs. */
  let hintShowing = false;
  context.subscriptions.push(
    vscode.commands.registerCommand("tode.quitHint", function () {
      if (hintShowing) return;
      hintShowing = true;
      const done = function () {
        hintShowing = false;
      };
      vscode.window.showErrorMessage(QUIT_HINT, { modal: true }).then(done, done);
    }),
  );

  const vimWatch = watchVimQuit();
  if (vimWatch) context.subscriptions.push(vimWatch);

  applyStartupView();

  const stopWatchingSettings = watchLiveTheme();
  context.subscriptions.push({ dispose: stopWatchingSettings });

  const sock = socketPath();
  const server = net.createServer(function (connection) {
    let buffer = "";
    connection.on("data", function (chunk) {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf(NL);
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        connection.end(JSON.stringify({ ok: false, error: "bad request" }) + NL);
        return;
      }
      let answered = false;
      const acknowledge = function () {
        if (answered) return;
        answered = true;
        connection.end(JSON.stringify({ ok: true }) + NL);
      };
      Promise.resolve(open(request, acknowledge)).then(acknowledge, function (error) {
        if (answered) return;
        answered = true;
        connection.end(JSON.stringify({ ok: false, error: String(error) }) + NL);
      });
    });
    connection.on("error", function () {});
  });
  server.on("error", function () {});
  server.listen(sock, function () {
    context.environmentVariableCollection.replace("TODE_IPC", sock);
  });
  context.subscriptions.push({
    dispose: function () {
      try {
        server.close();
      } catch (error) {}
      try {
        fs.rmSync(sock, { force: true });
      } catch (error) {}
    },
  });
}

exports.activate = activate;
exports.deactivate = function () {};
`;
}

function writeIfChanged(file: string, contents: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return true;
}

export function installBridge(tode: string[]): boolean {
  const wroteManifest = writeIfChanged(
    path.join(BRIDGE_DIR, "package.json"),
    `${JSON.stringify(manifest(), null, 2)}\n`,
  );
  const wroteSource = writeIfChanged(
    path.join(BRIDGE_DIR, "extension.js"),
    extensionSource(tode, LIVE_THEME_FILE, quitHintMessage(), STARTUP_VIEW_FILE),
  );
  registerBridge();
  return wroteManifest || wroteSource;
}

interface ExtensionEntry {
  identifier: { id: string };
  version: string;
  relativeLocation?: string;
  location?: { path?: string; scheme?: string; $mid?: number };
  metadata?: Record<string, unknown>;
}

/** Same reason the theme needs listing: once an extensions.json exists, vscode
 * stops looking at the folder. */
export function registerBridge(): void {
  const file = path.join(EXTENSIONS_DIR, "extensions.json");
  let listed: ExtensionEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) listed = parsed;
  } catch {
    return;
  }
  const entry: ExtensionEntry = {
    identifier: { id: BRIDGE_ID },
    version: BRIDGE_VERSION,
    relativeLocation: path.basename(BRIDGE_DIR),
    location: { $mid: 1, path: BRIDGE_DIR, scheme: "file" },
    metadata: { isApplicationScoped: false, isMachineScoped: false, installedTimestamp: 0 },
  };
  const without = listed.filter((item) => item.identifier?.id !== BRIDGE_ID);
  fs.writeFileSync(file, `${JSON.stringify([...without, entry], null, 2)}\n`);
}

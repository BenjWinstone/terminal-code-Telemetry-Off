import fs from "node:fs";
import path from "node:path";

import { EXTENSIONS_DIR, LIVE_SETTINGS_FILE } from "./profile";

const BRIDGE_ID = "tode.tode-bridge";
const BRIDGE_VERSION = "1.0.0";
export const BRIDGE_DIR = path.join(EXTENSIONS_DIR, `${BRIDGE_ID}-${BRIDGE_VERSION}`);

/** ctrl+c has to quit, except in the integrated terminal where it belongs to
 * whatever is running there. Only vscode knows where the focus is, so the
 * decision lives in an extension rather than in the browser. */
function manifest(): unknown {
  return {
    name: "tode-bridge",
    displayName: "tode",
    publisher: "tode",
    version: BRIDGE_VERSION,
    engines: { vscode: "^1.80.0" },
    main: "./extension.js",
    activationEvents: ["onStartupFinished"],
    contributes: {
      commands: [{ command: "tode.quit", title: "Quit", category: "tode" }],
      keybindings: [
        {
          command: "tode.quit",
          key: "ctrl+c",
          when: "!terminalFocus",
        },
      ],
    },
  };
}

function extensionSource(tode: string[], liveSettingsFile: string): string {
  return `const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const TODE = ${JSON.stringify(tode)};
const LIVE_SETTINGS_FILE = ${JSON.stringify(liveSettingsFile)};
const NL = String.fromCharCode(10);

/** The contributed theme is correct on the next full window load, but a
 * terminal theme change should not need one — this is what makes it live.
 * settings applied through the configuration api reflect instantly, unlike a
 * plain edit of settings.json on disk, which vscode does not react to on its
 * own. tode writes the same colours here on every open too, so a fresh window
 * has full fidelity immediately rather than waiting on the next terminal
 * colour change to arrive. */
function applyLiveSettings() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LIVE_SETTINGS_FILE, "utf8"));
  } catch (error) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Global;
  if (parsed["workbench.colorCustomizations"]) {
    cfg.update("workbench.colorCustomizations", parsed["workbench.colorCustomizations"], target);
  }
  if (parsed["editor.tokenColorCustomizations"]) {
    cfg.update("editor.tokenColorCustomizations", parsed["editor.tokenColorCustomizations"], target);
  }
}

/** The writer replaces the file with an atomic rename, which on some
 * platforms stops a watch on the file's own path from firing again once the
 * rename swaps the inode out from under it, so the directory is watched and
 * filtered by name instead. */
function watchLiveSettings() {
  applyLiveSettings();
  const dir = path.dirname(LIVE_SETTINGS_FILE);
  const name = path.basename(LIVE_SETTINGS_FILE);
  let timer = null;
  let watcher = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, { persistent: false }, function (_event, filename) {
      if (filename && filename !== name) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(applyLiveSettings, 30);
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
  const dir = path.join(os.homedir(), ".local", "state", "tode", "ipc");
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
  context.subscriptions.push(
    vscode.commands.registerCommand("tode.quit", () => {
      spawn(TODE[0], TODE.slice(1).concat("quit"), { detached: true, stdio: "ignore" }).unref();
    }),
  );

  const stopWatchingSettings = watchLiveSettings();
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
    extensionSource(tode, LIVE_SETTINGS_FILE),
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

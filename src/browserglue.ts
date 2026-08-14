import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DATA_DIR } from "./runtime/paths";

/** The directory where every tode window's bridge listens on its own socket —
 * the same computation the bridge makes, done here because these scripts run
 * inside terminal-browser's process, whose XDG variables point at the
 * browser's own homes rather than the user's. */
export function ipcSocketDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "tode", "ipc");
}

/** Runs in every page's preload context. terminal-browser has already put its
 * api on globalThis; all tode's preload does is turn theme events into
 * messages for the main script. */
export function browserPreloadSource(): string {
  return `terminalBrowser.onTheme(function (theme) {
  terminalBrowser.send({ type: "theme", colors: theme });
});
`;
}

/** Runs in terminal-browser's main process. Paths are baked in at generation
 * time for the same env reason as ipcSocketDir, and tode's own compiled
 * modules are required directly — the theme generator is pure, so it does not
 * care whose process it runs in. */
export function browserMainSource(distDir: string, socketDir: string): string {
  return `const fs = require("fs");
const path = require("path");
const { parseRawColors } = require(${JSON.stringify(path.join(distDir, "livesync.js"))});
const { generateTheme } = require(${JSON.stringify(path.join(distDir, "theme", "generate.js"))});
const { sendToWindow } = require(${JSON.stringify(path.join(distDir, "ipc.js"))});
const IPC_DIR = ${JSON.stringify(socketDir)};

module.exports = function (api) {
  api.onMessage(function (message) {
    if (!message || message.type !== "theme" || !message.colors) return;
    const palette = parseRawColors(JSON.stringify(message.colors));
    if (!palette) return;
    const theme = generateTheme(palette);
    let names = [];
    try {
      names = fs.readdirSync(IPC_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".sock")) continue;
      const socket = path.join(IPC_DIR, name);
      sendToWindow(socket, { files: [], folders: [], add: false, theme }).catch(function (error) {
        // a crashed window leaves its socket behind; refused or gone is the
        // one signal it is dead, a slow window is not
        if (error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
          try {
            fs.rmSync(socket, { force: true });
          } catch {}
        }
      });
    }
  });
};
`;
}

/** Both scripts land next to the other generated artefacts and are rewritten
 * on every launch, so they can never drift from the dist they require. */
export function writeBrowserScripts(): { preload: string; mainScript: string } {
  const preload = path.join(DATA_DIR, "browser-preload.js");
  const mainScript = path.join(DATA_DIR, "browser-main.js");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(preload, browserPreloadSource());
  fs.writeFileSync(mainScript, browserMainSource(__dirname, ipcSocketDir()));
  return { preload, mainScript };
}

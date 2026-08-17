import type { MainCtx, ThemeMessage, TimingMessage } from "./ctx";

/** Runs in terminal-browser's main process. The pinned build requires the
 * --main-script module for its side effects and calls it with nothing, so
 * browserglue applies this function at the module's top level. It hears the
 * preloads over tode's own electron ipc channel — the counterpart of the
 * deliver() in preload.ts.
 *
 * The same closure-free rule as the preload applies (see preload.ts) — except
 * require, which the browser process has for real. tode's own modules arrive
 * as absolute paths in ctx and the `typeof import` casts erase, so the calls
 * stay fully typed without capturing anything from module scope. */
export function browserMain(ctx: MainCtx): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const { parseRawColors } = require(ctx.modules.livesync) as typeof import("../livesync");
  const { generateTheme } = require(ctx.modules.generate) as typeof import("../theme/generate");
  const { sendToWindow } = require(ctx.modules.ipc) as typeof import("../ipc");
  const { ipcMain } = require("electron") as {
    ipcMain: { on(channel: string, listener: (event: unknown, message: unknown) => void): void };
  };

  ipcMain.on("tode:message", (_event, message) => {
    const timed = message as TimingMessage | null | undefined;
    if (timed && timed.type === "timing" && timed.page) {
      try {
        fs.writeFileSync(ctx.timingFile, JSON.stringify(timed.page));
      } catch {}
      return;
    }
    const themed = message as ThemeMessage | null | undefined;
    if (!themed || themed.type !== "theme" || !themed.colors) return;
    const palette = parseRawColors(JSON.stringify(themed.colors));
    if (!palette) return;
    const theme = generateTheme(palette) as unknown as Record<string, unknown>;
    let names: string[];
    try {
      names = fs.readdirSync(ctx.socketDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".sock")) continue;
      const socket = path.join(ctx.socketDir, name);
      sendToWindow(socket, { files: [], folders: [], add: false, theme }).catch(
        (error: NodeJS.ErrnoException) => {
          // a crashed window leaves its socket behind; refused or gone is the
          // one signal it is dead, a slow window is not
          if (error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
            try {
              fs.rmSync(socket, { force: true });
            } catch {}
          }
        },
      );
    }
  });
}

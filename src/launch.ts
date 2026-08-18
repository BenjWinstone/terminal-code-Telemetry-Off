import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";

import { writeBrowserScripts } from "./browserglue";
import { CSS_FILE } from "./codeserver/server";
import { supportedFlags } from "./runtime/release";
import type { Runtime } from "./runtime/release";
import type { TerminalPalette } from "./terminal/osc";

export interface LaunchOptions {
  split?: string;
  size?: string;
  stages?: [string, number][];
}

function browserArgv(runtime: Runtime, url: string, options: LaunchOptions): string[] {
  const flags = supportedFlags(runtime);
  // --chromeless was the pre-app-mode spelling, kept for override binaries
  const argv = [url, flags.has("--app-mode") ? "--app-mode" : "--chromeless"];
  // the browser's own chords (its find bar on cmd+shift+f, new tab on cmd+t,
  // url bar on cmd+l) would eat chords the editor binds — the whole point of
  // the shortcut wizard is that the editor gets what the terminal frees
  if (flags.has("--no-shortcuts")) argv.push("--no-shortcuts");
  // with no tab strip, a target=_blank or a sign-in window.open would land in
  // a tab the user can never see or reach; as a popup stack it stays on the
  // pane, over the editor
  if (flags.has("--open-tabs-in-popup-stack")) argv.push("--open-tabs-in-popup-stack");
  // lets a genuine terminal theme change reach every open window without a
  // reload: the preload hears it, the main script turns it into a theme and
  // tells each window's bridge over its socket
  if (flags.has("--preload") && flags.has("--main-script")) {
    const scripts = writeBrowserScripts();
    argv.push(`--preload=${scripts.preload}`, `--main-script=${scripts.mainScript}`);
  }
  if (options.split) argv.push("--split", options.split);
  if (options.size) argv.push("--size", options.size);
  return argv;
}

/** One browser child that outlives several local pages. The first screen
 * spawns it — with the full editor flag set, so it is already the editor's
 * browser — and every later screen arrives as a navigation the page performs
 * itself. The pane never respawns, so the terminal never drops back to its
 * primary buffer between screens. */
export class Pane {
  private child: ChildProcess | null = null;
  private exit: Promise<number> | null = null;

  constructor(
    private readonly runtime: Runtime,
    private readonly options: LaunchOptions = {},
  ) {}

  owned(): boolean {
    return this.child !== null;
  }

  open(url: string): void {
    if (this.child) return;
    try {
      fs.writeFileSync(
        `${CSS_FILE}.launch.json`,
        JSON.stringify({ spawnedAt: Date.now(), stages: this.options.stages ?? [] }),
      );
    } catch {}
    const child = spawn(this.runtime.bin, ["open", ...browserArgv(this.runtime, url, this.options)], {
      stdio: "inherit",
    });
    this.child = child;
    this.exit = new Promise<number>((resolve) => {
      child.on("error", (error) => {
        process.stderr.write(`could not start terminal-browser: ${error.message}\n`);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 0));
    });
  }

  /** Resolves when the pane's browser exits; pends forever before open(). */
  exited(): Promise<number> {
    return this.exit ?? new Promise<number>(() => {});
  }
}

export function launchBrowser(
  runtime: Runtime,
  url: string,
  _palette: TerminalPalette,
  options: LaunchOptions = {},
): Promise<number> {
  const pane = new Pane(runtime, options);
  pane.open(url);
  return pane.exited();
}

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
  const argv = [url, "--app-mode"]
  const scripts = writeBrowserScripts();
  argv.push(`--preload=${scripts.preload}`, `--main-script=${scripts.mainScript}`);
  if (options.split) argv.push("--split", options.split);
  if (options.size) argv.push("--size", options.size);
  return argv;
}

export class Pane {
  private child: ChildProcess | null = null;
  private exit: Promise<number> | null = null;

  constructor(
    private readonly runtime: Runtime,
    private readonly options: LaunchOptions = {},
  ) { }

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
    } catch { }
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

  exited(): Promise<number> {
    return this.exit ?? new Promise<number>(() => { });
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

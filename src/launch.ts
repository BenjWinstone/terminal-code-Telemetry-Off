import { spawn } from "node:child_process";
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

/** Opens the workbench url in terminal-browser and stays until that pane
 * closes, feeding live terminal colour changes back into the profile. */
export function launchBrowser(
  runtime: Runtime,
  url: string,
  palette: TerminalPalette,
  options: LaunchOptions = {},
): Promise<number> {
  const flags = supportedFlags(runtime);
  // --chromeless was the pre-app-mode spelling, kept for override binaries
  const argv = [url, flags.has("--app-mode") ? "--app-mode" : "--chromeless"];
  // the browser's own chords (its find bar on cmd+shift+f, new tab on cmd+t,
  // url bar on cmd+l) would eat chords the editor binds — the whole point of
  // the shortcut wizard is that the editor gets what the terminal frees
  if (flags.has("--no-shortcuts")) argv.push("--no-shortcuts");
  // newer than the pinned release; harmless to leave off until that lands
  if (flags.has("--mirror-ctrl-digits")) argv.push("--mirror-ctrl-digits");
  // a sign in flow would otherwise navigate the pane onto github and strand it
  // there, with no toolbar to come back with
  if (flags.has("--external-links")) argv.push("--external-links");
  // lets a genuine terminal theme change reach every open window without a
  // reload: the preload hears it, the main script turns it into a theme and
  // tells each window's bridge over its socket
  if (flags.has("--preload") && flags.has("--main-script")) {
    const scripts = writeBrowserScripts();
    argv.push(`--preload=${scripts.preload}`, `--main-script=${scripts.mainScript}`);
  }
  if (options.split) argv.push("--split", options.split);
  if (options.size) argv.push("--size", options.size);

  try {
    fs.writeFileSync(
      `${CSS_FILE}.launch.json`,
      JSON.stringify({ spawnedAt: Date.now(), stages: options.stages ?? [] }),
    );
  } catch {}
  const child = spawn(runtime.bin, ["open", ...argv], { stdio: "inherit" });

  return new Promise<number>((resolve, reject) => {
    child.on("error", (error) => {
      reject(new Error(`could not start terminal-browser: ${error.message}`));
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

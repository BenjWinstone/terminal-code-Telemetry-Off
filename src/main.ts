#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CSS_FILE,
  codeServerBin,
  currentServer,
  ensureServer,
  origin,
  stopServer,
} from "./codeserver/server";
import { installBridge } from "./bridge";
import { doctorCommand } from "./doctor";
import { importCommand } from "./import/command";
import { parseGoto, runningWindow, sendToWindow } from "./ipc";
import type { OpenFile } from "./ipc";
import { EXTENSIONS_DIR, VSCODE_DIR, registerThemeExtension } from "./profile";
import {
  LIVE_COLORS_FILE,
  cachePalette,
  ensureFont,
  installCss,
  installKeybindings,
  installLiveSettings,
  installSettings,
  installTheme,
  readPalette,
} from "./profile";
import { watchLiveColors } from "./livesync";
import { PINNED_VERSION, resolveRuntime, supportedFlags } from "./runtime/release";
import { BROWSER_HOME } from "./runtime/paths";
import { resolveTarget, workbenchUrl } from "./target";
import { upgrade } from "./upgrade";
import { hex } from "./theme/color";
import { semanticColors } from "./theme/generate";

/** What the bridge extension should run to reach tode again. The shim is
 * preferred because it rebuilds a stale dev tree before running. */
function todeCommand(): string[] {
  const shim = path.join(os.homedir(), ".local", "bin", "tode");
  if (fs.existsSync(shim)) return [shim];
  return [process.execPath, process.argv[1]];
}

function fail(message: string): never {
  process.stderr.write(`tode: ${message}\n`);
  process.exit(1);
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function takeAll(args: string[], ...names: string[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length; ) {
    if (!names.includes(args[at])) {
      at += 1;
      continue;
    }
    const value = args[at + 1];
    if (value === undefined) fail(`${args[at]} needs a value`);
    found.push(value);
    args.splice(at, 2);
  }
  return found;
}

function takeBool(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const HELP = `Usage: tode [path...] [options]
       tode <command>

  tode                  Open the current folder
  tode <folder>         Open that folder
  tode <file>           Open just that file, without its folder

Run from a terminal inside tode, a file opens in that window and a folder
opens its own pane. Pass -r to open the folder in the window you are in.

Options:
  -g, --goto <f:l:c>    Open a file at a line and column
  -a, --add <folder>    Add a folder to the window rather than replacing it
  -n, --new-window      Open a new pane even for a file
  -w, --wait            Wait until the file is closed again
  -d, --diff <a> <b>    Compare two files
  -r, --reuse-window    Open the folder in this window rather than a new pane
  --install-extension   Install an extension by id or vsix path
  --uninstall-extension Remove an extension
  --list-extensions     List what is installed, with --show-versions
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     How much of the space the split takes (0.2 to 0.95)
  --timing              Report how long each stage took

Commands:
  timing                Where the last page load spent its time
  quit                  Close the tode panes, leaving code-server warm
  import [editor]       Bring settings, keybindings, snippets and extensions
                        over from vscode or a fork of it
  theme                 Show the colours this terminal reports, and rebuild
  runtime               Which terminal-browser build is in use, and why
  daemon status|stop    The code-server that stays warm between opens
  upgrade [--check]     Install the newest build on this channel
  shutdown              Stop everything tode is running
`;

async function progressRuntime() {
  let announced = false;
  return resolveRuntime({
    onProgress: (stage, fraction) => {
      if (stage === "downloading") {
        if (!announced) {
          process.stderr.write(`tode: fetching terminal-browser ${PINNED_VERSION}\n`);
          announced = true;
        }
        const percent = Math.round(fraction * 100);
        process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
      }
      if (stage === "cloning" && !announced) {
        process.stderr.write(`tode: reusing the terminal-browser ${PINNED_VERSION} already installed\n`);
        announced = true;
      }
    },
  });
}

/** Flags code understands that tode has no use for. Swallowing them means a
 * habit, an alias or a script carries over without an error. */
const IGNORED: string[] = [
  "--verbose",
  "--disable-gpu",
  "--disable-telemetry",
  "--disable-updates",
  "--no-sandbox",
  "--skip-release-notes",
  "--skip-welcome",
  "--disable-workspace-trust",
];

/** The same, but they take a value which has to be dropped alongside them. */
const IGNORED_WITH_VALUE: string[] = [
  "--log",
  "--locale",
  "--sync",
  "--profile",
  "--user-data-dir",
  "--extensions-dir",
];

/** Accepted, but they would change what you get, so saying nothing would be
 * worse than saying tode cannot do it. */
const UNSUPPORTED: [string, string][] = [
  ["--disable-extensions", "extensions are per code-server, not per window"],
  ["--disable-extension", "extensions are per code-server, not per window"],
];

function dropIgnored(args: string[]): void {
  for (const flag of IGNORED_WITH_VALUE) takeAll(args, flag);
  for (const flag of IGNORED) takeBool(args, flag);
  for (const [flag, why] of UNSUPPORTED) {
    const had = takeBool(args, flag) || takeAll(args, flag).length > 0;
    if (had) process.stderr.write(`tode: ignoring ${flag}, ${why}\n`);
  }
}

async function openCommand(args: string[]): Promise<number> {
  dropIgnored(args);
  const gotos = takeAll(args, "-g", "--goto").map(parseGoto);
  const added = takeAll(args, "-a", "--add");
  const extensions = takeAll(args, "--install-extension");
  const removals = takeAll(args, "--uninstall-extension");
  if (extensions.length > 0 || removals.length > 0) return manageExtensions(extensions, removals);
  if (takeBool(args, "--list-extensions")) {
    return listExtensions(takeBool(args, "--show-versions"));
  }
  const newWindow = takeBool(args, "-n") || takeBool(args, "--new-window");
  const reuse = takeBool(args, "-r") || takeBool(args, "--reuse-window");
  const wait = takeBool(args, "-w") || takeBool(args, "--wait");
  const diff = takeAll(args, "-d", "--diff");
  const split = takeFlag(args, "--split");
  const size = takeFlag(args, "--size");
  const timing = takeBool(args, "--timing");
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) fail(`unknown option ${unknown}`);
  if (size !== undefined && !split) fail("--size only applies with --split");

  const wanted = [...args, ...added].map((argument) => resolveTarget(argument, process.cwd()));
  const files: OpenFile[] = [
    ...wanted.filter((t) => t.file).map((t) => ({ path: t.file! })),
    ...gotos.map((goto) => ({ ...goto, path: path.resolve(process.cwd(), goto.path) })),
  ];
  const folders = [
    ...wanted.filter((t) => t.folder).map((t) => t.folder!),
    ...added.map((folder) => path.resolve(process.cwd(), folder)),
  ].filter((folder, at, all) => all.indexOf(folder) === at);

  const pair = diff.length === 2 ? diff.map((f) => path.resolve(process.cwd(), f)) : [];
  if (diff.length !== 0 && diff.length !== 2) fail("--diff takes two files");

  // Run from a tode terminal, tode behaves like tode: a folder opens its own
  // pane. Opening it here would reload the window and take the terminal you
  // typed in with it, so that only happens when asked for by name.
  const here = added.length > 0 || reuse;
  const window = newWindow ? null : runningWindow();
  const sendFolders = here ? folders : [];
  const opensAPane = folders.length > 0 && !here;

  if (window && !opensAPane && (files.length > 0 || sendFolders.length > 0 || pair.length > 0)) {
    await sendToWindow(
      window,
      { files, folders: sendFolders, add: added.length > 0, wait, diff: pair },
      wait ? 0 : 4000,
    ).catch((error) => fail(`could not reach the tode window: ${error.message}`));
    return 0;
  }

  const mark = Date.now();
  const stages: [string, number][] = [];
  const done = (label: string) => stages.push([label, Date.now() - mark]);

  const target = wanted[0] ?? resolveTarget(undefined, process.cwd());
  const runtime = await progressRuntime();
  done("runtime");
  // the terminal is asked for its colours here, while tode still owns the tty
  const { palette } = await readPalette();
  ensureFont();
  installTheme(palette);
  installBridge(todeCommand());
  installCss(palette);
  installSettings();
  installKeybindings();
  installLiveSettings(palette);
  done("profile");
  const server = await ensureServer();
  done("code-server");

  const url = workbenchUrl(origin(server), target);
  const flags = supportedFlags(runtime);
  const argv = [url, "--chromeless"];
  // newer than the pinned release; harmless to leave off until that lands
  if (flags.has("--mirror-ctrl-digits")) argv.push("--mirror-ctrl-digits");
  // a sign in flow would otherwise navigate the pane onto github and strand it
  // there, with no toolbar to come back with
  if (flags.has("--external-links")) argv.push("--external-links");
  // lets a genuine terminal theme change reach this window without a reload,
  // once terminal-browser knows how to report one
  if (flags.has("--colors-file")) argv.push(`--colors-file=${LIVE_COLORS_FILE}`);
  if (split) argv.push("--split", split);
  if (size) argv.push("--size", size);

  if (timing) {
    for (const [label, ms] of stages) process.stderr.write(`  ${label.padEnd(12)} ${ms}ms\n`);
  }

  try {
    fs.writeFileSync(`${CSS_FILE}.launch.json`, JSON.stringify({ spawnedAt: Date.now(), stages }));
  } catch {}
  const child = spawn(runtime.bin, ["open", ...argv], { stdio: "inherit" });

  const stopWatching = flags.has("--colors-file")
    ? watchLiveColors(LIVE_COLORS_FILE, palette, (live) => {
        installTheme(live);
        installCss(live);
        installLiveSettings(live);
        cachePalette(live);
      })
    : () => {};

  return new Promise<number>((resolve) => {
    child.on("error", (error) => fail(`could not start terminal-browser: ${error.message}`));
    child.on("exit", (code) => {
      stopWatching();
      resolve(code ?? 0);
    });
  });
}

/** Extensions go into tode's own profile, not whichever code-server the machine
 * happens to have configured. */
function extensionCommand(args: string[], quiet = false): number {
  const result = spawnSync(
    codeServerBin(),
    [...args, "--extensions-dir", EXTENSIONS_DIR, "--user-data-dir", path.join(VSCODE_DIR, "user-data")],
    { stdio: quiet ? ["ignore", "inherit", "ignore"] : "inherit" },
  );
  return result.status ?? 1;
}

function listExtensions(withVersions: boolean): number {
  return extensionCommand(withVersions ? ["--list-extensions", "--show-versions"] : ["--list-extensions"], true);
}

function manageExtensions(install: string[], remove: string[]): number {
  for (const id of remove) {
    const code = extensionCommand(["--uninstall-extension", id]);
    if (code !== 0) return code;
  }
  for (const id of install) {
    const code = extensionCommand(["--install-extension", id]);
    if (code !== 0) return code;
  }
  registerThemeExtension();
  if (install.length > 0) process.stdout.write("open tode again to pick it up\n");
  return 0;
}

function swatch(color: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  return `\x1b[48;2;${r};${g};${b}m   \x1b[0m`;
}

async function themeCommand(): Promise<number> {
  const { palette, source } = await readPalette();
  const where = {
    terminal: "read from this terminal",
    cache: "from the cache, this terminal did not answer",
    default: "built in default, no terminal answered and nothing cached",
  }[source];
  const accent = semanticColors(palette);
  const line = (label: string, color: string) => `  ${swatch(color)} ${color}  ${label}\n`;
  process.stdout.write(`palette ${where}\n`);
  process.stdout.write(line("background", hex(palette.background)));
  process.stdout.write(line("foreground", hex(palette.foreground)));
  process.stdout.write(`  ${palette.ansi.map((c) => swatch(hex(c))).join("")}  ansi 0-15\n`);
  for (const [name, color] of Object.entries(accent)) process.stdout.write(line(name, hex(color)));
  const { changed, fingerprint } = installTheme(palette);
  installBridge(todeCommand());
  installCss(palette);
  installSettings();
  installKeybindings();
  process.stdout.write(
    `\ntheme ${fingerprint} ${changed ? "written" : "already current"}\nfont ${ensureFont()}\n`,
  );
  return 0;
}

async function runtimeCommand(): Promise<number> {
  const runtime = await progressRuntime();
  const why = {
    override: "TODE_TERMINAL_BROWSER_BIN points at it",
    vendored: "shipped inside this install",
    pinned: "already fetched for this pin",
    cloned: "cloned from the install already on this machine",
    downloaded: "downloaded for this pin",
  }[runtime.source];
  process.stdout.write(
    `terminal-browser ${runtime.version}  (${why})\n` +
      `  bin      ${runtime.bin}\n` +
      `  data     ${BROWSER_HOME.data}\n` +
      `  runtime  ${BROWSER_HOME.runtime}\n` +
      `  chromium ${BROWSER_HOME.appData}\n`,
  );
  return 0;
}

async function daemonCommand(action: string | undefined): Promise<number> {
  if (action === "stop") {
    process.stdout.write(stopServer() ? "code-server stopped\n" : "code-server was not running\n");
    return 0;
  }
  if (action && action !== "status") fail(`unknown daemon action ${action}`);
  const state = await currentServer();
  if (!state) {
    process.stdout.write("code-server is not running\n");
    return 0;
  }
  const minutes = Math.round((Date.now() - state.startedAt) / 60000);
  process.stdout.write(
    `code-server up ${minutes}m on ${origin(state)}\n  ${state.version}\n  pid ${state.pid}\n`,
  );
  return 0;
}

/** Closes the panes but leaves code-server warm, so the next open is quick. */
interface PageTiming {
  at: number;
  origin: number;
  responseEnd: number;
  domInteractive: number;
  loadEnd: number;
  marks: Record<string, number>;
}

const STAGES: [string, string][] = [
  ["renderer started", "code/didStartRenderer"],
  ["workbench script loaded", "code/didLoadWorkbenchMain"],
  ["workbench starting", "code/willStartWorkbench"],
  ["editors restored", "code/didRestoreEditors"],
  ["workbench ready", "code/didStartWorkbench"],
  ["settled", "code/LifecyclePhase/Eventually"],
];

/** The page reports its own marks through the injector, so this is what the
 * workbench measured rather than what polling from outside could see. */
function timingCommand(): number {
  let page: PageTiming;
  try {
    page = JSON.parse(fs.readFileSync(`${CSS_FILE}.timing.json`, "utf8")) as PageTiming;
  } catch {
    process.stdout.write("no page timing recorded yet, open tode once\n");
    return 0;
  }
  let launch: { spawnedAt: number; stages: [string, number][] } | null = null;
  try {
    launch = JSON.parse(fs.readFileSync(`${CSS_FILE}.launch.json`, "utf8"));
  } catch {}
  const bar = (ms: number, of: number) => "\u2588".repeat(Math.max(1, Math.round((ms / of) * 34)));
  const total = Math.max(page.marks["code/didStartWorkbench"] ?? 0, page.loadEnd, 1);
  const seconds = Math.round((Date.now() - page.at) / 1000);
  process.stdout.write(`page load, ${seconds}s ago\n\n`);
  const beforeNavigation = launch ? page.origin - launch.spawnedAt : null;
  const rows: [string, number][] = [
    ...(launch
      ? ([
          ...launch.stages.map(([label, ms]) => [`tode: ${label}`, ms - launch!.stages[launch!.stages.length - 1][1]] as [string, number]),
        ] as [string, number][])
      : []),
    ...(beforeNavigation !== null && beforeNavigation >= 0
      ? ([["browser start to navigation", beforeNavigation]] as [string, number][])
      : []),
    ["document arrived", page.responseEnd],
    ["dom interactive", page.domInteractive],
    ...STAGES.filter(([, mark]) => page.marks[mark] != null).map(
      ([label, mark]) => [label, page.marks[mark]] as [string, number],
    ),
  ];
  for (const [label, ms] of rows) {
    process.stdout.write(`  ${label.padEnd(24)} ${String(ms).padStart(5)}ms  ${bar(ms, total)}\n`);
  }
  return 0;
}

async function quitCommand(): Promise<number> {
  const runtime = await resolveRuntime().catch(() => null);
  if (!runtime) return 0;
  await new Promise<void>((resolve) => {
    const child = spawn(runtime.bin, ["shutdown"], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
  return 0;
}

async function shutdownCommand(): Promise<number> {
  const stopped = stopServer();
  const runtime = await resolveRuntime().catch(() => null);
  if (runtime) {
    await new Promise<void>((resolve) => {
      const child = spawn(runtime.bin, ["shutdown"], { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }
  process.stdout.write(stopped ? "tode stopped\n" : "nothing was running\n");
  return 0;
}

async function upgradeCommand(args: string[]): Promise<number> {
  const check = takeBool(args, "--check");
  const version = takeFlag(args, "--version");
  let announced = false;
  const outcome = await upgrade({
    check,
    version,
    onStage: (stage, fraction) => {
      if (stage !== "downloading") return;
      if (!announced) {
        process.stderr.write("tode: downloading\n");
        announced = true;
      }
      const percent = Math.round(fraction * 100);
      process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
    },
  });

  switch (outcome.kind) {
    case "not-an-install":
      // a checkout has no VERSION file, and overwriting one would throw away work
      fail(`${outcome.root} is a working tree, not an install — use git pull`);
    // eslint-disable-next-line no-fallthrough
    case "current":
      process.stdout.write(`tode ${outcome.version} is the newest on ${outcome.channel}\n`);
      return 0;
    case "available":
      process.stdout.write(`tode ${outcome.build.version} is available (you have ${outcome.from})\n`);
      return 0;
    case "upgraded":
      // the old code-server is still serving the tree that just moved
      stopServer();
      process.stdout.write(`tode ${outcome.from} -> ${outcome.build.version}\n`);
      return 0;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`tode, terminal-browser ${PINNED_VERSION}\n`);
    return 0;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "doctor") return doctorCommand(args.slice(1));
  if (args[0] === "import") return importCommand(args.slice(1));
  if (args[0] === "theme") return themeCommand();
  if (args[0] === "runtime") return runtimeCommand();
  if (args[0] === "daemon") return daemonCommand(args[1]);
  if (args[0] === "timing") return timingCommand();
  if (args[0] === "quit") return quitCommand();
  if (args[0] === "upgrade") return upgradeCommand(args.slice(1));
  if (args[0] === "shutdown") return shutdownCommand();
  return openCommand(args);
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

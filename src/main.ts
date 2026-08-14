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
import { CODE_SERVER_VERSION, ensureCodeServer, installedCodeServer, narrateFetch } from "./codeserver/vendored";
import { installBridge, requestStartupView } from "./bridge";
import { BOOT_AFTER_APPLY, firstRunShortcuts, shortcutsCommand } from "./shortcuts/wizard";
import { importCommand } from "./import/command";
import { firstRunImport } from "./import/firstrun";
import { parseGoto, runningWindow, sendToWindow } from "./ipc";
import type { OpenFile } from "./ipc";
import { EXTENSIONS_DIR, VSCODE_DIR, registerThemeExtension } from "./profile";
import {
  cachePalette,
  ensureFont,
  installCss,
  installKeybindings,
  setLiveTheme,
  setThemeFile,
  installSettings,
  installTheme,
  readPalette,
} from "./profile";
import { launchBrowser } from "./launch";
import { PINNED_VERSION, resolveRuntime, resolveRuntimeWithProgress } from "./runtime/release";
import { BROWSER_HOME } from "./runtime/paths";
import { resolveTarget, workbenchUrl } from "./target";
import { upgrade } from "./upgrade";
import { hex } from "./theme/color";
import { generateTheme, semanticColors } from "./theme/generate";

/** Where the installer put the shim — the same computation install.sh makes. */
function shimPath(): string {
  const binHome = process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin");
  return path.join(binHome, "tode");
}

/** What the bridge extension should run to reach tode again. The shim is
 * preferred because it rebuilds a stale dev tree before running. */
function todeCommand(): string[] {
  const shim = shimPath();
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
  --review              Open on the source control panel

Commands:
  shortcuts             Decide, chord by chord, whether this terminal or the
                        editor gets each contested shortcut (--status, --undo)
  timing                Where the last page load spent its time
  quit                  Close the tode panes, leaving code-server warm
  import [editor]       Bring settings, keybindings, snippets and extensions
                        over from vscode or a fork of it
  theme [file]          Show the colours this terminal reports, and rebuild;
                        with a vscode theme file, set that as the editor theme
  runtime               Which terminal-browser build is in use, and why
  provision             Fetch the pinned code-server build if it is missing
  daemon status|stop    The code-server that stays warm between opens
  upgrade [--check]     Install the newest build on this channel
  shutdown              Stop everything tode is running
`;


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
  const review = takeBool(args, "--review");
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

  if (
    window &&
    !opensAPane &&
    (files.length > 0 || sendFolders.length > 0 || pair.length > 0 || review)
  ) {
    await sendToWindow(
      window,
      {
        files,
        folders: sendFolders,
        add: added.length > 0,
        wait,
        diff: pair,
        ...(review ? { view: "scm" } : {}),
      },
      wait ? 0 : 4000,
    ).catch((error) => fail(`could not reach the tode window: ${error.message}`));
    return 0;
  }

  const mark = Date.now();
  const stages: [string, number][] = [];
  const done = (label: string) => stages.push([label, Date.now() - mark]);

  const target = wanted[0] ?? resolveTarget(undefined, process.cwd());
  const runtime = await resolveRuntimeWithProgress();
  done("runtime");
  // the terminal is asked for its colours here, while tode still owns the tty
  const { palette } = await readPalette();
  ensureFont();
  installTheme(palette);
  installCss(palette);
  installSettings();
  setLiveTheme(generateTheme(palette));
  done("profile");
  // once, before the first editor ever shows: the other editor's setup comes
  // over first (imported keybindings feed the shortcut scan), then contested
  // chords get resolved while the cost of a wrong one is still zero
  await firstRunImport();
  await firstRunShortcuts();
  // after the wizard on purpose: the bridge bakes the quit hint and the
  // keybindings read the decisions, so both have to see what was just chosen
  installBridge(todeCommand());
  installKeybindings();
  const server = await ensureServer();
  done("code-server");

  if (timing) {
    for (const [label, ms] of stages) process.stderr.write(`  ${label.padEnd(12)} ${ms}ms\n`);
  }

  // stamped last: the bridge discards markers older than two minutes, and on a
  // fresh install the wizard and the code-server download can spend all of that
  if (review) requestStartupView("scm");
  const url = workbenchUrl(origin(server), target);
  return launchBrowser(runtime, url, palette, { split, size, stages }).catch((error: Error) =>
    fail(error.message),
  );
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

async function themeCommand(file?: string): Promise<number> {
  if (file) {
    const error = setThemeFile(file);
    if (error) {
      process.stderr.write(`tode: ${error}\n`);
      return 1;
    }
    installBridge(todeCommand());
    process.stdout.write(`theme set from ${file} — open windows follow without a reload\n`);
    return 0;
  }
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
  setLiveTheme(generateTheme(palette));
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
  const runtime = await resolveRuntimeWithProgress();
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

/** Everything a first open would have to download, fetched up front: the
 * installer runs this so the install is complete when it says it is. */
async function provisionCommand(): Promise<number> {
  await resolveRuntimeWithProgress();
  const had = installedCodeServer();
  if (had) {
    process.stdout.write(`code-server ready at ${had}\n`);
    return 0;
  }
  const bin = await ensureCodeServer(narrateFetch(`code-server ${CODE_SERVER_VERSION}`));
  process.stdout.write(`code-server ready at ${bin}\n`);
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
    case "upgraded": {
      // the old code-server is still serving the tree that just moved
      stopServer();
      // the new tree may pin different bundles; provision through the fresh
      // shim so the download happens now rather than on the next open
      const shim = shimPath();
      if (fs.existsSync(shim)) spawnSync(shim, ["provision"], { stdio: "inherit" });
      process.stdout.write(`tode ${outcome.from} -> ${outcome.build.version}\n`);
      return 0;
    }
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
  if (args[0] === "shortcuts") {
    const rest = args.slice(1);
    // a script running the wizard would block on the editor booting over the
    // script's own cwd — --no-boot lets it apply and return
    const noBoot = takeBool(rest, "--no-boot");
    const code = await shortcutsCommand(rest);
    if (code === BOOT_AFTER_APPLY) return noBoot ? 0 : openCommand([]);
    return code;
  }
  if (args[0] === "import") return importCommand(args.slice(1));
  if (args[0] === "theme") return themeCommand(args[1]);
  if (args[0] === "runtime") return runtimeCommand();
  if (args[0] === "provision") return provisionCommand();
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

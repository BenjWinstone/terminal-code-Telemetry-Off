import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BROWSER_HOME, RUNTIME_DIR, VENDOR_DIR } from "./paths";

/** The terminal-browser build tode is written against. tode drives flags whose
 * behaviour is specific to this build, so it pins rather than taking whatever
 * happens to be installed. */
export const PINNED_VERSION = "app-mode-6b14c0b";

const RELEASE_ORIGIN = process.env.TODE_RELEASE_ORIGIN ?? "https://terminal-browser.sh/install";

const SYSTEM_INSTALL = path.join(
  process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local/share"),
  "terminal-browser",
  "app",
);

export interface Release {
  version: string;
  channel: string;
  url: string;
  sha256: string;
  size: number;
}

export type Source = "override" | "vendored" | "pinned" | "cloned" | "downloaded";

/** The platform-arch pair release tables are keyed by, here and on tode's own
 * release worker. One computation, shared by everything that picks a build. */
export function targetTriple(): string {
  return `${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }`;
}

/** The copy that ships inside the release. A normal install always resolves
 * here, so the first run costs no download and needs no network. */
const VENDORED = path.join(VENDOR_DIR, "terminal-browser");

export interface Runtime {
  bin: string;
  root: string;
  version: string;
  source: Source;
}

/** The pinned installer carries a per-platform table of download urls and their
 * hashes, so asking for one version is enough to fetch the right build and know
 * the bytes are the right ones. */
export async function lookup(version: string): Promise<Release> {
  const url = `${RELEASE_ORIGIN}/v/${version}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`no release ${version} (${response.status} from ${url})`);
  const script = await response.text();
  const field = (name: string) => {
    const found = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
    if (!found) throw new Error(`release ${version} did not report ${name}`);
    return found[1];
  };
  const target = targetTriple();
  const row = field("PLATFORMS")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === target);
  if (!row || row.length < 4) throw new Error(`release ${version} has no build for ${target}`);
  return {
    version: field("VERSION"),
    channel: field("CHANNEL"),
    url: row[1],
    sha256: row[2],
    size: Number(row[3]),
  };
}

function versionAt(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Where the electron binary lives inside a terminal-browser tree. macOS ships
 * an app bundle; linux ships the bare electron layout. */
export function electronEntry(root: string): string {
  return process.platform === "darwin"
    ? path.join(root, "electron", "terminal-browser.app", "Contents", "MacOS", "terminal-browser")
    : path.join(root, "electron", "electron");
}

function usable(root: string, version: string): boolean {
  return (
    versionAt(root) === version &&
    fs.existsSync(path.join(root, "cli", "dist", "main.js")) &&
    fs.existsSync(electronEntry(root))
  );
}

function rootFor(version: string): string {
  return path.join(RUNTIME_DIR, "terminal-browser", version);
}

/** Every child terminal-browser starts is launched through this script, including
 * the one a split pane opens, so pointing it at tode's own directories here is
 * what keeps the two installs from evicting each other's daemon. */
function writeLauncher(root: string) {
  const bin = path.join(root, "bin", "terminal-browser");
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const electron = path.relative(root, electronEntry(root));
  // the scroll helper only ships in the macOS build; exporting a path that is
  // not there would make terminal-browser try it anyway
  const scrollHelper =
    process.platform === "darwin"
      ? `export NATIVE_SCROLL_HELPER="\${NATIVE_SCROLL_HELPER:-$ROOT/bin/native-scroll-helper}"\n`
      : "";
  fs.writeFileSync(
    bin,
    `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
${scrollHelper}export XDG_DATA_HOME=\${TODE_BROWSER_DATA:-${quote(BROWSER_HOME.data)}}
export XDG_STATE_HOME=\${TODE_BROWSER_STATE:-${quote(BROWSER_HOME.state)}}
export XDG_CACHE_HOME=\${TODE_BROWSER_CACHE:-${quote(BROWSER_HOME.cache)}}
export XDG_RUNTIME_DIR=\${TODE_BROWSER_RUN:-${quote(BROWSER_HOME.runtime)}}
export TERMINAL_BROWSER_APPDATA=\${TODE_BROWSER_APPDATA:-${quote(BROWSER_HOME.appData)}}
exec "$ROOT/${electron}" "$ROOT/cli/dist/main.js" "$@"
`,
  );
  fs.chmodSync(bin, 0o755);
  for (const dir of Object.values(BROWSER_HOME)) fs.mkdirSync(dir, { recursive: true });
  return bin;
}

export function unpack(tarball: string, root: string) {
  const staging = `${root}.unpacking`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", staging, "--strip-components", "1"]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(staging, root);
}

/** On APFS this clones rather than copies, so reusing an install the user already
 * has costs no download and almost no disk. */
function cloneTree(from: string, to: string): boolean {
  const staging = `${to}.cloning`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    execFileSync("cp", ["-Rc", from, staging], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("cp", ["-R", from, staging], { stdio: "ignore" });
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      return false;
    }
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(staging, to);
  return true;
}

/** Streams a url to disk while hashing it, and refuses the file when the bytes
 * are not the ones the release table promised. */
export async function fetchVerified(
  url: string,
  sha256: string,
  size: number,
  tarball: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} from ${url})`);
  }
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(tarball);
  let read = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    read += chunk.byteLength;
    if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    if (size) onProgress?.(read / size);
  }
  await new Promise<void>((resolve, reject) => {
    file.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  const got = hash.digest("hex");
  if (got !== sha256) {
    fs.rmSync(tarball, { force: true });
    throw new Error(`download corrupted: expected ${sha256}, got ${got}`);
  }
  return tarball;
}

function download(release: Release, onProgress?: (fraction: number) => void): Promise<string> {
  const tarball = path.join(RUNTIME_DIR, `${release.version}.tar.gz`);
  return fetchVerified(release.url, release.sha256, release.size, tarball, onProgress);
}

/** Ask the runtime which options it takes rather than assuming, so tode can be
 * ahead of the release it is pinned to without failing to start. */
export function supportedFlags(runtime: Runtime): Set<string> {
  const cache = path.join(RUNTIME_DIR, `flags-${runtime.version}.txt`);
  let help = "";
  try {
    help = fs.readFileSync(cache, "utf8");
  } catch {
    try {
      help = execFileSync(runtime.bin, ["open", "--help"], { encoding: "utf8", timeout: 10_000 });
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, help);
    } catch {
      return new Set();
    }
  }
  return new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
}

export interface ResolveOptions {
  version?: string;
  onProgress?(stage: "cloning" | "downloading", fraction: number): void;
}

/** resolveRuntime with the download narrated on stderr, for interactive runs. */
export async function resolveRuntimeWithProgress(): Promise<Runtime> {
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

export async function resolveRuntime(options: ResolveOptions = {}): Promise<Runtime> {
  const version = options.version ?? PINNED_VERSION;

  const override = process.env.TODE_TERMINAL_BROWSER_BIN;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`TODE_TERMINAL_BROWSER_BIN is not there: ${override}`);
    const root = path.resolve(path.dirname(override), "..");
    return { bin: override, root, version: versionAt(root) ?? "override", source: "override" };
  }

  // the vendored copy is checked first, and only for the version tode pins:
  // asking for another version has to go and get that one
  if (version === PINNED_VERSION && usable(VENDORED, version)) {
    return { bin: writeLauncher(VENDORED), root: VENDORED, version, source: "vendored" };
  }

  const root = rootFor(version);
  if (usable(root, version)) {
    return { bin: writeLauncher(root), root, version, source: "pinned" };
  }

  if (usable(SYSTEM_INSTALL, version)) {
    options.onProgress?.("cloning", 0);
    if (cloneTree(SYSTEM_INSTALL, root)) {
      options.onProgress?.("cloning", 1);
      return { bin: writeLauncher(root), root, version, source: "cloned" };
    }
  }

  const release = await lookup(version);
  const tarball = await download(release, (fraction) => options.onProgress?.("downloading", fraction));
  unpack(tarball, root);
  fs.rmSync(tarball, { force: true });
  if (!usable(root, version)) throw new Error(`unpacked ${version} but it is missing pieces`);
  return { bin: writeLauncher(root), root, version, source: "downloaded" };
}

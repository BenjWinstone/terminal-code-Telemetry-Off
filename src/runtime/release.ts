import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BROWSER_HOME, RUNTIME_DIR } from "./paths";

/** The terminal-browser build tode is written against. tode drives flags whose
 * behaviour is specific to this build, so it pins rather than taking whatever
 * happens to be installed. */
export const PINNED_VERSION = "main-e6eca1e";

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

export type Source = "override" | "pinned" | "cloned" | "downloaded";

export interface Runtime {
  bin: string;
  root: string;
  version: string;
  source: Source;
}

/** The pinned installer carries the download url and its hash, so asking for one
 * version is enough to fetch it and know the bytes are the right ones. */
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
  return {
    version: field("VERSION"),
    channel: field("CHANNEL"),
    url: field("DOWNLOAD_URL"),
    sha256: field("SHA256"),
    size: Number(field("SIZE")),
  };
}

function versionAt(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function usable(root: string, version: string): boolean {
  return (
    versionAt(root) === version &&
    fs.existsSync(path.join(root, "cli", "dist", "main.js")) &&
    fs.existsSync(path.join(root, "electron", "terminal-browser.app"))
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
  fs.writeFileSync(
    bin,
    `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
export NATIVE_SCROLL_HELPER="\${NATIVE_SCROLL_HELPER:-$ROOT/bin/native-scroll-helper}"
export XDG_DATA_HOME=\${TODE_BROWSER_DATA:-${quote(BROWSER_HOME.data)}}
export XDG_STATE_HOME=\${TODE_BROWSER_STATE:-${quote(BROWSER_HOME.state)}}
export XDG_CACHE_HOME=\${TODE_BROWSER_CACHE:-${quote(BROWSER_HOME.cache)}}
export XDG_RUNTIME_DIR=\${TODE_BROWSER_RUN:-${quote(BROWSER_HOME.runtime)}}
export TERMINAL_BROWSER_APPDATA=\${TODE_BROWSER_APPDATA:-${quote(BROWSER_HOME.appData)}}
exec "$ROOT/electron/terminal-browser.app/Contents/MacOS/terminal-browser" "$ROOT/cli/dist/main.js" "$@"
`,
  );
  fs.chmodSync(bin, 0o755);
  for (const dir of Object.values(BROWSER_HOME)) fs.mkdirSync(dir, { recursive: true });
  return bin;
}

function unpack(tarball: string, root: string) {
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

async function download(release: Release, onProgress?: (fraction: number) => void): Promise<string> {
  const response = await fetch(release.url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} from ${release.url})`);
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tarball = path.join(RUNTIME_DIR, `${release.version}.tar.gz`);
  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(tarball);
  let read = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    read += chunk.byteLength;
    if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    if (release.size) onProgress?.(read / release.size);
  }
  await new Promise<void>((resolve, reject) => {
    file.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  const got = hash.digest("hex");
  if (got !== release.sha256) {
    fs.rmSync(tarball, { force: true });
    throw new Error(`download corrupted: expected ${release.sha256}, got ${got}`);
  }
  return tarball;
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

export async function resolveRuntime(options: ResolveOptions = {}): Promise<Runtime> {
  const version = options.version ?? PINNED_VERSION;

  const override = process.env.TODE_TERMINAL_BROWSER_BIN;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`TODE_TERMINAL_BROWSER_BIN is not there: ${override}`);
    const root = path.resolve(path.dirname(override), "..");
    return { bin: override, root, version: versionAt(root) ?? "override", source: "override" };
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

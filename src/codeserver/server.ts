import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DATA_DIR, LOGS_DIR, STATE_DIR } from "../runtime/paths";

const VSCODE_DIR = path.join(DATA_DIR, "vscode");
const STATE_FILE = path.join(STATE_DIR, "server.json");

export interface ServerState {
  pid: number;
  port: number;
  /** the injecting proxy the browser actually talks to */
  injectorPid: number;
  injectorPort: number;
  version: string;
  startedAt: number;
}

export const CSS_FILE = path.join(DATA_DIR, "inject.css");
// kept apart from the run state, which is cleared on every stop
const PORT_FILE = path.join(DATA_DIR, "injector.port");

function fontAsset(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", "JetBrainsMono-Regular.ttf");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return "";
  }
}

export function codeServerBin(): string {
  const configured = process.env.TODE_CODE_SERVER;
  if (configured) return configured;
  try {
    return execFileSync("which", ["code-server"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "code-server is not on PATH. Install it (brew install code-server) or set TODE_CODE_SERVER.",
    );
  }
}

function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
}

function writeState(state: ServerState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function answering(port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function currentServer(): Promise<ServerState | null> {
  const state = readState();
  if (!state || !running(state.pid) || !running(state.injectorPid)) return null;
  const [up, proxied] = await Promise.all([answering(state.port), answering(state.injectorPort)]);
  return up && proxied ? state : null;
}

function serverVersion(bin: string): string {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
  } catch {
    return "unknown";
  }
}

/** One code-server serves every folder, because the workbench takes the folder as
 * a url parameter. Opening a second project is a navigation, not another boot. */
export async function ensureServer(): Promise<ServerState> {
  const existing = await currentServer();
  if (existing) return existing;

  const bin = codeServerBin();
  const port = await freePort();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const log = fs.openSync(path.join(LOGS_DIR, "code-server.log"), "a");
  const child = spawn(
    bin,
    [
      "--auth",
      "none",
      "--bind-addr",
      `127.0.0.1:${port}`,
      "--user-data-dir",
      path.join(VSCODE_DIR, "user-data"),
      "--extensions-dir",
      path.join(VSCODE_DIR, "extensions"),
      "--app-name",
      "tode",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-workspace-trust",
      "--disable-getting-started-override",
      // tode always says what it wants open, so the last one is never right
      "--ignore-last-opened",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  if (!child.pid) throw new Error("could not start code-server");

  // the injector comes up straight away and holds requests until code-server is
  // listening, so the browser can be starting at the same time rather than after
  const injector = await startInjector(port, log);
  void codeServerReady(port, child.pid).then((up) => {
    if (up) void warmUp(injector.port);
  });
  const state = {
    pid: child.pid,
    port,
    injectorPid: injector.pid,
    injectorPort: injector.port,
    version: serverVersion(bin),
    startedAt: Date.now(),
  };
  writeState(state);
  return state;
}

async function codeServerReady(port: number, pid: number): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return true;
    if (!running(pid)) return false;
    await sleep(60);
  }
  return false;
}

/** The port ends up inside saved workspace files as the remote authority, and it
 * is also what chromium keys its cache on, so the same one is kept between runs
 * whenever it is still free. */
async function injectorPort(): Promise<number> {
  let previous = 0;
  try {
    previous = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
  } catch {}
  const port = previous && (await available(previous)) ? previous : await freePort();
  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  fs.writeFileSync(PORT_FILE, String(port));
  return port;
}

function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function startInjector(upstream: number, log: number): Promise<{ pid: number; port: number }> {
  const port = await injectorPort();
  const script = path.join(__dirname, "injector-main.js");
  const font = fontAsset();
  const child = spawn(process.execPath, [script, String(upstream), String(port), CSS_FILE, font], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (!child.pid) throw new Error("could not start the css injector");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return { pid: child.pid, port };
    if (!running(child.pid)) throw new Error("the css injector exited during start");
    await sleep(40);
  }
  throw new Error("the css injector did not start within 10s");
}

/** code-server is a good deal slower answering its first request than its
 * second, so it gets asked for the workbench before anyone is waiting. */
async function warmUp(port: number): Promise<void> {
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: "text/html" },
    });
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    await Promise.all(
      assets.slice(0, 4).map((asset) =>
        fetch(new URL(asset, `http://127.0.0.1:${port}/`)).then((r) => r.arrayBuffer()).catch(() => null),
      ),
    );
  } catch {}
}

export function stopServer(): boolean {
  const state = readState();
  if (!state) return false;
  let stopped = false;
  for (const pid of [state.injectorPid, state.pid]) {
    if (pid && running(pid)) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
  }
  fs.rmSync(STATE_FILE, { force: true });
  return stopped;
}

/** The browser is pointed at the injector, never at code-server directly. */
export function origin(state: ServerState): string {
  return `http://127.0.0.1:${state.injectorPort}/`;
}

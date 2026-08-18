import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

// hm
const DATA_HOME = base("XDG_DATA_HOME", ".local/share");
const STATE_HOME = base("XDG_STATE_HOME", ".local/state");
const CACHE_HOME = base("XDG_CACHE_HOME", ".cache");

export const INSTALL_ROOT =
  process.env.TODE_INSTALL_ROOT && path.isAbsolute(process.env.TODE_INSTALL_ROOT)
    ? process.env.TODE_INSTALL_ROOT
    : path.resolve(__dirname, "..", "..");

export const VENDOR_DIR = path.join(INSTALL_ROOT, "vendor");

export const DEFAULT_INSTALL_ROOT = path.join(HOME, ".local", "lib", "tode");

export const DATA_DIR = path.join(DATA_HOME, "tode");
export const STATE_DIR = path.join(STATE_HOME, "tode");
export const CACHE_DIR = path.join(CACHE_HOME, "tode");

export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const LOGS_DIR = path.join(STATE_DIR, "logs");

export const BROWSER_HOME = {
  data: path.join(DATA_DIR, "browser", "share"),
  state: path.join(STATE_DIR, "browser", "state"),
  cache: path.join(CACHE_DIR, "browser"),
  // not sure why this is called chromium thats just wrong
  appData: path.join(DATA_DIR, "browser", "chromium"),
};

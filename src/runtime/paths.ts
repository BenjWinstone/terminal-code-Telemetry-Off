import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

const DATA_HOME = base("XDG_DATA_HOME", ".local/share");
const STATE_HOME = base("XDG_STATE_HOME", ".local/state");
const CACHE_HOME = base("XDG_CACHE_HOME", ".cache");

export const DATA_DIR = path.join(DATA_HOME, "tode");
export const STATE_DIR = path.join(STATE_HOME, "tode");
export const CACHE_DIR = path.join(CACHE_HOME, "tode");

export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const DB_FILE = path.join(DATA_DIR, "tode.db");
export const LOGS_DIR = path.join(STATE_DIR, "logs");

/** The XDG homes tode hands to terminal-browser. Keeping them out of the user's
 * own means the two never share a daemon socket, a database or a log. */
export const BROWSER_HOME = {
  data: path.join(DATA_DIR, "browser", "share"),
  state: path.join(STATE_DIR, "browser", "state"),
  cache: path.join(CACHE_DIR, "browser"),
  runtime: path.join(STATE_DIR, "browser", "run"),
  appData: path.join(DATA_DIR, "browser", "chromium"),
};

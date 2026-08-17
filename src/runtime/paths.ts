/**
 * this is quite dense, i need a mental model for this before i merge
 */
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

/** Where the release was unpacked. The program is deliberately not under
 * XDG_DATA_HOME: an upgrade replaces this whole tree by rename, and that home
 * holds the vscode profile, the database and the browser data, which an upgrade
 * must never touch. ~/.local/lib mirrors /usr/local/lib and pairs with the
 * ~/.local/bin shim. There is no XDG_LIB_HOME to read, so the override is ours.
 *
 * The release tree mirrors the repo — dist/, assets/, config/ — so __dirname is
 * <root>/dist/runtime either way and one resolution serves both. From a git
 * checkout this lands on the repo, where vendor/ does not exist and the lookup
 * simply falls through to the older sources. */
export const INSTALL_ROOT =
  process.env.TODE_INSTALL_ROOT && path.isAbsolute(process.env.TODE_INSTALL_ROOT)
    ? process.env.TODE_INSTALL_ROOT
    : path.resolve(__dirname, "..", "..");

/** Named vendor rather than runtime, because dist/runtime is already a thing. */
export const VENDOR_DIR = path.join(INSTALL_ROOT, "vendor");

export const DEFAULT_INSTALL_ROOT = path.join(HOME, ".local", "lib", "tode");

export const DATA_DIR = path.join(DATA_HOME, "tode");
export const STATE_DIR = path.join(STATE_HOME, "tode");
export const CACHE_DIR = path.join(CACHE_HOME, "tode");

export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const DB_FILE = path.join(DATA_DIR, "tode.db");
export const LOGS_DIR = path.join(STATE_DIR, "logs");

/** The XDG homes tode hands to terminal-browser. Keeping them out of the user's
 * own means the two never share a database or a log.
 *
 * XDG_RUNTIME_DIR is deliberately absent: the Wayland compositor socket lives
 * at $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY, so redirecting it leaves chromium
 * unable to find the display and the daemon dies before binding its socket.
 * Daemon isolation does not need it — terminal-browser namespaces its runtime
 * dir by a hash of the install root, and on macOS (no XDG_RUNTIME_DIR) it
 * falls back to the state home, which is redirected. */
export const BROWSER_HOME = {
  data: path.join(DATA_DIR, "browser", "share"),
  state: path.join(STATE_DIR, "browser", "state"),
  cache: path.join(CACHE_DIR, "browser"),
  appData: path.join(DATA_DIR, "browser", "chromium"),
};

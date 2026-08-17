/** The embedder api of the terminal-browser build tode pins (app-mode-9dd0f98).
 *
 * Transcribed from browser/src/session/session.tsx in that build: an api
 * preload registered ahead of every --preload script defines
 * globalThis.terminalBrowser with a theme-only surface. The --main-script
 * module is required in the browser process for its side effects and called
 * with nothing, so anything the preloads want to tell it travels over
 * electron's own ipc (see preload.ts / mainscript.ts). These types belong in
 * the terminal-browser release itself eventually; until it ships them, this
 * file is the contract and moves when the pin moves. */

/** themePayload() in session.tsx: rgb triples, 16 ansi slots, null where the
 * terminal did not report a colour */
export interface TerminalTheme {
  background: number[];
  foreground: number[];
  ansi: (number[] | null)[];
}

export interface TerminalBrowserApi {
  /** the last theme the terminal reported, null before the first */
  theme(): TerminalTheme | null;
  /** calls back immediately when a theme is already known; returns unsubscribe */
  onTheme(subscriber: (theme: TerminalTheme) => void): () => void;
}

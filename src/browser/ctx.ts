import type { TerminalTheme } from "./api";

/** Everything the generated browser scripts need to know that is decided on the
 * tode side. JSON only — browserglue serializes a ctx literal into each file. */

/** Nothing crosses yet: neither the theme flow nor the timing flow needs
 * configuration. This is the slot the proxy's remaining page-editing duties
 * (css text, font bytes) land in if they move into the preload. */
export type PreloadCtx = Record<string, never>;

export interface MainCtx {
  /** where tode windows put their ipc sockets, one .sock per window */
  socketDir: string;
  /** where the workbench's startup timings land, read back by `tode timing` */
  timingFile: string;
  /** absolute paths to tode's own compiled modules, required at run time from
   * the browser process and typed with `typeof import` at the call sites */
  modules: {
    livesync: string;
    generate: string;
    ipc: string;
  };
}

/** what the preload sends and the main script listens for */
export interface ThemeMessage {
  type: "theme";
  colors: TerminalTheme;
}

/** The workbench's own startup story, read from its performance timeline. */
export interface PageTiming {
  at: number;
  origin: number;
  responseEnd: number;
  domInteractive: number;
  loadEnd: number;
  marks: Record<string, number>;
}

export interface TimingMessage {
  type: "timing";
  page: PageTiming;
}

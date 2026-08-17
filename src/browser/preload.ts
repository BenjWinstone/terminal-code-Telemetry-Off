import type { TerminalBrowserApi } from "./api";
import type { PreloadCtx, ThemeMessage, TimingMessage } from "./ctx";

declare const terminalBrowser: TerminalBrowserApi;

export function preloadMain(ctx: PreloadCtx): void {
  // The terminalBrowser api is theme-only; anything bound for tode's main
  // script rides electron's own ipc, since this preload and that script live
  // in the one electron app. The channel name is tode's, so nothing collides
  // with terminal-browser's channels — and it appears verbatim here and in
  // mainscript.ts, because these functions serialize closure-free.
  const { ipcRenderer } = require("electron") as {
    ipcRenderer: { send(channel: string, message: unknown): void };
  };
  const deliver = (message: unknown) => ipcRenderer.send("tode:message", message);

  terminalBrowser.onTheme((theme) => {
    const message: ThemeMessage = { type: "theme", colors: theme };
    deliver(message);
  });

  // The workbench's startup story, read from its own performance marks and
  // sent once the workbench is up (or the wait times out); the main script
  // writes it down so `tode timing` can print a breakdown without a debugger
  // attached. Child frames share the preload but not the workbench, so only
  // the top document takes part.
  if (window !== window.top) return;
  const send = () => {
    try {
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const marks: Record<string, number> = {};
      for (const mark of performance.getEntriesByType("mark")) {
        if (mark.name.startsWith("code/")) marks[mark.name] = Math.round(mark.startTime);
      }
      const message: TimingMessage = {
        type: "timing",
        page: {
          at: Date.now(),
          origin: Math.round(performance.timeOrigin),
          responseEnd: Math.round(nav?.responseEnd ?? 0),
          domInteractive: Math.round(nav?.domInteractive ?? 0),
          loadEnd: Math.round(nav?.loadEventEnd ?? 0),
          marks,
        },
      };
      deliver(message);
    } catch {}
  };
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    setTimeout(send, 50);
  };
  const poll = setInterval(() => {
    if (performance.getEntriesByName("code/didStartWorkbench").length) {
      clearInterval(poll);
      settle();
    }
  }, 25);
  setTimeout(() => {
    clearInterval(poll);
    settle();
  }, 30000);
}

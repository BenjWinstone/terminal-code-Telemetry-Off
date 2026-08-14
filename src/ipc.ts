import fs from "node:fs";
import net from "node:net";

export interface OpenFile {
  path: string;
  line?: number;
  column?: number;
}

export interface OpenRequest {
  files: OpenFile[];
  folders: string[];
  add: boolean;
  /** hold until the files are closed again, the way a commit editor must */
  wait?: boolean;
  diff?: string[];
  /** a workbench view to focus, like "scm" for tode --review */
  view?: string;
  /** a vscode theme document to apply live, sent by the browser main script
   * when the terminal's theme changes */
  theme?: Record<string, unknown>;
}

/** A tode window puts the address of its socket into every terminal it opens, so
 * running tode from inside tode changes that window instead of making another. */
export function runningWindow(): string | null {
  const socket = process.env.TODE_IPC;
  if (!socket) return null;
  try {
    return fs.statSync(socket).isSocket() ? socket : null;
  } catch {
    return null;
  }
}

export function sendToWindow(socket: string, request: OpenRequest, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    // waiting on an editor has no deadline; the person closes it when they close it
    const timer = timeoutMs
      ? setTimeout(() => {
          connection.destroy();
          reject(new Error("the tode window did not answer"));
        }, timeoutMs)
      : null;
    let buffer = "";
    const settle = (error: Error | null) => {
      if (timer) clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolve();
    };
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const reply = JSON.parse(buffer.split("\n")[0]) as { ok?: boolean; error?: string };
        settle(reply.ok ? null : new Error(reply.error ?? "the window refused"));
      } catch {
        settle(new Error("the window sent something unreadable"));
      }
    });
    connection.on("error", (error) => settle(error));
  });
}

/** Accepts file, file:line and file:line:column, the way code does. A path that
 * really contains a colon still wins, because it is checked on disk first. */
export function parseGoto(argument: string): OpenFile {
  if (fs.existsSync(argument)) return { path: argument };
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(argument);
  if (!match) return { path: argument };
  return {
    path: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : 1,
  };
}

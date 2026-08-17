import fs from "node:fs";
import tty from "node:tty";

import type { Rgb } from "../theme/color";

export interface TerminalPalette {
  background: Rgb;
  foreground: Rgb;
  /** the sixteen ansi slots, in order */
  ansi: Rgb[];
}

/** Terminals answer colour queries as rgb:RRRR/GGGG/BBBB, at whatever width they
 * feel like, so each component is scaled by its own digit count. */
export function parseColor(reply: string): Rgb | null {
  const match = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return null;
  const scale = (raw: string) => Math.round((parseInt(raw, 16) / (16 ** raw.length - 1)) * 255);
  return [scale(match[1]), scale(match[2]), scale(match[3])];
}

const OSC_REPLY = /\x1b\](\d+);(?:(\d+);)?([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface ParsedReplies {
  background: Rgb | null;
  foreground: Rgb | null;
  ansi: (Rgb | null)[];
}

export function parseReplies(raw: string): ParsedReplies {
  const ansi: (Rgb | null)[] = new Array(16).fill(null);
  let background: Rgb | null = null;
  let foreground: Rgb | null = null;
  for (const [, code, index, body] of raw.matchAll(OSC_REPLY)) {
    const color = parseColor(body);
    if (!color) continue;
    if (code === "11") background = color;
    else if (code === "10") foreground = color;
    else if (code === "4" && index !== undefined) {
      const slot = Number(index);
      if (slot >= 0 && slot < 16) ansi[slot] = color;
    }
  }
  return { background, foreground, ansi };
}

function buildQuery(): string {
  const slots = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};?\x07`).join("");
  // the device-attributes reply comes after the colours, so it marks the end
  return `\x1b]11;?\x07\x1b]10;?\x07${slots}\x1b[c`;
}

const DONE = /\x1b\[\?[0-9;]*c/;

/** Ask the terminal itself rather than reading a config file, so this works for
 * any terminal, and over ssh, where the colours live on the other end.
 *
 * The reply is read off the stream rather than polled, because raw mode puts the
 * descriptor in non blocking mode and a synchronous read would spin on EAGAIN
 * for the whole timeout whenever a terminal declines to answer. */
export function queryTerminal(timeoutMs = 400): Promise<ParsedReplies | null> {
  return new Promise((resolve) => {
    if (!process.stdout.isTTY) return resolve(null);
    let fd: number;
    try {
      fd = fs.openSync("/dev/tty", "r+");
    } catch {
      return resolve(null);
    }
    let input: tty.ReadStream | null = null;
    let raw = "";
    let settled = false;
    const finish = (value: ParsedReplies | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        input?.setRawMode(false);
      } catch {}
      try {
        // the stream owns the descriptor once it exists, so only close it here
        if (input) input.destroy();
        else fs.closeSync(fd);
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(raw ? parseReplies(raw) : null), timeoutMs);
    try {
      input = new tty.ReadStream(fd);
      if (!input.isTTY) return finish(null);
      input.setRawMode(true);
      input.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (DONE.test(raw)) finish(parseReplies(raw));
      });
      input.on("error", () => finish(null));
      fs.writeSync(fd, buildQuery());
    } catch {
      finish(null);
    }
  });
}

// eh?
// i see, this is that blue stuff. i suppose that's fine
const FALLBACK_ANSI: Rgb[] = [
  [26, 27, 30],
  [229, 72, 77],
  [48, 164, 108],
  [245, 165, 36],
  [93, 156, 255],
  [186, 148, 255],
  [94, 201, 227],
  [200, 205, 215],
  [90, 96, 106],
  [255, 108, 112],
  [76, 194, 138],
  [255, 196, 84],
  [124, 178, 255],
  [206, 176, 255],
  [126, 220, 240],
  [235, 238, 245],
];

export function withFallbacks(parsed: ParsedReplies | null): TerminalPalette {
  return {
    background: parsed?.background ?? [13, 15, 19],
    foreground: parsed?.foreground ?? [230, 233, 239],
    ansi: FALLBACK_ANSI.map((slot, index) => parsed?.ansi[index] ?? slot),
  };
}

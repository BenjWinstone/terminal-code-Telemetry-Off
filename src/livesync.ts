import fs from "node:fs";
import path from "node:path";

import { withFallbacks } from "./terminal/osc";
import type { TerminalPalette } from "./terminal/osc";
import { paletteFingerprint } from "./theme/generate";

interface RawColors {
  background?: [number, number, number] | null;
  foreground?: [number, number, number] | null;
  ansi?: ([number, number, number] | null)[];
}

export function parseRawColors(text: string): TerminalPalette | null {
  let raw: RawColors;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw.background || !raw.foreground) return null;
  return withFallbacks({
    background: raw.background,
    foreground: raw.foreground,
    ansi: raw.ansi ?? new Array(16).fill(null),
  });
}

function readRawColors(file: string): TerminalPalette | null {
  try {
    return parseRawColors(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Watches the file terminal-browser writes whenever the terminal's colours
 * genuinely change — on a push from a terminal that supports it, or otherwise
 * when the pane regains focus — and calls back only when the new palette is
 * actually different from the one already applied.
 *
 * The directory is watched rather than the file itself: the writer replaces
 * the file with an atomic rename to avoid a reader ever seeing a half written
 * one, and on some platforms a watch on the file's own path stops firing once
 * that rename swaps the underlying inode out from under it. */
export function watchLiveColors(
  file: string,
  startingFrom: TerminalPalette,
  onChange: (palette: TerminalPalette) => void,
): () => void {
  let lastFingerprint = paletteFingerprint(startingFrom);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const name = path.basename(file);
  const check = () => {
    const palette = readRawColors(file);
    if (!palette) return;
    const fingerprint = paletteFingerprint(palette);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    onChange(palette);
  };
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, filename) => {
      if (filename && filename !== name) return;
      // a rename briefly removes the old name before the new one lands
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 30);
    });
  } catch {
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

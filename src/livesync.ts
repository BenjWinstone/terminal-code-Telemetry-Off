import { withFallbacks } from "./terminal/osc";
import type { TerminalPalette } from "./terminal/osc";

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


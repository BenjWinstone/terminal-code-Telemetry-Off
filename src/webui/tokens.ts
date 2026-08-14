import type { TerminalPalette } from "../terminal/osc";
import { hex } from "../theme/color";

/** The one set of ui tokens every tode page draws with, derived from the
 * terminal's own palette — the shortcuts manager and the first-run import
 * screen must read as the same program. */
export function cssTokens(p: TerminalPalette): string {
  return `:root {
    --bg: ${hex(p.background)};
    --fg: ${hex(p.foreground)};
    --red: ${hex(p.ansi[1])};
    --green: ${hex(p.ansi[2])};
    --yellow: ${hex(p.ansi[3])};
    --cyan: ${hex(p.ansi[6])};
    --dim: color-mix(in srgb, var(--fg) 52%, var(--bg));
    --faint: color-mix(in srgb, var(--fg) 32%, var(--bg));
    --line: color-mix(in srgb, var(--fg) 22%, var(--bg));
    --clash: color-mix(in srgb, var(--red) 55%, var(--line));
    --soft: color-mix(in srgb, var(--fg) 45%, var(--bg));
    --lift: color-mix(in srgb, var(--fg) 7%, var(--bg));
  }`;
}

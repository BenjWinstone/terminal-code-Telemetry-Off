#!/bin/bash
# Ten tode frog marks, one codex agent each, all at once. Every prompt asks for
# the same thing structurally — square, centred, transparent, legible small —
# and differs only in the style line, so the ten are comparable.
set -u

OUT="$(cd "$(dirname "$0")/.." && pwd)/public/frogs"
mkdir -p "$OUT"

styles=(
  "01|flat minimal vector: two or three solid colours, geometric shapes, no gradients, no outlines, the kind of mark a modern developer tool would use"
  "02|monoline outline: a single uniform stroke weight, no fill, rounded caps, drawn like a lucide or feather icon"
  "03|pixel art: 16x16 logical pixel grid scaled up crisply with hard edges and no anti-aliasing, limited palette, 8-bit game sprite feel"
  "04|terminal glyph: the frog built entirely out of monospace ASCII characters and box-drawing characters, like terminal art, monochrome green on transparent"
  "05|bauhaus geometric: constructed only from perfect circles, semicircles and arcs, flat primary-ish palette, strict and constructivist"
  "06|CRT phosphor: glowing green vector lines on transparent, scanline feel, retro oscilloscope or vector-monitor look"
  "07|glossy sticker: soft 3D rounded form with a subtle highlight and a thick white sticker border, playful and tactile"
  "08|woodcut stamp: high-contrast black ink, rough carved edges, bold silhouette, letterpress or linocut feel, two tones only"
  "09|low-poly origami: folded paper facets, flat triangular planes with slightly different green tones, faceted and angular"
  "10|hand-drawn ink: loose confident brush-pen sketch, visible stroke texture, slightly wobbly, charming and imperfect"
)

for entry in "${styles[@]}"; do
  n="${entry%%|*}"
  style="${entry#*|}"
  (
    codex exec --sandbox workspace-write --skip-git-repo-check -C "$OUT" \
      "Generate one image and save it to the file frog-$n.png in the current directory.

Subject: a frog head, front facing, as an app icon / logo mark for a developer
tool called 'tode' (a code editor that runs in the terminal).

Style: $style

Requirements:
- square, 1024x1024
- a flat solid background in the colour #0c0c0d, filling the whole canvas — no
  gradient, no vignette, no frame, no shadow. Ask the image model for this
  directly in the generation prompt; do NOT try to post-process the image,
  do NOT chroma-key it, do NOT install anything
- the frog centred with a little breathing room at the edges
- must stay legible when shrunk to 32x32 pixels, so keep the silhouette bold and the detail count low
- no text, no letters, no words anywhere in the image
- charming and characterful, not corporate

Save it as frog-$n.png. Do not save anything else. Generate the image once and
stop — if the first result is reasonable, keep it." \
      >"$OUT/../../.frog-$n.log" 2>&1
  ) &
done

wait
echo "done"
ls -la "$OUT"

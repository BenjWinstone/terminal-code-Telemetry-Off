import fs from "node:fs";
import path from "node:path";

import { editorIconPng } from "./appicon";
import { reportRows } from "./command";
import { describe, findEditors, summarise } from "./editors";
import { runImport } from "./run";
import { startImportPage } from "./web";
import type { OnboardStage } from "../onboarding";
import { readPalette } from "../profile";
import type { TerminalPalette } from "../terminal/osc";
import { DATA_DIR } from "../runtime/paths";

const INTRO_MARKER = path.join(DATA_DIR, "import-intro");

function markShown(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INTRO_MARKER, `${new Date().toISOString()}\n`);
  } catch {}
}

export async function importFirstRunStage(
  next: () => Promise<string>,
  knownPalette?: TerminalPalette,
): Promise<OnboardStage | null> {
  if (fs.existsSync(INTRO_MARKER)) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const editors = findEditors().filter(
    (editor) => summarise(describe(editor)) !== "nothing to import",
  );
  if (editors.length === 0) {
    markShown();
    return null;
  }

  const palette = knownPalette ?? (await readPalette()).palette;
  const page = await startImportPage({
    palette,
    editors: editors.map((editor) => ({ name: editor.name, iconPng: editorIconPng(editor.name) })),
    run(name) {
      const editor = editors.find((candidate) => candidate.name === name)!;
      return reportRows(runImport(editor, () => {}));
    },
    next,
  });
  return {
    url: `http://127.0.0.1:${page.port}`,
    done: page.done,
    served: page.served,
    close: page.close,
    shown: markShown,
  };
}

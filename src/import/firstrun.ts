import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { editorIconPng } from "./appicon";
import { reportRows } from "./command";
import { describe, findEditors, summarise } from "./editors";
import { runImport } from "./run";
import { startImportPage } from "./web";
import { readPalette } from "../profile";
import { DATA_DIR } from "../runtime/paths";
import { resolveRuntimeWithProgress, supportedFlags } from "../runtime/release";

const INTRO_MARKER = path.join(DATA_DIR, "import-intro");

function markShown(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INTRO_MARKER, `${new Date().toISOString()}\n`);
  } catch {}
}

/** The very first open offers to bring another editor's setup over, before
 * the shortcut wizard runs — imported keybindings are part of what that
 * wizard scans. Shown once; tode import does the same thing any time. */
export async function firstRunImport(): Promise<void> {
  if (fs.existsSync(INTRO_MARKER)) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const editors = findEditors().filter(
    (editor) => summarise(describe(editor)) !== "nothing to import",
  );
  if (editors.length === 0) {
    markShown();
    return;
  }

  const { palette } = await readPalette();
  const page = await startImportPage({
    palette,
    editors: editors.map((editor) => ({ name: editor.name, iconPng: editorIconPng(editor.name) })),
    run(name) {
      const editor = editors.find((candidate) => candidate.name === name)!;
      return reportRows(runImport(editor, () => {}));
    },
  });

  const runtime = await resolveRuntimeWithProgress();
  const flags = supportedFlags(runtime);
  const child = spawn(
    runtime.bin,
    [
      "open",
      `http://127.0.0.1:${page.port}`,
      flags.has("--app-mode") ? "--app-mode" : "--chromeless",
      ...(flags.has("--no-shortcuts") ? ["--no-shortcuts"] : []),
    ],
    { stdio: "inherit" },
  );
  void page.done.then(() => child.kill("SIGTERM"));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`could not start terminal-browser: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (exit) => resolve(exit ?? 0));
  });
  page.close();
  if (page.served()) {
    markShown();
  } else {
    process.stderr.write(
      `tode: the import screen never reached the screen (terminal-browser exited ${code})\n`,
    );
  }
}

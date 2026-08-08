import readline from "node:readline";

import {
  applyFix,
  effectiveKeybinds,
  findConflicts,
  ghosttyBinary,
  ghosttyConfigDir,
  isGhostty,
  undoFix,
} from "./terminal/ghostty";
import type { Conflict } from "./terminal/ghostty";

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function report(conflicts: Conflict[]): void {
  process.stdout.write(`${bold("Ghostty is standing between these and vscode:")}\n\n`);
  for (const conflict of conflicts) {
    process.stdout.write(
      `  ${bold(conflict.trigger.padEnd(18))} ${dim(`currently: ${conflict.current}`)}\n`,
    );
    process.stdout.write(`    blocks   ${conflict.blocks}\n`);
    process.stdout.write(`    trades   ${conflict.tradeoff}\n\n`);
  }
}

export async function doctorCommand(args: string[]): Promise<number> {
  if (args.includes("--undo")) {
    const dir = ghosttyConfigDir();
    const undone = undoFix(dir);
    process.stdout.write(
      undone
        ? `removed tode's ghostty overrides from ${dir}\nreload ghostty (cmd+shift+,) or restart it\n`
        : "nothing to undo\n",
    );
    return 0;
  }

  if (!isGhostty()) {
    process.stdout.write("doctor only knows ghostty right now — this terminal is something else\n");
    return 0;
  }
  const binary = ghosttyBinary();
  if (!binary) {
    process.stdout.write("the ghostty cli is not on PATH, so its keybinds cannot be checked\n");
    return 1;
  }

  const effective = effectiveKeybinds(binary);
  const conflicts = findConflicts(effective);
  if (conflicts.length === 0) {
    process.stdout.write("ghostty already leaves every chord tode needs alone\n");
    return 0;
  }

  report(conflicts);
  process.stdout.write(
    `${yellow("this changes ghostty everywhere")}, not just in tode — the tradeoffs above apply ` +
      `in every pane, and it takes a reload or restart to reverse.\n`,
  );

  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write("\nrun again with --yes to apply, or on a terminal to be asked\n");
      return 0;
    }
    const answer = await ask("\nfree these chords in ghostty? [y/N] ");
    if (!/^y(es)?$/i.test(answer)) {
      process.stdout.write("left as is\n");
      return 0;
    }
  }

  const dir = ghosttyConfigDir();
  applyFix(dir, conflicts);
  process.stdout.write(
    `\nwrote ${dir}/tode/keybinds.ghostty\n` +
      `reload ghostty (cmd+shift+,) or restart it for this to take effect\n` +
      `undo any time with: tode doctor --undo\n`,
  );
  return 0;
}

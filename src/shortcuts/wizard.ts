import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { builtinKeybindings, installKeybindings, readPalette } from "../profile";
import { DATA_DIR } from "../runtime/paths";
import { resolveRuntimeWithProgress, supportedFlags } from "../runtime/release";
import { extensionHolder, importedConflicts, importedHolder } from "./imported";
import { wrap } from "./prompt";
import { providerFor, providerNames } from "./provider";
import type { ProviderConflict, ShortcutProvider } from "./provider";
import { QUIT_CHORD, clearDecisions, loadDecisions, saveDecisions } from "./store";
import type { Decision } from "./store";
import { startManager } from "./web";
import type { ManagerRow } from "./web";
import { words } from "./words";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

const MODS = ["ctrl", "shift", "alt", "cmd"];
const KEY_PATTERN = /^([a-z0-9]|f[0-9]{1,2}|left|right|up|down|home|end|pageup|pagedown|tab|enter|space|backspace|delete|escape|[`\-=[\]\\;',./])$/;

export function normalizeChord(input: string): string | null {
  const parts = input.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.pop()!;
  const mods = [...new Set(parts.map((part) => (part === "meta" || part === "super" ? "cmd" : part)))];
  if (!mods.every((mod) => MODS.includes(mod)) || !KEY_PATTERN.test(key)) return null;
  return [...MODS.filter((mod) => mods.includes(mod)), key].join("+");
}

function applyDecisions(provider: ShortcutProvider, conflicts: ProviderConflict[], choices: Record<string, Decision>): void {
  const moves = conflicts
    .filter((conflict) => choices[conflict.editorId]?.choice === "terminal")
    .map((conflict) => {
      const decision = choices[conflict.editorId];
      return { trigger: conflict.trigger, to: decision.key, action: decision.action };
    });
  provider.apply(moves);
  saveDecisions({ version: 1, terminal: provider.id, choices });
  installKeybindings();
}

function say(text: string, style: (line: string) => string = (line) => line): void {
  process.stdout.write(`${wrap(text, "  ").map(style).join("\n")}\n`);
}

/** The rows the manager page shows, freshly derived from disk so the page can
 * simply re-render whatever comes back after a change. */
export function managerRows(
  provider: ShortcutProvider,
  choices: Record<string, Decision>,
): ManagerRow[] {
  const rows = provider.scan().map((conflict): ManagerRow => ({
    id: conflict.editorId,
    kind: "terminal",
    means: conflict.editor.means,
    detail: { command: conflict.editor.command, when: conflict.editor.guard },
    terminal: {
      name: provider.name,
      short: conflict.short,
      does: conflict.inTerminal,
      freed: conflict.freed,
      tradeoff: conflict.tradeoff,
      // every scanned conflict is bound sans tode; the staged decision is
      // what frees it, and the page derives the display from that
      bound: true,
    },
    decision: choices[conflict.editorId] ?? null,
  }));
  for (const imported of importedConflicts()) {
    rows.push({
      id: imported.key,
      kind: "import",
      // quit is tode's own idea, named as such; every other builtin's label
      // derives from the command it runs
      means: imported.key === QUIT_CHORD ? "quit tode" : words(imported.builtin),
      terminal: { name: provider.name, short: "", does: "", freed: "", tradeoff: "", bound: true },
      importedCommand: imported.command,
      claimant: imported.claimant,
      claimDescribes: imported.describes,
      claimDecision: choices[`claim:${imported.key}`] ?? null,
      decision: choices[`import:${imported.key}`] ?? null,
    });
  }
  return rows;
}

/** The interactive manager is a web page in this very pane: terminal-browser
 * renders it, the page talks to a local server, and decisions stage in
 * memory until the confirm screen writes them — q discards. */
/** Sentinel exit: the user applied, so the caller should boot tode. */
export const BOOT_AFTER_APPLY = 100;

async function runManager(
  provider: ShortcutProvider,
  intro = false,
): Promise<{ code: number; confirmed: boolean; reloadedLive: boolean; served: boolean }> {
  const { palette } = await readPalette();
  const staged: Record<string, Decision> = { ...(loadDecisions()?.choices ?? {}) };
  let confirmed = false;
  let reloadedLive = false;
  // every row is a step, decided or not — the manager always opens on step
  // one, with earlier decisions prefilled rather than hidden
  const manager = await startManager({
    rows: () => managerRows(provider, staged),
    taken: (chord) => {
      const terminal = provider.takenAs(chord);
      if (terminal) return { holder: `${terminal} (${provider.name})` };
      const imported = importedHolder(chord);
      if (imported) return { holder: `${imported} (imported)` };
      // tode's own builtins hold their chords the same way any claimant does
      const builtin = builtinKeybindings().find(
        (bind) => !!bind.key && normalizeChord(bind.key) === chord,
      );
      if (builtin) return { holder: `${builtin.command} (tode)` };
      // a chord a staged claim-move already parked a command on is taken too
      for (const [id, decision] of Object.entries(staged)) {
        if (
          id.startsWith("claim:") &&
          decision.choice === "terminal" &&
          decision.key === chord &&
          decision.action
        ) {
          return { holder: `${decision.action} (moved here this session)` };
        }
      }
      const held = extensionHolder(chord);
      if (!held) return null;
      // unset or moved earlier in this session: the chord is effectively free
      if (staged[`claim:${chord}`]?.choice === "terminal") return null;
      return {
        holder: `${held.command} (${held.claimant})`,
        claim: {
          chord,
          command: held.command,
          claimant: held.claimant,
          describes: held.describes,
          when: held.when,
        },
      };
    },
    normalize: normalizeChord,
    decide: (id, kind, decision, side) => {
      const claim = kind === "claim" || side === "claim";
      const key = claim ? `claim:${id}` : kind === "import" ? `import:${id}` : id;
      if (decision === null) {
        delete staged[key];
        return;
      }
      if (kind === "import" && decision.choice === "editor") {
        // the builtin command the moved chord should carry rides on the
        // decision, the same way a terminal row's editor move stages its own
        decision.command =
          builtinKeybindings().find((bind) => !!bind.key && normalizeChord(bind.key) === id)
            ?.command ?? staged[key]?.command;
      }
      if (kind === "terminal") {
        const conflict = provider.scan().find((entry) => entry.editorId === id);
        if (decision.choice === "terminal") {
          // a move needs the action the trigger runs today; keep whatever a
          // previous decision already learned when the scan no longer knows
          decision.action = conflict?.current ?? staged[key]?.action;
        }
        if (decision.choice === "editor") {
          // the command the editor side should carry rides on the decision
          // itself, staged from the conflict when the choice is made
          decision.command = conflict?.editor.command ?? staged[key]?.command;
        }
      }
      if (claim) {
        // the removal entry needs the command, a remap also needs its guard
        const held = extensionHolder(id);
        decision.action = held?.command ?? staged[key]?.action;
        decision.guard = held?.when ?? staged[key]?.guard;
      }
      staged[key] = decision;
    },
    confirm: () => {
      confirmed = true;
      applyDecisions(provider, provider.scan(), staged);
      reloadedLive = provider.onApplied();
      return { note: reloadedLive ? "applied" : `applied — ${provider.reloadHint()}` };
    },
    reloadHint: provider.reloadHint(),
    terminalName: provider.name,
    palette,
    intro,
  });
  const runtime = await resolveRuntimeWithProgress();
  const flags = supportedFlags(runtime);
  const child = spawn(
    runtime.bin,
    [
      "open",
      `http://127.0.0.1:${manager.port}`,
      flags.has("--app-mode") ? "--app-mode" : "--chromeless",
      // the page has its own keys; the browser's must not sit in front of them
      ...(flags.has("--no-shortcuts") ? ["--no-shortcuts"] : []),
    ],
    { stdio: "inherit" },
  );
  void manager.done.then(() => child.kill("SIGTERM"));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`could not start terminal-browser: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (exit) => resolve(exit ?? 0));
  });
  manager.close();
  const served = manager.served();
  if (!served) {
    process.stderr.write(
      `tode: the shortcuts wizard never reached the screen (terminal-browser exited ${code})\n`,
    );
  }
  return { code, confirmed, reloadedLive, served };
}

const INTRO_MARKER = path.join(DATA_DIR, "shortcuts-intro");

/** Written whenever the manager has been on screen — the first open must not
 * repeat a wizard the user just walked, whichever door they came in by. */
function markIntroShown(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INTRO_MARKER, `${new Date().toISOString()}\n`);
  } catch {}
}

/** The first open shows the conflicts before the editor: a chord that
 * silently does the wrong thing on day one costs more trust than one setup
 * screen. Shown once — the marker also lands when there was nothing to show,
 * and tode shortcuts reruns the manager any time. */
export async function firstRunShortcuts(): Promise<void> {
  if (fs.existsSync(INTRO_MARKER)) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const provider = providerFor();
  if (!provider || provider.ready() !== null) return;
  try {
    if (provider.scan().length === 0 && importedConflicts().length === 0) {
      markIntroShown();
      return;
    }
  } catch {
    return;
  }
  const { served } = await runManager(provider, true);
  // a wizard that never made it onto the screen was not shown: leave the
  // marker off so the next open tries again rather than skipping forever
  if (served) markIntroShown();
}

export async function shortcutsCommand(args: string[]): Promise<number> {
  const provider = providerFor();
  if (!provider) {
    process.stdout.write(
      `the shortcut wizard knows ${providerNames().join(", ")} — this terminal is something else\n`,
    );
    return 0;
  }

  if (args.includes("--undo")) {
    const hadDecisions = loadDecisions() !== null;
    const undone = provider.undo();
    clearDecisions();
    installKeybindings();
    const reloaded = undone && provider.onApplied();
    process.stdout.write(
      undone || hadDecisions
        ? `removed tode's ${provider.name} overrides and editor chords\n${reloaded ? "" : `${provider.reloadHint()}\n`}`
        : "nothing to undo\n",
    );
    return 0;
  }

  const notReady = provider.ready();
  if (notReady) {
    process.stdout.write(`${notReady}\n`);
    return 1;
  }

  const conflicts = provider.scan();
  const imported = importedConflicts();
  if (conflicts.length === 0 && imported.length === 0) {
    process.stdout.write(`${provider.name} already leaves every chord the editor needs alone\n`);
    return 0;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("run tode shortcuts on a terminal to decide these interactively\n");
    return 0;
  }

  // with everything already decided the stepper has nothing to show, so the
  // manager opens straight on the final table, ready for inline edits
  const { code, confirmed, reloadedLive, served } = await runManager(provider);
  // the manager was just on screen, so the first open must not show it again
  if (served) markIntroShown();
  if (confirmed) {
    // applying means done managing — boot straight into the editor
    if (!reloadedLive) say(provider.reloadHint(), dim);
    return BOOT_AFTER_APPLY;
  }
  // closing without applying needs no recap — tode shortcuts --status has it
  return code;
}

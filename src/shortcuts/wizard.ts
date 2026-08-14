import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { codeServerBin } from "../codeserver/server";
import { EXTENSIONS_DIR, VSCODE_DIR, installKeybindings, readPalette } from "../profile";
import { DATA_DIR } from "../runtime/paths";
import { resolveRuntimeWithProgress, supportedFlags } from "../runtime/release";
import { CHORD_GROUPS, EDITOR_CHORDS, editorChord } from "./catalog";
import { VIM_EXTENSIONS, extensionHolder, importedHolder, importedQuitConflict } from "./imported";
import { wrap } from "./prompt";
import { providerFor, providerNames } from "./provider";
import type { ProviderConflict, ShortcutProvider } from "./provider";
import { CLAIM_DECISION_ID, IMPORT_DECISION_ID, QUIT_CHORD, clearDecisions, loadDecisions, saveDecisions } from "./store";
import type { Decision } from "./store";
import { startManager } from "./web";
import type { ManagerRow, ManagerStep } from "./web";

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
  const rows = provider
    .scan()
    // quit has one chord per platform; the other platform's row is not a
    // conflict here
    .filter((conflict) => {
      const isQuitRow = conflict.editorId === "ctrl+q" || conflict.editorId === "ctrl+c";
      return !isQuitRow || conflict.editorId === QUIT_CHORD;
    })
    .map((conflict): ManagerRow => {
    // a derived conflict carries its own editor side; catalog rows look it up
    const chord = conflict.editor ?? editorChord(conflict.editorId);
    return {
      id: conflict.editorId,
      kind: "terminal",
      means: chord.means,
      suggestion: chord.suggestion,
      recommend: chord.recommend,
      group: conflict.editor ? undefined : editorChord(conflict.editorId).group,
      detail: conflict.editor?.detail,
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
    };
  });
  const imported = importedQuitConflict();
  if (imported) {
    const chord = editorChord(QUIT_CHORD);
    rows.push({
      id: QUIT_CHORD,
      kind: "import",
      means: chord.means,
      suggestion: chord.suggestion,
      recommend: "editor",
      terminal: { name: provider.name, short: "", does: "", freed: "", tradeoff: "", bound: true },
      importedCommand: imported.command,
      claimant: imported.claimant,
      claimDescribes: imported.describes,
      claimDecision: choices[CLAIM_DECISION_ID] ?? null,
      decision: choices[IMPORT_DECISION_ID] ?? null,
    });
  }
  return rows;
}

function vimInstalled(): boolean {
  try {
    const listed = JSON.parse(
      fs.readFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), "utf8"),
    ) as { identifier?: { id?: string } }[];
    return listed.some((entry) => VIM_EXTENSIONS.includes(entry.identifier?.id ?? ""));
  } catch {
    return false;
  }
}

function installExtension(id: string): boolean {
  const result = spawnSync(
    codeServerBin(),
    [
      "--install-extension",
      id,
      "--extensions-dir",
      EXTENSIONS_DIR,
      "--user-data-dir",
      path.join(VSCODE_DIR, "user-data"),
    ],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

/** The manager's screens, in order: single conflicts, then the catalog's
 * groups (related chords decided together), then whatever custom steps this
 * backend wants to offer. The page renders kinds; this composes them. */
export function managerSteps(
  provider: ShortcutProvider,
  choices: Record<string, Decision>,
  dismissed: Set<string>,
  visible?: Set<string>,
): ManagerStep[] {
  const steps: ManagerStep[] = [];
  const groups = new Map<string, ManagerRow[]>();
  for (const row of managerRows(provider, choices)) {
    // rows decided in an earlier session stay hidden; the set is fixed when
    // the manager opens, so deciding a row mid-session never shifts the steps
    if (visible && !visible.has(row.id)) continue;
    const group = row.group;
    if (!group || !CHORD_GROUPS[group]) {
      steps.push({ kind: "conflict", row });
      continue;
    }
    let members = groups.get(group);
    if (!members) {
      members = [];
      groups.set(group, members);
      steps.push({
        kind: "group",
        id: `group:${group}`,
        title: CHORD_GROUPS[group].title,
        rows: members,
      });
    }
    members.push(row);
  }
  if (!dismissed.has("vim") && !vimInstalled()) {
    steps.push({
      kind: "custom",
      id: "vim",
      title: "vim keybindings",
      body:
        "No vim extension is installed. tode can install vscodevim, so vim motions work " +
        "in the editor and closing the last tab with :q quits tode, the way vim would.",
      actions: [
        { id: "install", label: "install vscodevim" },
        { id: "skip", label: "skip" },
      ],
    });
  }
  return steps;
}

/** Group actions stage a decision for every member; custom steps do their own
 * work. Everything stays in memory until the confirm screen writes it. */
export function performStepAction(
  provider: ShortcutProvider,
  choices: Record<string, Decision>,
  dismissed: Set<string>,
  stepId: string,
  actionId: string,
): { note?: string } {
  if (stepId === "vim") {
    if (actionId === "install") {
      if (!installExtension("vscodevim.vim")) {
        return { note: "install failed — try: tode --install-extension vscodevim.vim" };
      }
      dismissed.add("vim");
      return { note: "vscodevim installed — it activates on the next tode open" };
    }
    dismissed.add("vim");
    return {};
  }
  return {};
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
  const dismissed = new Set<string>();
  let confirmed = false;
  let reloadedLive = false;
  // every row is a step, decided or not — the manager always opens on step
  // one, with earlier decisions prefilled rather than hidden
  const manager = await startManager({
    steps: () => managerSteps(provider, staged, dismissed),
    allRows: () => managerRows(provider, staged),
    taken: (chord) => {
      const terminal = provider.takenAs(chord);
      if (terminal) return { holder: `${terminal} (${provider.name})` };
      const imported = importedHolder(chord);
      if (imported) return { holder: `${imported} (imported)` };
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
      const key = claim ? `claim:${id}` : kind === "import" ? IMPORT_DECISION_ID : id;
      if (decision === null) {
        delete staged[key];
        return;
      }
      if (kind === "terminal") {
        const conflict = provider.scan().find((entry) => entry.editorId === id);
        if (decision.choice === "terminal") {
          // a move needs the action the trigger runs today; keep whatever a
          // previous decision already learned when the scan no longer knows
          decision.action = conflict?.current ?? staged[key]?.action;
        }
        if (decision.choice === "editor") {
          // derived rows are not in the catalog, so the command the editor
          // side should carry rides on the decision itself
          decision.command = conflict?.editor?.command ?? staged[key]?.command;
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
    act: (stepId, actionId) => performStepAction(provider, staged, dismissed, stepId, actionId),
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
    if (provider.scan().length === 0 && !importedQuitConflict()) {
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
  const imported = importedQuitConflict();
  if (conflicts.length === 0 && !imported) {
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

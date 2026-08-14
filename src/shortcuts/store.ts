import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../runtime/paths";
import { EDITOR_CHORDS } from "./catalog";

/** Where a chord should live: freed in the terminal, carried by another chord
 * on the editor side, or left exactly as it is. An editor decision remembers
 * which chord carries it, since it can be the suggestion or the user's own. */
export interface Decision {
  choice: "terminal" | "editor" | "keep";
  key?: string;
  /** For a terminal or claimant move: what the chord ran, so the rebind can
   * carry it. */
  action?: string;
  /** For a claimant move: the binding's original when clause, carried along. */
  guard?: string;
  /** For an editor move on a derived conflict — one the catalog does not
   * know — the editor command the new chord should run. */
  command?: string;
}

export interface Decisions {
  version: 1;
  terminal: string;
  choices: Record<string, Decision>;
}

const DECISIONS_FILE = path.join(DATA_DIR, "shortcuts.json");

export function loadDecisions(): Decisions | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8")) as Decisions;
    return parsed && parsed.version === 1 && parsed.choices ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDecisions(decisions: Decisions): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DECISIONS_FILE, `${JSON.stringify(decisions, null, 2)}\n`);
}

export function clearDecisions(): void {
  fs.rmSync(DECISIONS_FILE, { force: true });
}

/** Where quitting lives, per platform. On macOS ctrl+c is free — copy is
 * cmd+c — and it is the terminal reflex for "make it stop", so it quits
 * (behind a confirm). On linux ctrl+c is canonically copy, so quit sits on
 * ctrl+q and ctrl+c only redirects. */
export const QUIT_CHORD = process.platform === "darwin" ? "ctrl+c" : "ctrl+q";

/** The decision for the quit chord an *import* took, keyed apart from the
 * terminal conflict on the same chord so deciding one never erases the other. */
export const IMPORT_DECISION_ID = `import:${QUIT_CHORD}`;

/** The decision about the *claimant's* side of that chord — an extension's
 * own binding, unset or moved through vscode's user-level removal entries. */
export const CLAIM_DECISION_ID = `claim:${QUIT_CHORD}`;

/** vscode removes a specific rule when a user entry names the same key with
 * the command negated — its own documented mechanism, so unsetting or moving
 * an extension's binding never touches the extension. Claim decisions exist
 * per chord ("claim:<chord>"), because any capture can run into any
 * extension's binding. */
export function claimBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const out: { key: string; command: string; when?: string }[] = [];
  for (const [id, decision] of Object.entries(choices)) {
    if (!id.startsWith("claim:")) continue;
    if (decision.choice !== "terminal" || !decision.action) continue;
    const chord = id.slice("claim:".length);
    out.push({ key: chord, command: `-${decision.action}` });
    if (decision.key) out.push({ key: decision.key, command: decision.action, when: decision.guard });
  }
  return out;
}

/** The binding an import decision asks for. Written after the imported
 * entries — vscode resolves keybindings.json bottom-up, last match wins — and
 * that ordering is the entire mechanism: nothing of the user's is edited or
 * removed for tode's chord to win. */
export function overrideBindings(): { key: string; command: string; when?: string }[] {
  const decision = loadDecisions()?.choices[IMPORT_DECISION_ID];
  if (decision?.choice !== "editor" || !decision.key) return [];
  const quit = EDITOR_CHORDS.find((chord) => chord.id === QUIT_CHORD);
  if (!quit) return [];
  return [{ key: decision.key, command: quit.command, when: quit.when }];
}

/** Where the ctrl+c hint may fire: never in the terminal, never over a
 * selection or an input box — and never where a vim extension is actually
 * using ctrl+c. vscodevim needs it in insert mode (it is escape there), but
 * in normal mode it does nothing worth keeping, which is exactly where a
 * stray "I want to quit" ctrl+c happens. The context keys evaluate falsy
 * when no vim extension is installed, so the !vim.active branch keeps the
 * hint alive for everyone else. */
export const HINT_WHEN =
  // inputFocus is true inside the editor too, so it must not veto editor
  // focus — only genuine input boxes (inputFocus without editorTextFocus)
  "!terminalFocus && !editorHasSelection && (!inputFocus || editorTextFocus) && " +
  "(vim.mode == 'Normal' || !vim.active) && neovim.mode != 'insert'";

/** The redirect hint exists only where ctrl+c is not itself the quit chord
 * (linux). It also lives at user level, above vscodevim's own ctrl+c. */
export function hintBindings(): { key: string; command: string; when: string }[] {
  if (QUIT_CHORD === "ctrl+c") return [];
  return [{ key: "ctrl+c", command: "tode.quitHint", when: HINT_WHEN }];
}

/** tode's quit chord written at user level, because extension keybindings
 * cannot be trusted to lose: vscodevim contributes ctrl+q for visual block
 * mode and shadows the bridge's own binding under editor focus. User
 * keybindings outrank every extension, so this one always wins — unless a
 * wizard decision moved quit elsewhere (the fallback carries it then) or
 * surrendered it on purpose. */
export function quitBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const decision = choices[IMPORT_DECISION_ID] ?? choices[QUIT_CHORD];
  if (decision?.choice === "editor" || decision?.choice === "keep") return [];
  // quitting always asks first; on macOS the chord doubles as the reflex
  // ctrl+c, so it carries the same guards the hint would
  return [
    {
      key: QUIT_CHORD,
      command: "tode.confirmQuit",
      when: QUIT_CHORD === "ctrl+c" ? HINT_WHEN : "!terminalFocus",
    },
  ];
}

/** The keybindings the "editor" choices ask for, ready for keybindings.json.
 * Read at profile-install time, so a re-run of the wizard lands on the next
 * open without any other coordination. */
export function fallbackBindings(): { key: string; command: string; when?: string }[] {
  const decisions = loadDecisions();
  if (!decisions) return [];
  const catalog = EDITOR_CHORDS.flatMap((chord) => {
    const decision = decisions.choices[chord.id];
    const key = decision?.choice === "editor" ? decision.key ?? chord.suggestion : undefined;
    if (!key) return [];
    return [{ key, command: chord.command, when: chord.when }];
  });
  // derived conflicts are not in the catalog; their editor command was staged
  // on the decision itself when it was made
  const derived = Object.entries(decisions.choices).flatMap(([id, decision]) => {
    if (id.startsWith("claim:") || id.startsWith("import:")) return [];
    if (EDITOR_CHORDS.some((chord) => chord.id === id)) return [];
    if (decision.choice !== "editor" || !decision.key || !decision.command) return [];
    return [{ key: decision.key, command: decision.command, when: "!terminalFocus" }];
  });
  return [...catalog, ...derived];
}

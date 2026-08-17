import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../runtime/paths";
import { extensionClaims } from "./imported";

/** Where a chord should live: freed in the terminal, carried by another chord
 * on the editor side, or left exactly as it is. An editor decision remembers
 * which chord carries it. */
export interface Decision {
  choice: "terminal" | "editor" | "keep";
  key?: string;
  /** For a terminal or claimant move: what the chord ran, so the rebind can
   * carry it. */
  action?: string;
  /** For a claimant move: the binding's original when clause, carried along. */
  guard?: string;
  /** For an editor move: the editor command the new chord should run, staged
   * from the conflict when the decision was made. */
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

/** What the quit chord runs, wherever a decision carries it. Quitting always
 * asks first. */
export const QUIT_COMMAND = "tode.confirmQuit";

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

/** The bindings the import decisions ask for. Written after the imported
 * entries — vscode resolves keybindings.json bottom-up, last match wins — and
 * that ordering is the entire mechanism: nothing of the user's is edited or
 * removed for tode's chord to win. Import decisions exist per builtin chord
 * ("import:<chord>"); the command each carries was staged when it was made,
 * with the quit chord's known without one for decisions saved before that. */
export function overrideBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const out: { key: string; command: string; when?: string }[] = [];
  for (const [id, decision] of Object.entries(choices)) {
    if (!id.startsWith("import:")) continue;
    if (decision.choice !== "editor" || !decision.key) continue;
    const command = decision.command ?? (id === IMPORT_DECISION_ID ? QUIT_COMMAND : null);
    if (!command) continue;
    out.push({ key: decision.key, command, when: "!terminalFocus" });
  }
  return out;
}

/** Where tode's ctrl+c bindings may fire at all: never in the terminal, never
 * over a selection or an input box. inputFocus is true inside the editor too,
 * so it must not veto editor focus — only genuine input boxes (inputFocus
 * without editorTextFocus). */
const HINT_BASE = "!terminalFocus && !editorHasSelection && (!inputFocus || editorTextFocus)";

/** `base`, minus every context an installed extension declared for its own
 * binding on the chord. tode's bindings live at user level and outrank any
 * extension's, so this is how an extension keeps a chord it uses: its own
 * when clause says exactly where the chord means something to it, and tode
 * steps aside there — whichever extension it is. */
export function carvedWhen(base: string | undefined, chord: string): string | undefined {
  const carved = new Set(
    extensionClaims(chord)
      .filter((claim) => claim.when)
      .map((claim) => `!(${claim.when})`),
  );
  const parts = [...(base ? [base] : []), ...carved];
  return parts.length ? parts.join(" && ") : undefined;
}

/** The guard on tode's own quit binding. On macOS the quit chord doubles as
 * the reflex ctrl+c, so it also carries the hint's contexts. */
export function quitWhen(): string {
  return carvedWhen(QUIT_CHORD === "ctrl+c" ? HINT_BASE : "!terminalFocus", QUIT_CHORD)!;
}

/** The guard on the ctrl+c redirect hint, where ctrl+c is not itself quit. */
export function hintWhen(): string {
  return carvedWhen(HINT_BASE, "ctrl+c")!;
}

/** The redirect hint exists only where ctrl+c is not itself the quit chord
 * (linux). It also lives at user level, above any extension's own ctrl+c. */
export function hintBindings(): { key: string; command: string; when: string }[] {
  if (QUIT_CHORD === "ctrl+c") return [];
  return [{ key: "ctrl+c", command: "tode.quitHint", when: hintWhen() }];
}

/** tode's quit chord written at user level, because extension keybindings
 * cannot be trusted to lose under editor focus. User keybindings outrank
 * every extension, so this one always wins inside its guard — unless a
 * wizard decision moved quit elsewhere (the fallback carries it then) or
 * surrendered it on purpose. */
export function quitBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const decision = choices[IMPORT_DECISION_ID] ?? choices[QUIT_CHORD];
  if (decision?.choice === "editor" || decision?.choice === "keep") return [];
  return [{ key: QUIT_CHORD, command: QUIT_COMMAND, when: quitWhen() }];
}

/** The keybindings the "editor" choices ask for, ready for keybindings.json.
 * Each decision staged the command its chord should run when it was made.
 * Read at profile-install time, so a re-run of the wizard lands on the next
 * open without any other coordination. */
export function fallbackBindings(): { key: string; command: string; when?: string }[] {
  const decisions = loadDecisions();
  if (!decisions) return [];
  return Object.entries(decisions.choices).flatMap(([id, decision]) => {
    if (id.startsWith("claim:") || id.startsWith("import:")) return [];
    if (decision.choice !== "editor" || !decision.key || !decision.command) return [];
    return [{ key: decision.key, command: decision.command, when: "!terminalFocus" }];
  });
}

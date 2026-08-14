import { ghosttyProvider } from "./ghostty";

/** One chord this terminal stands in front of. `current` is what the terminal
 * does with it right now, or null when tode already freed it — freed chords
 * stay visible so a re-run of the wizard can hand them back. */
export interface ProviderConflict {
  editorId: string;
  /** The chord in this terminal's own config syntax. */
  trigger: string;
  current: string | null;
  /** The editor's side of a conflict the provider derived itself — from the
   * live terminal binds intersected with what the workbench actually binds —
   * rather than one the hand-written catalog knows. Absent for catalog rows. */
  editor?: {
    means: string;
    command: string;
    when?: string;
    recommend: "terminal" | "editor" | "keep";
    suggestion?: string;
    /** The command id and source guard the auto-label was derived from. */
    detail?: string;
  };
  inTerminal: string;
  /** The same as inTerminal but as a two-or-three word verb phrase, short
   * enough to sit inside a one-line option label. */
  short: string;
  /** Terminal life after the chord is freed, equally short: what replaces the
   * old action, or what still covers it. */
  freed: string;
  /** What freeing the chord costs, in this terminal's terms. */
  tradeoff: string;
}

/** One freed chord: the trigger to unbind, and optionally the chord (editor
 * syntax) that should carry the same action instead. */
export interface FreedMove {
  trigger: string;
  to?: string;
  action?: string;
  /** Frees by rebinding the trigger to emit these bytes instead of unbinding.
   * On macOS a plain unbind hands some chords to the OS menu layer; a bound
   * trigger stays ghostty's, and the bytes carry the chord to the terminal. */
  emit?: string;
}

/** A terminal the wizard knows how to configure. Each implementation owns one
 * terminal completely: reading what it binds, describing the tradeoffs, and
 * editing its config without touching anything the user wrote. */
export interface ShortcutProvider {
  id: string;
  name: string;
  detect(env: NodeJS.ProcessEnv): boolean;
  /** A reason this terminal cannot be configured right now, or null when it can. */
  ready(): string | null;
  scan(): ProviderConflict[];
  /** What this terminal currently does with an editor-syntax chord ("ctrl+shift+w"),
   * or null when it lets it through. The wizard uses this to vouch for a suggested
   * chord and to warn when a typed one is already taken. */
  takenAs(chord: string): string | null;
  /** Makes `moves` exactly the set tode frees or moves — an empty list undoes everything. */
  apply(moves: FreedMove[]): string;
  /** Called once the apply (or undo) has landed on disk. Returns true when
   * the terminal reloaded itself live, so no manual reload is needed. */
  onApplied(): boolean;
  undo(): boolean;
  reloadHint(): string;
}

const PROVIDERS: ShortcutProvider[] = [ghosttyProvider];

export function providerFor(env: NodeJS.ProcessEnv = process.env): ShortcutProvider | null {
  return PROVIDERS.find((provider) => provider.detect(env)) ?? null;
}

export function providerNames(): string[] {
  return PROVIDERS.map((provider) => provider.name);
}

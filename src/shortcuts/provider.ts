import { ghosttyProvider } from "./backends/ghostty";
import { kittyProvider } from "./backends/kitty";
/**
 * this API is pretty awful and subject to very large change
 */

export interface EditorHold {
  command: string;
  guard?: string;
  claimant?: string;
  describes?: string;
}

export interface ProviderConflict {
  editorId: string;
  trigger: string;
  current: string | null;
  editor: {
    means: string;
    command: string;
    guard?: string;
  };
  others: EditorHold[];
  inTerminal: string;
  short: string;
  freed: string;
  tradeoff: string;
  shared?: { action: string; note: string };
}

export interface FreedMove {
  trigger: string;
  to?: string;
  action?: string;
  emit?: string;
}

export interface ShortcutProvider {
  id: string;
  name: string;
  detect(env: NodeJS.ProcessEnv): boolean;
  ready(): string | null;
  scan(): ProviderConflict[];
  takenAs(chord: string): string | null;
  trigger(chord: string): string;
  describe(action: string): string;
  apply(moves: FreedMove[]): string;
  onApplied(): boolean;
  undo(): boolean;
  reloadHint(): string;
}

const PROVIDERS: ShortcutProvider[] = [ghosttyProvider, kittyProvider];

export function providerFor(env: NodeJS.ProcessEnv = process.env): ShortcutProvider | null {
  return PROVIDERS.find((provider) => provider.detect(env)) ?? null;
}

export function providerNames(): string[] {
  return PROVIDERS.map((provider) => provider.name);
}

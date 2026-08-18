import { importFirstRunStage } from "./import/firstrun";
import type { Pane } from "./launch";
import { shortcutsFirstRunStage } from "./shortcuts/wizard";
import type { TerminalPalette } from "./terminal/osc";

export interface OnboardStage {
  url: string;
  done: Promise<void>;
  served(): boolean;
  close(): void;
  shown(): void;
}

export async function runOnboarding(
  pane: Pane,
  finalize: () => Promise<string>,
  palette?: TerminalPalette,
): Promise<void> {
  let shortcuts: OnboardStage | null | undefined;
  const shortcutsStage = async () => {
    if (shortcuts === undefined) shortcuts = await shortcutsFirstRunStage(finalize, palette);
    return shortcuts;
  };
  const afterImport = async () => (await shortcutsStage())?.url ?? finalize();

  const importStage = await importFirstRunStage(afterImport, palette);
  const first = importStage ?? (await shortcutsStage());
  if (!first) return;

  pane.open(first.url);
  const walk = async (stage: OnboardStage) => {
    await Promise.race([stage.done, pane.exited()]);
    if (stage.served()) stage.shown();
    stage.close();
  };
  await walk(first);
  if (importStage && shortcuts) await walk(shortcuts);
}

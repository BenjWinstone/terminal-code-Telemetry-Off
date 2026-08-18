import { importFirstRunStage } from "./import/firstrun";
import type { Pane } from "./launch";
import { shortcutsFirstRunStage } from "./shortcuts/wizard";

/** One first-run screen: a local page server whose /done response hands the
 * page the next url to navigate to. */
export interface OnboardStage {
  url: string;
  /** resolves when the page posted /done, after its next url went out */
  done: Promise<void>;
  served(): boolean;
  close(): void;
  /** record the screen as shown, so the next open skips it */
  shown(): void;
}

/** The first-run screens, one browser for all of them: import, then the
 * shortcut wizard, then the editor. Every transition is a navigation the page
 * performs inside the one pane — never a respawn, which would drop the
 * terminal to its primary buffer between screens and flash. */
export async function runOnboarding(pane: Pane, finalize: () => Promise<string>): Promise<void> {
  // the shortcut stage is built lazily, after the import stage finished, so
  // its scan sees whatever keybindings the import just brought over
  let shortcuts: OnboardStage | null | undefined;
  const shortcutsStage = async () => {
    if (shortcuts === undefined) shortcuts = await shortcutsFirstRunStage(finalize);
    return shortcuts;
  };
  const afterImport = async () => (await shortcutsStage())?.url ?? finalize();

  const importStage = await importFirstRunStage(afterImport);
  const first = importStage ?? (await shortcutsStage());
  if (!first) return;

  pane.open(first.url);
  const walk = async (stage: OnboardStage) => {
    // the pane closing mid-screen ends the walk; nothing is left to wait for
    await Promise.race([stage.done, pane.exited()]);
    if (stage.served()) stage.shown();
    stage.close();
  };
  await walk(first);
  if (importStage && shortcuts) await walk(shortcuts);
}

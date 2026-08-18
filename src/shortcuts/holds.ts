import type { Binding } from "../profile";
import {
  claimBindings,
  overrideBindings,
} from "./store";
import { foreignBindings, removalMasked, todeKeybindings } from "../profile";
import { extensionClaims } from "./imported";
import type { EditorHold } from "./provider";
import { canonicalChord, defaultBinding } from "./vscode-keymap";
import { words } from "./words";

export function makeEditorHolds(): (chord: string) => EditorHold[] {
  const own = new Map<string, EditorHold[]>();
  const record = (binding: Binding, claimant: string) => {
    if (!binding.key || !binding.command || binding.command.startsWith("-")) return;
    if (removalMasked(binding.key, binding.command)) return;
    const chord = canonicalChord(binding.key);
    const list = own.get(chord) ?? [];
    list.push({ command: binding.command, guard: binding.when, claimant });
    own.set(chord, list);
  };
  for (const binding of foreignBindings()) record(binding, "imported");
  for (const binding of todeKeybindings() as Binding[]) record(binding, "terminal-code");
  for (const binding of overrideBindings()) record(binding, "terminal-code");
  for (const binding of claimBindings()) record(binding, "terminal-code");
  return (chord) => {
    const held: EditorHold[] = [...(own.get(canonicalChord(chord)) ?? [])];
    for (const claim of extensionClaims(chord)) {
      held.push({
        command: claim.command,
        guard: claim.when,
        claimant: claim.claimant,
        describes: claim.describes,
      });
    }
    const fallback = defaultBinding(chord);
    if (fallback && !removalMasked(chord, fallback.command)) {
      held.push({ command: fallback.command, guard: fallback.when, claimant: "terminal-code" });
    }
    const seen = new Set<string>();
    const unique = held.filter((hold) =>
      seen.has(hold.command) ? false : (seen.add(hold.command), true),
    );
    return [...unique.filter((hold) => !hold.guard), ...unique.filter((hold) => !!hold.guard)];
  };
}

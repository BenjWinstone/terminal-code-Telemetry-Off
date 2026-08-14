/** The chords the editor wants, independent of any terminal. A terminal module
 * maps these ids onto its own trigger syntax and reports which ones it is
 * currently consuming; the wizard offers each side as a way out. */
export interface EditorChord {
  id: string;
  means: string;
  /** What an editor-side binding runs, whichever chord ends up carrying it. */
  command: string;
  when?: string;
  /** A suggested alternative chord for the editor side. Chosen to be free in
   * the editor's own keymap; the wizard also checks it against the terminal's
   * live binds before presenting it. Absent where every candidate belongs to
   * the shell, in which case the editor side is type-your-own only. */
  suggestion?: string;
  /** Where this chord serves people best by default. The wizard starts the
   * cursor here; nothing is applied without the user seeing it. */
  recommend: "terminal" | "editor" | "keep";
  /** Chords that belong to one habit are decided together on one screen,
   * keyed into CHORD_GROUPS. */
  group?: string;
}

export interface ChordGroup {
  title: string;
}

export const CHORD_GROUPS: Record<string, ChordGroup> = {
  "text-editing": { title: "text editing keybinds" },
};

export const EDITOR_CHORDS: EditorChord[] = [
  // quit has a chord per platform (ctrl+c on macOS, ctrl+q on linux); the
  // wizard shows only the one this machine uses
  {
    id: "ctrl+q",
    means: "quit tode",
    command: "tode.confirmQuit",
    when: "!terminalFocus",
    suggestion: "ctrl+shift+q",
    recommend: "terminal",
  },
  {
    id: "ctrl+c",
    means: "quit tode",
    command: "tode.confirmQuit",
    when: "!terminalFocus",
    suggestion: "ctrl+shift+q",
    recommend: "terminal",
  },
  {
    id: "cmd+w",
    means: "close the current editor tab",
    command: "workbench.action.closeActiveEditor",
    when: "!terminalFocus",
    suggestion: "ctrl+shift+w",
    // closing a pane is how a ghostty session ends on purpose; that muscle
    // memory is worth more than the tab-close chord, so the editor moves
    recommend: "editor",
  },
  {
    id: "cmd+z",
    means: "undo",
    command: "undo",
    when: "!terminalFocus",
    suggestion: "ctrl+z",
    recommend: "terminal",
  },
  {
    id: "cmd+shift+z",
    means: "redo",
    command: "redo",
    when: "!terminalFocus",
    suggestion: "ctrl+shift+z",
    recommend: "terminal",
  },
  {
    id: "cmd+shift+t",
    means: "reopen the last closed editor",
    command: "workbench.action.reopenClosedEditor",
    when: "!terminalFocus",
    suggestion: "ctrl+shift+t",
    recommend: "terminal",
  },
  {
    id: "cmd+a",
    means: "select all",
    command: "editor.action.selectAll",
    when: "!terminalFocus",
    recommend: "terminal",
  },
  // the linux side of the same habit: ghostty's linux defaults sit on
  // ctrl+shift chords, and new_tab is the one that shadows an editor chord.
  // The catalog is a superset — each platform's terminal table decides which
  // entries ever surface, so the extra id costs the other platform nothing.
  {
    id: "ctrl+shift+t",
    means: "reopen the last closed editor",
    command: "workbench.action.reopenClosedEditor",
    when: "!terminalFocus",
    // a new ghostty tab is worth more than the reopen chord, so the editor
    // side moves rather than the terminal's
    suggestion: "ctrl+alt+t",
    recommend: "editor",
  },
  {
    id: "cmd+backspace",
    group: "text-editing",
    means: "delete to the start of the line",
    command: "deleteAllLeft",
    when: "!terminalFocus",
    // the shell keeps ctrl+u for the same jump, the editor has no other chord
    recommend: "terminal",
  },
  {
    id: "cmd+left",
    group: "text-editing",
    means: "move to the start of the line",
    command: "cursorHome",
    when: "!terminalFocus",
    // home already does this in the editor and ctrl+a does at a shell prompt,
    // so both sides are covered without moving anything
    recommend: "keep",
  },
  {
    id: "cmd+right",
    group: "text-editing",
    means: "move to the end of the line",
    command: "cursorEnd",
    when: "!terminalFocus",
    recommend: "keep",
  },
];

export function editorChord(id: string): EditorChord {
  const found = EDITOR_CHORDS.find((chord) => chord.id === id);
  if (!found) throw new Error(`no editor chord ${id} in the catalog`);
  return found;
}

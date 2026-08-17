const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function freshRequire(name) {
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  return require(name);
}

test("ghostty keybinds parse from +list-keybinds output", () => {
  const { parseKeybinds } = require("../dist/shortcuts/ghostty.js");
  const table = parseKeybinds(
    [
      "keybind = super+w=close_surface",
      "keybind = super+z=undo",
      "keybind=super+a=select_all",
      "not a keybind line",
    ].join("\n"),
  );
  assert.equal(table.get("super+w"), "close_surface");
  assert.equal(table.get("super+a"), "select_all");
  assert.equal(table.size, 3);
});

test("freeing chords writes only tode's file and one include line, and undoes cleanly", () => {
  const { writeFreed, removeFreed, freedTriggers, withInclude, INCLUDE_LINE } = require("../dist/shortcuts/ghostty.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-ghostty-"));
  const configFile = path.join(dir, "config");
  const own = "font-size = 14\nkeybind = super+q=quit\n";
  fs.writeFileSync(configFile, own);
  try {
    writeFreed(dir, [{ trigger: "super+w" }, { trigger: "super+z" }]);
    assert.deepEqual([...freedTriggers(dir)].sort(), ["super+w", "super+z"]);
    assert.equal(fs.readFileSync(configFile, "utf8"), `${own}${INCLUDE_LINE}\n`);

    // the include line never doubles up
    assert.equal(withInclude(fs.readFileSync(configFile, "utf8")), `${own}${INCLUDE_LINE}\n`);

    // a smaller set replaces the file rather than growing it
    writeFreed(dir, [{ trigger: "super+w" }]);
    assert.deepEqual([...freedTriggers(dir)], ["super+w"]);

    // an empty set removes everything tode wrote, and the user's config survives
    writeFreed(dir, []);
    assert.equal(freedTriggers(dir).size, 0);
    assert.equal(fs.readFileSync(configFile, "utf8"), own);
    assert.equal(removeFreed(dir), false, "nothing left for undo to do");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only chords bound to something other than unbind or ignore are conflicts", () => {
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/ghostty.js");
  const holds = (chord) =>
    ({
      "cmd+backspace": { command: "deleteAllLeft" },
      "cmd+z": { command: "undo" },
      "cmd+w": { command: "workbench.action.closeActiveEditor" },
    })[chord] ?? null;
  const shipped = parseKeybinds(
    ["keybind = super+backspace=unbind", "keybind = super+z=ignore", "keybind = super+w=close_surface"].join("\n"),
  );
  const conflicts = allConflicts(shipped, new Set(), holds);
  assert.equal(conflicts.some((c) => c.trigger === "super+backspace"), false, "already unbound");
  assert.equal(conflicts.some((c) => c.trigger === "super+z"), false, "already ignored");
  assert.deepEqual(conflicts.map((c) => c.trigger), ["super+w"]);
});

test("a chord ghostty never bound at all is not a conflict", () => {
  const { allConflicts } = require("../dist/shortcuts/ghostty.js");
  assert.deepEqual(allConflicts(new Map(), new Set(), () => ({ command: "undo" })), []);
});

test("the exact regression: what ghostty 1.3.1 actually ships for these", () => {
  // pinned from `ghostty +list-keybinds --default` on 1.3.1, so a future ghostty
  // release that changes its defaults shows up here rather than silently.
  // The text: rewrites (cmd+left/right/backspace) are deliberately NOT
  // conflicts: they reach the editor as ctrl+a/ctrl+e/ctrl+u, which vscode's
  // mac keymap already understands, so the behaviour survives the rewrite.
  const { parseKeybinds, allConflicts } = require("../dist/shortcuts/ghostty.js");
  // what the mac workbench holds on these, keyed by canonical chord
  const holds = (chord) =>
    ({
      "cmd+z": { command: "undo" },
      "shift+cmd+z": { command: "redo" },
      "shift+cmd+t": { command: "workbench.action.reopenClosedEditor" },
      "cmd+a": { command: "editor.action.selectAll" },
      "cmd+w": { command: "workbench.action.closeActiveEditor" },
      "cmd+left": { command: "cursorHome" },
      "cmd+right": { command: "cursorEnd" },
      "cmd+backspace": { command: "deleteAllLeft" },
    })[chord] ?? null;
  const shipped = parseKeybinds([
    "keybind = super+arrow_right=text:\\\\x05",
    "keybind = super+arrow_left=text:\\\\x01",
    "keybind = super+backspace=text:\\\\x15",
    "keybind = super+z=undo",
    "keybind = super+shift+z=redo",
    "keybind = super+shift+t=undo",
    "keybind = super+a=select_all",
    "keybind = super+w=close_surface",
  ].join("\n"));
  const conflicts = allConflicts(shipped, new Set(), holds);
  assert.equal(conflicts.length, 5, "the action binds are flagged, the text rewrites are not");
  assert.ok(!conflicts.some((c) => c.trigger.includes("arrow") || c.trigger.includes("backspace")));
});

test("linux ghostty defaults: new_tab is the conflict, the ctrl+shift pairs are not", () => {
  // pinned from ghostty's linux defaults: ctrl+shift chords, with undo, redo,
  // select_all and quit unbound
  const { parseKeybinds, allConflicts } = require("../dist/shortcuts/ghostty.js");
  const holds = (chord) =>
    ({
      "ctrl+shift+t": { command: "workbench.action.reopenClosedEditor" },
      "ctrl+q": { command: "tode.confirmQuit" },
    })[chord] ?? null;
  const shipped = parseKeybinds([
    "keybind = ctrl+shift+t=new_tab",
    "keybind = ctrl+shift+w=close_surface",
    "keybind = ctrl+shift+c=copy_to_clipboard",
    "keybind = ctrl+shift+v=paste_from_clipboard",
  ].join("\n"));
  const conflicts = allConflicts(shipped, new Set(), holds);
  assert.deepEqual(conflicts.map((c) => c.trigger), ["ctrl+shift+t"], "only new_tab shadows an editor chord");

  // the quit chord surfaces only for someone whose own config bound it,
  // because tode's own quit binding is what the editor holds there
  const custom = parseKeybinds(["keybind = ctrl+q=quit"].join("\n"));
  const quit = allConflicts(custom, new Set(), holds);
  assert.deepEqual(quit.map((c) => c.trigger), ["ctrl+q"]);
  assert.equal(quit[0].editor.means, "confirm quit", "the label derives from the command id");
});

test("a move writes the unbind and the rebind, carrying the action", () => {
  const { keybindsFileContents } = require("../dist/shortcuts/ghostty.js");
  const contents = keybindsFileContents([
    { trigger: "super+w", to: "ctrl+alt+w", action: "close_surface" },
    { trigger: "super+z" },
  ]);
  assert.match(contents, /keybind = super\+w=unbind/);
  assert.match(contents, /keybind = ctrl\+alt\+w=close_surface/, "the action moves to the new trigger");
  assert.match(contents, /keybind = super\+z=unbind/);
  assert.ok(!contents.includes("undefined"), "a plain free adds no rebind line");
});

test("the include line survives a config with no trailing newline", () => {
  const { withInclude } = require("../dist/shortcuts/ghostty.js");
  const out = withInclude("window-save-state = always");
  assert.equal(out.split("\n").filter((l) => l.startsWith("config-file")).length, 1);
  assert.ok(out.includes("window-save-state = always\nconfig-file"), "must not run onto the same line");
});

test("typed chords normalize into mod order, or are rejected", () => {
  const { normalizeChord } = require("../dist/shortcuts/wizard.js");
  assert.equal(normalizeChord("alt+ctrl+W"), "ctrl+alt+w");
  assert.equal(normalizeChord("shift + ctrl + t"), "ctrl+shift+t");
  assert.equal(normalizeChord("super+left"), "cmd+left");
  assert.equal(normalizeChord("ctrl+f12"), "ctrl+f12");
  assert.equal(normalizeChord("w"), null, "a bare key is not a chord");
  assert.equal(normalizeChord("ctrl+"), null);
  assert.equal(normalizeChord("banana+w"), null);
  assert.equal(normalizeChord("ctrl+ww"), null);
});

test("the on-complete reload walks the ancestry to ghostty and signals it", () => {
  const { reloadGhostty } = require("../dist/shortcuts/ghostty.js");
  // this process (a node child of pid 500), whose parent 500 is ghostty
  const tree = {
    [process.pid]: { ppid: 500, command: "node" },
    500: { ppid: 10, command: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    10: { ppid: 1, command: "launchd" },
  };
  const signalled = [];
  const ok = reloadGhostty((pid) => tree[pid] ?? null, (pid) => signalled.push(pid));
  assert.equal(ok, true, "ghostty found in the ancestry gets the reload signal");
  assert.deepEqual(signalled, [500], "SIGUSR2 goes to the ghostty process itself");

  // no ghostty anywhere: nothing signalled, caller falls back to the hint
  const bare = { [process.pid]: { ppid: 500, command: "zsh" }, 500: { ppid: 1, command: "launchd" } };
  const none = [];
  assert.equal(reloadGhostty((pid) => bare[pid] ?? null, (pid) => none.push(pid)), false);
  assert.equal(none.length, 0);

  // a signal that fails (ghostty gone mid-walk) reports false, not a throw
  const failing = reloadGhostty((pid) => tree[pid] ?? null, () => { throw new Error("ESRCH"); });
  assert.equal(failing, false);
});

test("editor chords translate to ghostty trigger syntax", () => {
  const { toTrigger } = require("../dist/shortcuts/ghostty.js");
  assert.equal(toTrigger("cmd+w"), "super+w");
  assert.equal(toTrigger("cmd+left"), "super+arrow_left");
  assert.equal(toTrigger("ctrl+shift+w"), "ctrl+shift+w");
});

test("ghostty triggers translate back to editor chords, or to nothing", () => {
  const { fromTrigger, parseTrigger } = require("../dist/shortcuts/ghostty.js");
  assert.equal(fromTrigger("super+f"), "cmd+f");
  assert.equal(fromTrigger("super+shift+p"), "shift+cmd+p", "mods land in canonical order");
  assert.equal(fromTrigger("super+arrow_left"), "cmd+left");
  assert.equal(fromTrigger("super+page_up"), "cmd+pageup");
  assert.equal(fromTrigger("super+digit_1"), "cmd+1");
  assert.equal(fromTrigger("copy"), null, "media keys have no editor spelling");

  assert.deepEqual(parseTrigger("global:alt+t"), { trigger: "alt+t", passesThrough: false });
  assert.deepEqual(parseTrigger("performable:super+c"), { trigger: "super+c", passesThrough: true });
  assert.deepEqual(parseTrigger("global:unconsumed:ctrl+a"), { trigger: "ctrl+a", passesThrough: true });
});

test("chords canonicalise across spellings, and sequences count as their opener", () => {
  const { canonicalChord } = require("../dist/shortcuts/vscode-keymap.js");
  assert.equal(canonicalChord("cmd+shift+p"), "shift+cmd+p", "one spelling, cmd last");
  assert.equal(canonicalChord("meta+F"), "cmd+f");
  assert.equal(canonicalChord("cmd+k cmd+s"), "cmd+k");
});

test("the vendored keymap was generated from the pinned code-server", () => {
  // regenerate with scripts/generate-keymaps.js when the pin moves
  const { CODE_SERVER_VERSION } = require("../dist/codeserver/vendored.js");
  for (const platform of ["mac", "linux"]) {
    const file = path.join(__dirname, "..", "assets", "keymaps", `vscode-${platform}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(
      parsed.codeServer,
      CODE_SERVER_VERSION,
      `assets/keymaps/vscode-${platform}.json is from code-server ${parsed.codeServer}, the pin is ${CODE_SERVER_VERSION}`,
    );
    assert.ok(parsed.bindings.length > 500, "a real keymap has hundreds of bindings");
  }
});

test("the platform keymap answers with this platform's chords", () => {
  const { defaultBinding } = require("../dist/shortcuts/vscode-keymap.js");
  const find = process.platform === "darwin" ? "cmd+f" : "ctrl+f";
  const other = process.platform === "darwin" ? "ctrl+f" : "cmd+f";
  assert.equal(defaultBinding(find).command, "actions.find");
  assert.notEqual(defaultBinding(other)?.command, "actions.find");
});

test("derived conflicts: a bind on a chord the editor holds surfaces, nothing else does", () => {
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/ghostty.js");
  const holds = (chord) =>
    ({
      "cmd+f": { command: "actions.find" },
      "shift+cmd+p": { command: "workbench.action.showCommands" },
      "cmd+t": { command: "workbench.action.showAllSymbols" },
      "cmd+w": { command: "workbench.action.closeActiveEditor" },
    })[chord] ?? null;
  const live = parseKeybinds([
    "keybind = super+f=start_search",
    "keybind = super+shift+p=toggle_command_palette",
    "keybind = super+t=new_tab",
    "keybind = super+w=close_surface",
    "keybind = super+e=search_selection",
    "keybind = shift+arrow_left=adjust_selection:left",
    "keybind = super+arrow_left=text:\\\\x01",
    "keybind = super+g=navigate_search:next",
    "keybind = super+y=some_action_nobody_heard_of",
  ].join("\n"));
  const conflicts = allConflicts(live, new Set(), holds);

  const byId = new Map(conflicts.map((c) => [c.editorId, c]));
  assert.ok(byId.get("cmd+f"), "a new ghostty default is detected with no table change");
  assert.equal(byId.get("cmd+f").editor.command, "actions.find");
  assert.ok(byId.get("shift+cmd+p"), "the command palette chord is detected");
  assert.equal(byId.get("cmd+w").editor.command, "workbench.action.closeActiveEditor");
  assert.equal(byId.get("cmd+w").editor.means, "close active editor");
  assert.ok(!byId.has("cmd+e"), "state-dependent actions pass through, so they are not conflicts");
  assert.ok(!byId.has("shift+left"), "selection adjustment passes through");
  assert.ok(!byId.has("cmd+left"), "text rewrites are emulation, not conflicts");
  assert.ok(!byId.has("cmd+g"), "search navigation passes through");
  assert.ok(!byId.has("cmd+y"), "a chord the editor does not hold is no conflict");
});

test("macOS native tab cycling frees by rebinding to bytes — an unbind hands it to the OS", () => {
  // AppKit cycles ghostty's native tabs on ctrl+tab before the keybind table
  // runs. A bound trigger stays ghostty's, so freeing writes a rebind that
  // emits the chord itself; unbinding would change nothing.
  if (process.platform !== "darwin") return;
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/ghostty.js");
  const holds = () => ({ command: "workbench.action.quickOpenNavigateNext" });
  const live = parseKeybinds([
    "keybind = ctrl+tab=next_tab",
    "keybind = ctrl+shift+tab=previous_tab",
  ].join("\n"));
  const { withEmits } = require("../dist/shortcuts/ghostty.js");
  const conflicts = allConflicts(live, new Set(), holds);
  assert.deepEqual(conflicts.map((c) => c.editorId), ["ctrl+tab", "ctrl+shift+tab"]);
  // freeing those rows completes into emit rebinds — on a live free (action
  // from the scan) and on a re-apply (action kept by the decision) alike
  const moves = withEmits([
    { trigger: "ctrl+tab", action: "next_tab" },
    { trigger: "ctrl+shift+tab", action: "previous_tab" },
    { trigger: "super+f", action: "start_search" },
  ]);
  assert.deepEqual(
    moves.map((m) => [m.trigger, m.emit ?? null]),
    [
      ["ctrl+tab", "esc:[27;5;9~"],
      ["ctrl+shift+tab", "esc:[27;6;9~"],
      ["super+f", null],
    ],
    "the exact sequences the terminal decodes back into the chords",
  );
});

test("emit rebinds are written instead of unbind, and count as freed", () => {
  const { keybindsFileContents, writeFreed, freedTriggers, emitSequence } = require("../dist/shortcuts/ghostty.js");
  assert.equal(emitSequence("ctrl+tab"), "esc:[27;5;9~");
  assert.equal(emitSequence("ctrl+shift+tab"), "esc:[27;6;9~");
  assert.equal(emitSequence("cmd+f"), "esc:[27;9;102~");
  assert.equal(emitSequence("ctrl+left"), null, "no simple codepoint, no sequence");

  const contents = keybindsFileContents([
    { trigger: "ctrl+tab", emit: "esc:[27;5;9~" },
    { trigger: "super+f" },
  ]);
  assert.match(contents, /keybind = ctrl\+tab=esc:\[27;5;9~/);
  assert.ok(!contents.includes("ctrl+tab=unbind"), "the emit replaces the unbind");
  assert.match(contents, /keybind = super\+f=unbind/, "plain frees still unbind");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-emit-"));
  try {
    writeFreed(dir, [{ trigger: "ctrl+tab", emit: "esc:[27;5;9~" }, { trigger: "super+f" }]);
    assert.deepEqual([...freedTriggers(dir)].sort(), ["ctrl+tab", "super+f"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derived conflicts: custom binds and prefixes behave", () => {
  const { allConflicts, parseKeybinds } = require("../dist/shortcuts/ghostty.js");
  const holds = (chord) => (chord === "cmd+p" ? { command: "workbench.action.quickOpen" } : null);
  const live = parseKeybinds([
    "keybind = super+p=toggle_tab_overview",
    "keybind = performable:super+p=toggle_tab_overview",
  ].join("\n"));
  // the plain bind conflicts; the performable spelling of the same trigger
  // passes through and must not double-report
  const conflicts = allConflicts(live, new Set(), holds);
  assert.equal(conflicts.filter((c) => c.editorId === "cmd+p").length, 1);

  const passing = parseKeybinds(["keybind = performable:super+p=toggle_tab_overview"].join("\n"));
  assert.deepEqual(allConflicts(passing, new Set(), holds), []);
});

test("a freed chord stays listed, and the freeing decision recalls its action", () => {
  const { allConflicts } = require("../dist/shortcuts/ghostty.js");
  const holds = (chord) => (chord === "cmd+f" ? { command: "actions.find" } : null);
  const freed = new Set(["super+f"]);
  const past = (chord) => (chord === "cmd+f" ? "start_search" : null);
  const conflicts = allConflicts(new Map([["super+f", "unbind"]]), freed, holds, past);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].current, null, "freed by tode, so no current action");
  assert.equal(conflicts[0].editor.command, "actions.find");
  assert.equal(conflicts[0].short, "start search", "the texts still name what the trigger ran");

  const forgotten = allConflicts(new Map([["super+f", "unbind"]]), freed, holds, () => null);
  assert.equal(forgotten[0].short, "what it ran before", "with nothing to recall, say so");
});

test("derived editor decisions write keybindings through the command on the decision", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-derived-store-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "cmd+f": { choice: "editor", key: "ctrl+alt+f", command: "actions.find" },
        "cmd+g": { choice: "editor", key: "ctrl+alt+g" },
      },
    });
    const bindings = store.fallbackBindings();
    assert.deepEqual(bindings, [{ key: "ctrl+alt+f", command: "actions.find", when: "!terminalFocus" }]);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("editor-side decisions become keybindings, terminal and keep do not", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-decisions-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    assert.deepEqual(store.fallbackBindings(), [], "no decisions means no bindings");

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "cmd+w": { choice: "terminal" },
        "cmd+shift+z": { choice: "editor", key: "ctrl+shift+z", command: "redo" },
        "cmd+a": { choice: "editor", key: "ctrl+alt+a", command: "editor.action.selectAll" },
        "cmd+z": { choice: "keep" },
      },
    });
    const bindings = store.fallbackBindings();
    assert.equal(bindings.length, 2);
    const redo = bindings.find((b) => b.command === "redo");
    assert.equal(redo.key, "ctrl+shift+z");
    const all = bindings.find((b) => b.command === "editor.action.selectAll");
    assert.equal(all.key, "ctrl+alt+a", "a custom chord carries the command");

    // and installKeybindings carries the swap into the editor's file
    const profile = require("../dist/profile.js");
    profile.installKeybindings();
    const { parseJsonc } = require("../dist/jsonc.js");
    const written = parseJsonc(
      fs.readFileSync(path.join(profile.USER_DIR, "keybindings.json"), "utf8"),
    );
    assert.ok(written.some((b) => b.key === "ctrl+shift+z" && b.command === "redo"));

    // clearing the decisions clears the swap on the next install
    store.clearDecisions();
    profile.installKeybindings();
    const after = parseJsonc(
      fs.readFileSync(path.join(profile.USER_DIR, "keybindings.json"), "utf8"),
    );
    assert.ok(!after.some((b) => b.key === "ctrl+shift+z" && b.command === "redo"));
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("an imported binding on any tode builtin is a conflict; removals and tode's own are not", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-import-scan-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { USER_DIR } = freshRequire("../dist/profile.js");
    const { importedConflicts, importedHolder } = require("../dist/shortcuts/imported.js");
    const { QUIT_CHORD } = require("../dist/shortcuts/store.js");
    const file = path.join(USER_DIR, "keybindings.json");
    fs.mkdirSync(USER_DIR, { recursive: true });
    const quit = () => importedConflicts().find((c) => c.key === QUIT_CHORD) ?? null;

    fs.writeFileSync(file, JSON.stringify([{ key: "ctrl+shift+p", command: "other" }]));
    assert.deepEqual(importedConflicts(), [], "a binding elsewhere is no conflict");

    fs.writeFileSync(file, JSON.stringify([{ key: QUIT_CHORD.toUpperCase(), command: "workbench.action.terminal.toggle" }]));
    assert.equal(quit().command, "workbench.action.terminal.toggle", "case does not hide a conflict");
    assert.equal(quit().builtin, "tode.confirmQuit", "the shadowed builtin rides along");

    fs.writeFileSync(file, JSON.stringify([{ key: QUIT_CHORD, command: "-workbench.action.something" }]));
    assert.equal(quit(), null, "a removal entry holds nothing");

    fs.writeFileSync(file, JSON.stringify([{ key: QUIT_CHORD, command: "tode.confirmQuit", when: "!terminalFocus" }]));
    assert.equal(quit(), null, "a hand-written tode bind is not a conflict");

    // the pane chords are tode builtins too — defended exactly like quit,
    // nothing special-cased to one chord
    fs.writeFileSync(file, JSON.stringify([{ key: "alt+w", command: "whatever.the.user.bound" }]));
    const pane = importedConflicts().find((c) => c.key === "alt+w");
    assert.equal(pane.builtin, "workbench.action.closeEditorsInGroup");
    assert.equal(pane.claimant, "imported");

    fs.writeFileSync(file, JSON.stringify([{ key: "shift+ctrl+q", command: "taken" }]));
    assert.equal(importedHolder("ctrl+shift+q"), "taken", "modifier order does not hide a holder");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("an extension that contributes ctrl+q is a claimant, named by its display name", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-ext-claim-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { EXTENSIONS_DIR } = freshRequire("../dist/profile.js");
    const { importedConflicts } = require("../dist/shortcuts/imported.js");
    assert.deepEqual(importedConflicts(), [], "no extensions installed, no claim");

    const vimDir = path.join(EXTENSIONS_DIR, "vscodevim.vim-1.30.0");
    fs.mkdirSync(vimDir, { recursive: true });
    fs.writeFileSync(path.join(vimDir, "package.json"), JSON.stringify({
      name: "vim",
      displayName: "Vim",
      contributes: { keybindings: [
        { key: "ctrl+d", command: "extension.vim_ctrl+d" },
        { key: "ctrl+c", command: "extension.vim_ctrl+c", when: "editorTextFocus && vim.active" },
        { key: "ctrl+q", command: "extension.vim_winCtrlQ", when: "editorTextFocus && vim.active" },
      ] },
    }));
    const bridgeDir = path.join(EXTENSIONS_DIR, "tode.tode-bridge-1.2.0");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "package.json"), JSON.stringify({
      name: "tode-bridge",
      contributes: { keybindings: [{ key: "ctrl+q", command: "tode.quit" }] },
    }));
    fs.writeFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), JSON.stringify([
      { identifier: { id: "tode.tode-bridge" }, relativeLocation: "tode.tode-bridge-1.2.0" },
      { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
    ]));

    const { extensionHolder } = require("../dist/shortcuts/imported.js");
    const { QUIT_CHORD } = require("../dist/shortcuts/store.js");
    // the scan is generic over chords, not special-cased to one
    assert.equal(extensionHolder("ctrl+d").command, "extension.vim_ctrl+d");
    assert.equal(extensionHolder("ctrl+q").command, "extension.vim_winCtrlQ");
    assert.equal(extensionHolder("ctrl+q").claimant, "Vim", "the display name fronts the claim");
    assert.equal(extensionHolder("ctrl+q").describes, "vim winCtrlQ", "the id is cleaned when no title exists");
    assert.equal(extensionHolder("ctrl+x"), null);

    // a guarded claim on the quit chord is split structurally — tode's own
    // binding yields inside the claimant's when clause — so nothing surfaces
    assert.deepEqual(importedConflicts(), []);

    // an unguarded claim would be shadowed whole, so it still needs a decision
    const acmeDir = path.join(EXTENSIONS_DIR, "acme.keys-1.0.0");
    fs.mkdirSync(acmeDir, { recursive: true });
    fs.writeFileSync(path.join(acmeDir, "package.json"), JSON.stringify({
      name: "keys",
      displayName: "Acme Keys",
      contributes: { keybindings: [{ key: QUIT_CHORD, command: "acme.everything" }] },
    }));
    const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
    fs.writeFileSync(manifest, JSON.stringify([
      { identifier: { id: "tode.tode-bridge" }, relativeLocation: "tode.tode-bridge-1.2.0" },
      { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
      { identifier: { id: "acme.keys" }, relativeLocation: "acme.keys-1.0.0" },
    ]));
    // the claim scan caches on the manifest's mtime; make the rewrite visible
    fs.utimesSync(manifest, new Date(), new Date(Date.now() + 5000));
    const claim = importedConflicts().find((c) => c.key === QUIT_CHORD);
    assert.equal(claim.claimant, "Acme Keys");
    assert.equal(claim.builtin, "tode.confirmQuit");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the quit chord lives at user level, unless a decision moved or surrendered it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-quitbind-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    const bindings = store.quitBindings();
    assert.equal(bindings.length, 1, "undecided means tode wins, above every extension");
    assert.equal(bindings[0].key, store.QUIT_CHORD);
    assert.equal(bindings[0].command, "tode.confirmQuit", "quitting always asks first");
    if (store.QUIT_CHORD === "ctrl+c") {
      assert.equal(
        bindings[0].when,
        "!terminalFocus && !editorHasSelection && (!inputFocus || editorTextFocus)",
        "the reflex chord carries the hint contexts",
      );
      assert.deepEqual(store.hintBindings(), [], "no redirect where ctrl+c is quit itself");
    } else {
      assert.equal(bindings[0].when, "!terminalFocus");
      assert.equal(store.hintBindings().length, 1, "linux redirects ctrl+c to the quit chord");
    }

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: { [store.QUIT_CHORD]: { choice: "terminal" } } });
    assert.equal(store.quitBindings().length, 1, "a freed terminal chord still quits in tode");

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: { [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+alt+q" } } });
    assert.deepEqual(store.quitBindings(), [], "a moved quit is carried by the fallback instead");

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: { [store.IMPORT_DECISION_ID]: { choice: "keep" } } });
    assert.deepEqual(store.quitBindings(), [], "a surrendered quit writes nothing");

    // claim decisions become vscode's own removal entries, never edits
    store.saveDecisions({ version: 1, terminal: "ghostty", choices: {
      [store.CLAIM_DECISION_ID]: { choice: "terminal", action: "extension.vim_winCtrlQ" },
    } });
    assert.deepEqual(store.claimBindings(), [
      { key: store.QUIT_CHORD, command: "-extension.vim_winCtrlQ" },
    ], "unsetting a claim is a negative user entry");

    store.saveDecisions({ version: 1, terminal: "ghostty", choices: {
      [store.CLAIM_DECISION_ID]: { choice: "terminal", key: "ctrl+alt+v", action: "extension.vim_winCtrlQ", guard: "editorTextFocus && vim.active" },
    } });
    assert.deepEqual(store.claimBindings(), [
      { key: store.QUIT_CHORD, command: "-extension.vim_winCtrlQ" },
      { key: "ctrl+alt+v", command: "extension.vim_winCtrlQ", when: "editorTextFocus && vim.active" },
    ], "a moved claim removes the old rule and re-adds it at the new chord");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("tode's quit guard yields wherever an extension's own claim declares itself", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-yield-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { EXTENSIONS_DIR } = freshRequire("../dist/profile.js");
    const store = require("../dist/shortcuts/store.js");
    const dir = path.join(EXTENSIONS_DIR, "vscodevim.vim-1.30.0");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "vim",
      contributes: { keybindings: [
        { key: store.QUIT_CHORD, command: "extension.vim_quit", when: "editorTextFocus && vim.active" },
        { key: "ctrl+c", command: "extension.vim_escape", when: "vim.mode == 'Insert'" },
      ] },
    }));
    fs.writeFileSync(path.join(EXTENSIONS_DIR, "extensions.json"), JSON.stringify([
      { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
    ]));

    // the exclusion comes from the claim's own when clause — no extension is
    // named anywhere in the mechanism
    const [quit] = store.quitBindings();
    assert.ok(quit.when.includes("!(editorTextFocus && vim.active)"), quit.when);
    if (store.QUIT_CHORD === "ctrl+c") {
      assert.ok(quit.when.includes("!(vim.mode == 'Insert')"), "every claim on the chord is carved out");
    } else {
      const [hint] = store.hintBindings();
      assert.ok(hint.when.includes("!(vim.mode == 'Insert')"), hint.when);
    }
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("quit-wins puts tode's entry after the imported one, so vscode picks tode's", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-import-win-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const profile = freshRequire("../dist/profile.js");
    const store = require("../dist/shortcuts/store.js");
    const { parseJsonc } = require("../dist/jsonc.js");
    const file = path.join(profile.USER_DIR, "keybindings.json");
    const read = () => parseJsonc(fs.readFileSync(file, "utf8"));

    profile.installKeybindings();
    profile.mergeKeybindings([{ key: store.QUIT_CHORD, command: "workbench.action.imported" }]);
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.IMPORT_DECISION_ID]: { choice: "editor", key: store.QUIT_CHORD } },
    });
    profile.installKeybindings();

    const entries = read();
    const importedAt = entries.findIndex((e) => e.command === "workbench.action.imported");
    const quitAt = entries.reduce((last, e, at) => (e.command === "tode.confirmQuit" ? at : last), -1);
    assert.ok(importedAt >= 0, "the imported entry stays in the file");
    assert.ok(quitAt > importedAt, "tode.quit must come later, vscode reads bottom-up");

    // repeated installs stay stable, nothing duplicates
    const count = entries.length;
    profile.installKeybindings();
    profile.installKeybindings();
    assert.equal(read().length, count);

    // a moved quit lands on its chord and leaves ctrl+q to the import
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+shift+q" } },
    });
    profile.installKeybindings();
    const moved = read();
    const quit = moved.filter((e) => e.command === "tode.confirmQuit" && e.key === "ctrl+shift+q");
    assert.equal(quit.length, 1);
    assert.ok(moved.some((e) => e.command === "workbench.action.imported"));
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("an import decision on any builtin writes its override, command staged on the decision", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-override-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const store = freshRequire("../dist/shortcuts/store.js");
    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        "import:alt+w": { choice: "editor", key: "ctrl+alt+w", command: "workbench.action.closeEditorsInGroup" },
        // a quit decision saved before commands rode on decisions still works
        [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+shift+q" },
      },
    });
    assert.deepEqual(store.overrideBindings().sort((a, b) => a.key.localeCompare(b.key)), [
      { key: "ctrl+alt+w", command: "workbench.action.closeEditorsInGroup", when: "!terminalFocus" },
      { key: "ctrl+shift+q", command: "tode.confirmQuit", when: "!terminalFocus" },
    ]);
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("the quit hint follows the wizard's decisions, import decision first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-hint-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const { quitHintMessage } = freshRequire("../dist/bridge.js");
    const store = require("../dist/shortcuts/store.js");

    assert.equal(quitHintMessage(), `Press ${store.QUIT_CHORD} to quit tode`);

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.QUIT_CHORD]: { choice: "editor", key: "ctrl+alt+q" } },
    });
    assert.equal(quitHintMessage(), "Press ctrl+alt+q to quit tode");

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: { [store.QUIT_CHORD]: { choice: "keep" } },
    });
    assert.match(quitHintMessage(), /command palette/);

    store.saveDecisions({
      version: 1,
      terminal: "ghostty",
      choices: {
        [store.QUIT_CHORD]: { choice: "terminal" },
        [store.IMPORT_DECISION_ID]: { choice: "editor", key: "ctrl+shift+q" },
      },
    });
    assert.equal(quitHintMessage(), "Press ctrl+shift+q to quit tode");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

function fakePalette() {
  return {
    background: [20, 22, 26],
    foreground: [232, 230, 227],
    ansi: Array.from({ length: 16 }, (_, at) => [at * 10, at * 10, at * 10]),
  };
}

function fakeRow() {
  return {
    id: "cmd+w",
    kind: "terminal",
    means: "close the current editor tab",
    terminal: {
      name: "Ghostty",
      short: "close the pane",
      does: "closes the whole terminal pane",
      freed: "panes close from the menu",
      tradeoff: "close panes from the menu instead",
      bound: true,
    },
    decision: null,
  };
}

function fakeManagerDeps(overrides = {}) {
  const decided = [];
  const confirmed = [];
  const { normalizeChord } = require("../dist/shortcuts/wizard.js");
  return {
    decided,
    confirmed,
    deps: {
      rows: () => [fakeRow()],
      taken: (chord) =>
        chord === "ctrl+shift+t"
          ? { holder: "reopen a tab" }
          : chord === "ctrl+w"
            ? { holder: "extension.vim_ctrl+w (Vim)", claim: { chord: "ctrl+w", command: "extension.vim_ctrl+w", claimant: "Vim", describes: "vim ctrl+w" } }
            : null,
      normalize: normalizeChord,
      decide: (id, kind, decision) => decided.push({ id, kind, decision }),
      confirm: () => {
        confirmed.push(true);
        return { note: "applied — reload ghostty" };
      },
      reloadHint: "reload ghostty for this to take effect",
      terminalName: "Ghostty",
      palette: fakePalette(),
      ...overrides,
    },
  };
}

test("the manager serves the built page with the terminal's colours, and its state", async () => {
  const { startManager } = freshRequire("../dist/shortcuts/web.js");
  const { deps } = fakeManagerDeps();
  const manager = await startManager(deps);
  const base = `http://127.0.0.1:${manager.port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /shortcuts<\/title>/);
    assert.match(page, /--bg: #14161a/, "the page background is the terminal's");
    assert.match(page, /--fg: #e8e6e3/);
    assert.match(page, /\/assets\/index\.js/, "the built bundle is what the page loads");

    const bundle = await fetch(`${base}/assets/index.js`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get("content-type"), /text\/javascript/);

    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.terminalName, "Ghostty");
    assert.deepEqual(state.rows.map((row) => row.id), ["cmd+w"]);
    assert.match(state.logos.editor ?? "", /^data:image\/png;base64,/, "the real logo images ride along");
  } finally {
    manager.close();
  }
});

test("the manager server: page, taken checks, staging, confirming, done", async () => {
  const { startManager } = freshRequire("../dist/shortcuts/web.js");
  const { decided, confirmed, deps } = fakeManagerDeps();
  const manager = await startManager(deps);
  const base = `http://127.0.0.1:${manager.port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /shortcuts<\/title>/);

    const free = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "ctrl+alt+w", id: "cmd+w" }) })).json();
    assert.deepEqual(free, { ok: true, chord: "ctrl+alt+w" });

    const held = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "ctrl+shift+t", id: "cmd+w" }) })).json();
    assert.equal(held.ok, false);
    assert.match(held.warning, /reopen a tab/);
    assert.equal(held.claim, null, "no claim payload when nothing editable holds it");

    const claimed = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "ctrl+w", id: "cmd+w" }) })).json();
    assert.equal(claimed.ok, false);
    assert.equal(claimed.claim.claimant, "Vim", "an extension holder rides along so the page can offer the editor");


    const garbage = await (await fetch(`${base}/taken`, { method: "POST", body: JSON.stringify({ chord: "w", id: "cmd+w" }) })).json();
    assert.equal(garbage.ok, false, "a chord with no modifier is refused");

    const staged = await (await fetch(`${base}/decide`, { method: "POST", body: JSON.stringify({ id: "cmd+w", kind: "terminal", decision: { choice: "terminal" } }) })).json();
    assert.equal(staged.ok, true);
    assert.ok(Array.isArray(staged.rows), "a decision returns fresh rows");
    assert.equal(decided.length, 1);
    assert.equal(confirmed.length, 0, "deciding stages, it does not write");

    const cleared = await (await fetch(`${base}/decide`, { method: "POST", body: JSON.stringify({ id: "cmd+w", kind: "terminal", decision: null }) })).json();
    assert.equal(cleared.ok, true);
    assert.equal(decided[1].decision, null, "null clears a row back to undecided");

    const claimDecision = await (await fetch(`${base}/decide`, { method: "POST", body: JSON.stringify({ id: "ctrl+w", kind: "claim", decision: { choice: "terminal" } }) })).json();
    assert.equal(claimDecision.ok, true);
    assert.equal(decided[decided.length - 1].kind, "claim", "claim decisions carry their kind");

    const applied = await (await fetch(`${base}/confirm`, { method: "POST", body: "{}" })).json();
    assert.equal(applied.ok, true);
    assert.match(applied.note, /applied/);
    assert.equal(confirmed.length, 1, "confirm is the only write");

    let closed = false;
    manager.done.then(() => (closed = true));
    await (await fetch(`${base}/done`, { method: "POST", body: "{}" })).json();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(closed, "done resolves so the pane can be handed back");
  } finally {
    manager.close();
  }
});

test("manager rows carry the derived editor side straight from the scan", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-rows-"));
  const prev = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  try {
    const wizard = freshRequire("../dist/shortcuts/wizard.js");
    const conflict = (editorId, means, command, guard) => ({
      editorId, trigger: "x", current: "y",
      editor: { means, command, guard },
      inTerminal: `runs stuff, so ${means} never reaches the editor`,
      short: "stuff", freed: "stuff goes", tradeoff: "stuff stops working",
    });
    const provider = {
      id: "ghostty",
      name: "Ghostty",
      detect: () => true,
      ready: () => null,
      scan: () => [
        conflict("cmd+w", "close active editor", "workbench.action.closeActiveEditor", "editorFocus"),
        conflict("cmd+f", "find", "actions.find"),
      ],
      takenAs: () => null,
      apply: () => "",
      onApplied: () => false,
      undo: () => false,
      reloadHint: () => "reload ghostty",
    };
    const rows = wizard.managerRows(provider, { "cmd+f": { choice: "terminal" } });
    assert.deepEqual(rows.map((row) => row.id), ["cmd+w", "cmd+f"]);
    assert.equal(rows[0].means, "close active editor");
    assert.deepEqual(
      rows[0].detail,
      { command: "workbench.action.closeActiveEditor", when: "editorFocus" },
      "the metadata is structured, ready for label → value rows",
    );
    assert.deepEqual(rows[1].detail, { command: "actions.find", when: undefined });
    assert.equal(rows[0].decision, null);
    assert.deepEqual(rows[1].decision, { choice: "terminal" }, "staged decisions ride on their row");
    assert.equal(rows[0].terminal.name, "Ghostty");
  } finally {
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

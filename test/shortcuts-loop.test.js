const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The closed-loop invariant: complete `tode shortcut-setup` (resolve every
 * conflict the wizard shows), apply, rerun — the rerun must show ZERO
 * unresolved conflicts, and a second apply must change nothing. The whole
 * loop runs on production code: the real ghostty provider (only the
 * `+list-keybinds` call is injected), the real holds derivation over a
 * sandboxed keybindings.json / extension tree / generated default keymap /
 * tode builtins, the real staging (managerSession) and the real apply.
 *
 * The move-target sweep makes it adversarial: every strategy that moves picks
 * whatever chord `taken()` blesses, starting from a different offset each
 * iteration — so any chord the vetting wrongly calls free becomes a
 * counterexample, named in the assertion. */

function freshRequire(id) {
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  return require(id);
}

// ---------------------------------------------------------------------------
// the page's own verdict, mirrored (src/pages/shortcuts/app.tsx rowChords/
// collisions): conflict is a fact about the values on screen, nothing else
function rowChords(row) {
  const list = [];
  const move =
    row.kind === "import"
      ? row.claimDecision?.choice === "terminal"
        ? (row.claimDecision.key ?? null)
        : undefined
      : row.decision?.choice === "terminal"
        ? (row.decision.key ?? null)
        : undefined;
  const left = move === undefined ? row.id : move;
  if (left) list.push(left);
  const editorUnset = row.decision?.choice === "keep";
  if (!editorUnset) {
    list.push(row.decision?.choice === "editor" && row.decision.key ? row.decision.key : row.id);
  }
  for (const claim of row.claims ?? []) {
    const state = claim.decided ?? undefined;
    if (claim.resting && state === undefined) continue;
    const held = state === undefined ? claim.chord : state?.key;
    if (held) list.push(held);
  }
  return list;
}

function collisions(row) {
  const counts = {};
  for (const chord of rowChords(row)) counts[chord] = (counts[chord] ?? 0) + 1;
  return Object.keys(counts).filter((chord) => counts[chord] > 1);
}

const unresolved = (row) =>
  collisions(row).length > 0 ||
  (row.claims ?? []).some((claim) => !claim.resting && !claim.decided);

// ---------------------------------------------------------------------------
// deterministic move-target candidates; contains tode builtins (alt+1..9,
// alt+w), default-keymap chords, extension chords — the traps
const KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789"];
const MODSETS = ["alt", "ctrl+alt", "shift+alt", "cmd+alt"];
const CANDIDATES = MODSETS.flatMap((mods) => KEYS.map((key) => `${mods}+${key}`));

test("closed loop: resolve everything, apply, rerun shows nothing", { timeout: 240_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-loop-"));
  const prev = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.XDG_DATA_HOME = path.join(home, "share");
  process.env.XDG_STATE_HOME = path.join(home, "state");
  process.env.XDG_CONFIG_HOME = path.join(home, "config");

  let wizard = freshRequire("../dist/shortcuts/wizard.js");
  require("../dist/shortcuts/vscode-keymap.js").setKeymapPlatformForTest("mac");
  let ghostty = require("../dist/shortcuts/backends/ghostty.js");
  let store = require("../dist/shortcuts/store.js");
  let profile = require("../dist/profile.js");

  try {
    // --- the sandbox world -------------------------------------------------
    const ghosttyDir = path.join(process.env.XDG_CONFIG_HOME, "ghostty");
    fs.mkdirSync(ghosttyDir, { recursive: true });
    fs.writeFileSync(path.join(ghosttyDir, "config"), "font-size = 14\n");

    // a small but trapped terminal config: defaults-vs-keymap conflicts, the
    // goto_tab trap (its editor command is also tode's builtin on alt+1)
    const BASE_KEYBINDS = [
      "keybind = super+w=close_surface",
      "keybind = super+digit_1=goto_tab:1",
      "keybind = super+f=start_search",
      "keybind = super+t=new_tab",
    ].join("\n");
    const freedFile = path.join(ghosttyDir, "tode", "keybinds.ghostty");
    ghostty.setListKeybindsForTest(() => {
      let ours = "";
      try {
        ours = fs.readFileSync(freedFile, "utf8");
      } catch {}
      return BASE_KEYBINDS + "\n" + ours;
    });

    // imported keybindings: one on the quit chord, one on a tode builtin
    const userDir = profile.USER_DIR;
    fs.mkdirSync(userDir, { recursive: true });
    const keybindingsFile = path.join(userDir, "keybindings.json");
    const IMPORTED = [
      { key: store.QUIT_CHORD, command: "workbench.action.terminal.kill" },
      { key: "alt+w", command: "my.imported.closeThing" },
      // the M1 trap, exactly the user's world: the row's editor command is
      // ALSO tode's builtin on alt+1 — a terminal move onto alt+1 must seat
      // the builtin as a claimant, never bless the chord as free
      { key: "cmd+1", command: "workbench.action.focusFirstEditorGroup" },
    ];
    const writeImported = () => fs.writeFileSync(keybindingsFile, JSON.stringify(IMPORTED));
    writeImported();

    // extensions: vim registered; acme present on disk but NOT registered —
    // its keybindings must count anyway (first boot registers it later)
    const extDir = profile.EXTENSIONS_DIR;
    const putExtension = (dir, pkg) => {
      fs.mkdirSync(path.join(extDir, dir), { recursive: true });
      fs.writeFileSync(path.join(extDir, dir, "package.json"), JSON.stringify(pkg));
    };
    putExtension("vscodevim.vim-1.30.0", {
      name: "vim",
      displayName: "Vim",
      contributes: {
        keybindings: [
          { key: "ctrl+d", mac: "cmd+d", command: "extension.vim_ctrl+d" },
          { key: "alt+3", command: "extension.vim_window3", when: "vim.active" },
        ],
      },
    });
    putExtension("acme.keys-1.0.0", {
      name: "acme-keys",
      displayName: "Acme Keys",
      contributes: { keybindings: [{ key: "ctrl+alt+k", command: "acme.everything" }] },
    });
    const registryFile = path.join(extDir, "extensions.json");
    fs.writeFileSync(
      registryFile,
      JSON.stringify([{ identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" }]),
    );
    const simulateFirstBoot = () =>
      fs.writeFileSync(
        registryFile,
        JSON.stringify([
          { identifier: { id: "vscodevim.vim" }, relativeLocation: "vscodevim.vim-1.30.0" },
          { identifier: { id: "acme.keys" }, relativeLocation: "acme.keys-1.0.0" },
        ]),
      );

    const provider = ghostty.ghosttyProvider;

    // --- the driver: resolve every row and claim the way a user would ------
    let contestedPicks = 0;
    const pickFree = (session, rowId, ask, offset, label) => {
      for (let i = 0; i < CANDIDATES.length; i++) {
        const chord = CANDIDATES[(offset + i) % CANDIDATES.length];
        const got = session.taken(chord, rowId, ask.command, ask.side);
        if (got === null) return chord;
        // the contested strategy takes the fight: a chord with a resolvable
        // claimant is picked anyway — the claim seats as a column and the
        // driver resolves it, exactly like a user insisting on their chord
        if (ask.contested && got.claim) {
          contestedPicks++;
          return chord;
        }
      }
      throw new Error(`${label}: taken() blessed no candidate at all for ${rowId}`);
    };

    const resolveWorld = (session, strategy, offset, label) => {
      for (let guard = 0; guard < 400; guard++) {
        const rows = session.rows();
        const row = rows.find(unresolved);
        if (!row) return;
        // contested claimant columns first, exactly like the page would
        const claim = (row.claims ?? []).find((entry) => !entry.resting && !entry.decided);
        if (claim) {
          const decision =
            strategy === "terminal-move"
              ? {
                  choice: "terminal",
                  key: pickFree(session, claim.chord, { command: claim.command }, offset, label),
                }
              : { choice: "terminal" }; // unset
          session.decide(claim.chord, "claim", decision, "own", {
            command: claim.command,
            when: claim.when,
          });
          continue;
        }
        if (row.kind === "import") {
          // resolve the imported binding (left side): unset it, or move it
          const decision =
            strategy === "terminal-move" || strategy === "editor-move"
              ? {
                  choice: "terminal",
                  key: pickFree(session, row.id, { command: row.importedCommand }, offset, label),
                }
              : { choice: "terminal" };
          session.decide(row.id, "import", decision, "claim");
          continue;
        }
        const decision =
          strategy === "keep"
            ? { choice: "keep" }
            : strategy === "editor-move"
              ? { choice: "editor", key: pickFree(session, row.id, { side: "editor" }, offset, label) }
              : strategy === "terminal-move" || strategy === "contested-move"
                ? {
                    choice: "terminal",
                    key: pickFree(
                      session,
                      row.id,
                      { side: "terminal", contested: strategy === "contested-move" },
                      offset,
                      label,
                    ),
                  }
                : { choice: "terminal" }; // unset
        session.decide(row.id, "terminal", decision);
      }
      throw new Error(`${label}: the wizard loop did not converge in 400 steps`);
    };

    const snapshot = () => {
      const read = (file) => {
        try {
          return fs.readFileSync(file, "utf8");
        } catch {
          return "";
        }
      };
      return read(freedFile) + " " + read(keybindingsFile);
    };

    const applyAndAssertClean = (label) => {
      simulateFirstBoot();
      // a fresh session, like a real reopen: staged seeds from the saved
      // decisions, the scan re-derives from the applied files
      const rerun = wizard.managerSession(provider);
      const bad = rerun.rows().filter(unresolved);
      assert.deepEqual(
        bad.map((row) => ({ id: row.id, chords: rowChords(row), claims: (row.claims ?? []).map((c) => `${c.chord}:${c.command}${c.decided ? "=decided" : ""}${c.resting ? " (resting)" : ""}`) })),
        [],
        `${label}: the rerun shows unresolved conflicts`,
      );
      // idempotence: a second apply must not move a byte or create work
      const before = snapshot();
      rerun.confirm();
      assert.equal(snapshot(), before, `${label}: a second apply changed the world`);
      assert.deepEqual(
        wizard.managerSession(provider).rows().filter(unresolved).map((row) => row.id),
        [],
        `${label}: the second apply created new work`,
      );
    };

    const resetWorld = () => {
      provider.undo();
      store.clearDecisions();
      writeImported();
      // caches key on mtimes; make sure the rewrites are visible
      const bump = (file) => {
        try {
          const t = new Date();
          fs.utimesSync(file, t, t);
        } catch {}
      };
      bump(keybindingsFile);
      ghostty.setListKeybindsForTest(() => {
        let ours = "";
        try {
          ours = fs.readFileSync(freedFile, "utf8");
        } catch {}
        return BASE_KEYBINDS + "\n" + ours;
      });
    };

    // sanity: run 1 must actually have work to do
    const first = wizard.managerSession(provider);
    assert.ok(first.rows().filter(unresolved).length >= 3, "the fixture produces conflicts");

    // --- passes A-C: one strategy each -------------------------------------
    for (const strategy of ["unset", "keep", "editor-move"]) {
      const session = wizard.managerSession(provider);
      resolveWorld(session, strategy, 0, strategy);
      session.confirm();
      applyAndAssertClean(strategy);
      resetWorld();
    }

    // --- pass D: terminal moves, sweeping the pick offset so every
    // blessable chord gets chosen by some iteration ---------------------------
    for (let offset = 0; offset < CANDIDATES.length; offset += 3) {
      const label = `terminal-move@${offset}`;
      const session = wizard.managerSession(provider);
      if (offset === 9) {
        // mid-session the world grows: a late import and a new extension —
        // the very same session must surface and resolve them
        fs.writeFileSync(
          keybindingsFile,
          JSON.stringify([...IMPORTED, { key: "cmd+k", command: "my.late.import" }]),
        );
        putExtension("late.ext-1.0.0", {
          name: "late",
          displayName: "Late",
          contributes: { keybindings: [{ key: "ctrl+alt+j", command: "late.thing" }] },
        });
      }
      resolveWorld(session, "terminal-move", offset, label);
      session.confirm();
      applyAndAssertClean(label);
      resetWorld();
      if (offset === 9) {
        writeImported();
        fs.rmSync(path.join(extDir, "late.ext-1.0.0"), { recursive: true, force: true });
      }
    }

    // --- pass E: contested moves — take held chords, resolve the seated
    // claimants, and the rerun must still come back clean (the M1 shape:
    // moving onto a chord a builtin or the default keymap holds) -------------
    for (let offset = 0; offset < CANDIDATES.length; offset += 5) {
      const label = `contested-move@${offset}`;
      const session = wizard.managerSession(provider);
      resolveWorld(session, "contested-move", offset, label);
      session.confirm();
      applyAndAssertClean(label);
      resetWorld();
    }
    assert.ok(contestedPicks > 0, "the contested pass actually fought for held chords");

    // --- fresh-process rerun: module state must not be load-bearing --------
    const session = wizard.managerSession(provider);
    resolveWorld(session, "unset", 0, "fresh-process");
    session.confirm();
    simulateFirstBoot();
    wizard = freshRequire("../dist/shortcuts/wizard.js");
    ghostty = require("../dist/shortcuts/backends/ghostty.js");
    store = require("../dist/shortcuts/store.js");
    profile = require("../dist/profile.js");
    ghostty.setListKeybindsForTest(() => {
      let ours = "";
      try {
        ours = fs.readFileSync(freedFile, "utf8");
      } catch {}
      return BASE_KEYBINDS + "\n" + ours;
    });
    assert.deepEqual(
      wizard.managerSession(ghostty.ghosttyProvider).rows().filter(unresolved).map((row) => row.id),
      [],
      "a fresh process sees the same resolved world",
    );
  } finally {
    try {
      require("../dist/shortcuts/backends/ghostty.js").setListKeybindsForTest(null);
    } catch {}
    process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

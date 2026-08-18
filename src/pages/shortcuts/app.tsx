import { Fragment, useEffect, useState } from "react";

/** The shortcuts manager: one duel per contested chord, then a confirm table.
 * Everything stages through POSTs to the local server; nothing lands on disk
 * until /confirm. */

export interface Decision {
  choice: "terminal" | "editor" | "keep";
  key?: string;
  command?: string;
  action?: string;
  guard?: string;
}

export interface Row {
  id: string;
  kind: "terminal" | "import";
  means: string;
  detail?: { command: string; when?: string };
  terminal: {
    name: string;
    short: string;
    does: string;
    freed: string;
    tradeoff: string;
    bound: boolean;
  };
  importedCommand?: string;
  claimant?: string;
  claimDescribes?: string;
  claimDecision?: Decision | null;
  decision: Decision | null;
  claims?: (Omit<Claim, "state"> & { decided?: Decision | null })[];
}

/** A claimant column in a row's duel: a third (fourth, …) shortcut being
 * managed alongside the two. `state` is undefined while the claim still holds
 * its own chord. */
interface Claim {
  chord: string;
  command: string;
  claimant: string;
  describes: string;
  when?: string;
  state?: Decision | null;
  /** pre-seated by the scan: another binding coexisting on the row's own
   * chord. Not a clash while it sits there — guards are how bindings share —
   * it only counts once moved somewhere. Absent on claims that hold a chord
   * some decision moved onto: those clash from the start. */
  resting?: boolean;
}

export interface ManagerState {
  rows: Row[];
  terminalName: string;
  reloadHint: string;
  intro: boolean;
  /** done navigates onward during onboarding; standalone it closes the pane */
  continues: boolean;
  logos: { terminal: string | null; editor: string | null };
}

type Capturing = { id: string; side: "left" | "right" } | { claim: Claim; rowId: string };
type Menu = { id: string; side: string };
type Modal = { doLater: true } | { conflict: true };

const post = async (url: string, payload: unknown) => {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
  return response.json();
};

/** Done during onboarding is a navigation, not an exit: the server names the
 * next screen (the editor itself, eventually) and this pane simply goes
 * there, so the terminal never flashes back to its primary buffer. */
const finish = async () => {
  const answer = await post("/done", {});
  if (answer && answer.next) location.replace(answer.next);
};

const editorKey = (row: Row) =>
  row.decision && row.decision.choice === "editor" && row.decision.key ? row.decision.key : row.id;

const editorUnset = (row: Row) => !!row.decision && row.decision.choice === "keep";

/** Where the terminal's action lives now: its own chord (undefined means no
 * decision), a moved-to chord, or null for unbound. */
const terminalMove = (row: Row) =>
  row.decision && row.decision.choice === "terminal" ? (row.decision.key ?? null) : undefined;

/** Same shape for a claimant's binding (an extension holding the chord). */
const claimMove = (row: Row) =>
  row.claimDecision && row.claimDecision.choice === "terminal"
    ? (row.claimDecision.key ?? null)
    : undefined;

/** The claimant columns a row's duel shows, straight off the row the server
 * derived: existence, order and staged state all come back with every
 * /decide, so each step always shows the world as the session arranged it. */
const claimsOf = (row: Row): Claim[] =>
  (row.claims ?? []).map(({ decided, ...claim }) => ({
    ...claim,
    state: decided ?? undefined,
  }));

/** Every chord this row's sides currently show: the terminal (or claimant)
 * on the left, tode on the right, plus any claimant columns that joined. */
function rowChords(row: Row): string[] {
  const list: string[] = [];
  const move = row.kind === "import" ? claimMove(row) : terminalMove(row);
  const left = move === undefined ? row.id : move;
  if (left) list.push(left);
  if (!editorUnset(row)) list.push(editorKey(row));
  for (const claim of claimsOf(row)) {
    // a claim resting undisturbed on the row's own chord coexists by its
    // guard; it joins the count only once it moves somewhere. Every other
    // claim was seated by a collision in the first place.
    if (claim.resting && claim.state === undefined) continue;
    const held = claim.state === undefined ? claim.chord : claim.state?.key;
    if (held) list.push(held);
  }
  return list;
}

/** The chords bound by more than one side — conflict is a fact about the
 * values on screen, nothing else. */
function collisions(row: Row): Set<string> {
  const counts: Record<string, number> = {};
  for (const chord of rowChords(row)) counts[chord] = (counts[chord] ?? 0) + 1;
  return new Set(Object.keys(counts).filter((chord) => counts[chord] > 1));
}

const conflicted = (row: Row) => collisions(row).size > 0;

/** The unshifted spelling of the punctuation row, by physical key code.
 * Letters are deliberately absent: event.key already reports them unshifted,
 * and going through the code would break non-QWERTY lettering. */
const CODE_KEYS: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Each conflict costs roughly ten seconds; the estimate reads in minutes. */
function estimatedMinutes(conflicts: number): string {
  const minutes = Math.max(1, Math.ceil((conflicts * 10) / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function chordFrom(event: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("ctrl");
  if (event.shiftKey) mods.push("shift");
  if (event.altKey) mods.push("alt");
  if (event.metaKey) mods.push("cmd");
  let key = event.key.toLowerCase();
  if (["control", "shift", "alt", "meta"].includes(key)) return null;
  if (key.startsWith("arrow")) key = key.slice(5);
  if (key === " ") key = "space";
  // a shifted press reports the shifted character ("!" for shift+1), but
  // chords are spelled with the base key ("shift+alt+1") — translate through
  // the physical code for the digit and punctuation rows where that happens
  if (key.length === 1) {
    if (/^Digit\d$/.test(event.code)) key = event.code.slice("Digit".length);
    else if (event.code in CODE_KEYS) key = CODE_KEYS[event.code];
  }
  if (mods.length === 0) return null;
  return mods.concat(key).join("+");
}

const ArrowLeftIcon = () => (
  <span className="icon">
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
  </span>
);

const ArrowRightIcon = () => (
  <span className="icon">
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
  </span>
);

const PenIcon = () => (
  <span className="pen">
    <span className="icon">
      <svg xmlns="http://www.w3.org/2000/svg" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></svg>
    </span>
  </span>
);

/** Zero-width break opportunities after each dot: a command id wraps at its
 * own seams, words stay whole, and nothing invents hyphens. */
const wrappable = (value: string) => value.replaceAll(".", ".​");

/** One labelled-rows table, the shape every column's caption uses. */
function DetailTable({ entries }: { entries: [string, string][] }) {
  return (
    <div className="detail">
      {entries.map(([label, value]) => (
        <div key={label} className="entry">
          <div className="k">{label}</div>
          <div className="v">{wrappable(value)}</div>
        </div>
      ))}
    </div>
  );
}

export function App({ state }: { state: ManagerState }) {
  const FIRST = state.intro ? -1 : 0;
  // resume where the last visit left off: the first step that still needs a
  // hand — a live collision, or an undecided claimant column — or straight
  // onto the confirm table when nothing does. A settled step counts as done
  // whichever record settled it (an import row's claim decision included),
  // and earlier steps stay reachable with the back arrow, decisions prefilled.
  const resumeAt = (() => {
    const unsettled = state.rows.findIndex(
      (row) =>
        conflicted(row) ||
        claimsOf(row).some((claim) => !claim.resting && claim.state === undefined),
    );
    return unsettled === -1 ? state.rows.length : unsettled;
  })();
  const [rows, setRows] = useState<Row[]>(state.rows);
  const [at, setAt] = useState(state.intro ? FIRST : resumeAt);
  const [capturing, setCapturing] = useState<Capturing | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  // whether this session staged anything — what "unapplied changes" means
  const [touched, setTouched] = useState(false);
  // two silent seconds into a capture, offer typing the chord instead — the
  // terminal itself may be eating it (an unbind staged but not applied yet),
  // and then no keypress can ever arrive
  const [manual, setManual] = useState<"hidden" | "offered" | "typing">("hidden");

  useEffect(() => {
    setManual("hidden");
    if (!capturing) return;
    const timer = setTimeout(() => setManual("offered"), 2000);
    return () => clearTimeout(timer);
  }, [capturing]);

  const currentRow = () => (at >= 0 && at < rows.length ? rows[at] : null);
  const rowById = (id: string) => rows.find((row) => row.id === id) ?? null;

  function move(direction: number) {
    setWarning(null);
    setCapturing(null);
    setModal(null);
    setMenu(null);
    setAt((v) => Math.max(FIRST, Math.min(v + direction, rows.length)));
  }

  function tryNext() {
    if (at < 0) return move(1);
    if (at >= rows.length) return;
    const row = currentRow();
    if (!row || !conflicted(row)) return move(1);
    setModal({ conflict: true });
  }

  /** Swaps in the freshly derived rows. Steps can appear or disappear as
   * decisions resolve other steps, so the current position follows the row's
   * id, not its index; a vanished row falls forward to the next question. */
  function syncRows(fresh: Row[]) {
    const anchor = at >= 0 && at < rows.length ? rows[at].id : null;
    setRows(fresh);
    if (at >= rows.length) return void setAt(fresh.length);
    if (!anchor) return;
    const index = fresh.findIndex((row) => row.id === anchor);
    setAt(index >= 0 ? index : Math.min(at, fresh.length));
  }

  async function decide(row: Row, decision: Decision | null, side?: "claim") {
    const fresh = await post("/decide", { id: row.id, kind: row.kind, decision, side });
    // an error body carries no rows; keeping the old ones keeps the page
    // alive to show the warning
    if (fresh.rows) syncRows(fresh.rows);
    setWarning(fresh.ok === false ? fresh.warning : null);
    if (fresh.ok !== false) setTouched(true);
    setCapturing(null);
    setMenu(null);
  }

  async function decideClaimChord(claim: Claim, decision: Decision | null) {
    const fresh = await post("/decide", {
      id: claim.chord,
      kind: "claim",
      decision,
      action: claim.command,
      guard: claim.when,
    });
    if (fresh.rows) syncRows(fresh.rows);
    setWarning(fresh.ok === false ? fresh.warning : null);
    if (fresh.ok !== false) setTouched(true);
    setMenu(null);
    setCapturing(null);
  }

  async function applyChord(row: Row, side: "left" | "right", chord: string, keepOnError = false) {
    // the server's self-duel exemptions depend on which side is moving: a
    // terminal mover may skip another trigger of its own action, an editor
    // mover a duplicate spelling of its own command — never the reverse. An
    // import row's left side is an editor binding, so it asks by command,
    // the way a claim does.
    const importedLeft = side === "left" && row.kind === "import";
    const checked = await post("/taken", {
      chord,
      id: row.id,
      side: importedLeft ? undefined : side === "left" ? "terminal" : "editor",
      command: importedLeft ? row.importedCommand : undefined,
    });
    if (!checked.ok && !checked.claim) {
      setWarning(checked.warning);
      if (!keepOnError) setCapturing(null);
      return;
    }
    // a held chord still applies — a user keybinding outranks the holder —
    // and the decide below brings back rows where the holder has joined the
    // duel as its own column, visible and resolvable in place
    const final = checked.chord || chord;
    if (side === "left" && row.kind === "import") {
      return decide(row, final === row.id ? null : { choice: "terminal", key: final }, "claim");
    }
    if (side === "left") {
      return decide(row, final === row.id ? null : { choice: "terminal", key: final });
    }
    return decide(
      row,
      final === row.id && row.kind !== "import" ? null : { choice: "editor", key: final },
    );
  }

  async function applyClaimChord(claim: Claim, rowId: string, chord: string) {
    const checked = await post("/taken", { chord, id: claim.chord, command: claim.command });
    if (!checked.ok && !checked.claim) {
      setWarning(checked.warning);
      return;
    }
    // when the new chord has a holder of its own, the decide below brings it
    // back as one more column in the same duel — the chain goes as far as the
    // user takes it
    const final = checked.chord || chord;
    await decideClaimChord(claim, final === claim.chord ? null : { choice: "terminal", key: final });
  }

  async function captureClaimKey(event: KeyboardEvent, claim: Claim, rowId: string) {
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(null);
      setWarning(null);
      return;
    }
    const chord = chordFrom(event);
    if (!chord) return;
    await applyClaimChord(claim, rowId, chord);
  }

  /** The typed chord goes through the same /taken pipeline a captured one
   * does — the server normalises spellings (meta/super → cmd, mod order) and
   * vets the holder — so both entry paths mean exactly the same thing. */
  async function submitManual(text: string) {
    const typed = text.trim().toLowerCase();
    if (!typed || !capturing) return;
    if ("claim" in capturing) {
      await applyClaimChord(capturing.claim, capturing.rowId, typed);
      return;
    }
    const row = rowById(capturing.id);
    if (row) await applyChord(row, capturing.side, typed, true);
  }

  function manualInput() {
    return (
      <input
        className="box manualentry"
        autoFocus
        placeholder="type it: ctrl+alt+w"
        onClick={(event) => event.stopPropagation()}
        // leaving the field means the typing is done — a click elsewhere
        // submits what was typed, the same as enter
        onBlur={(event) => void submitManual(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") void submitManual(event.currentTarget.value);
          if (event.key === "Escape") {
            setCapturing(null);
            setWarning(null);
          }
        }}
      />
    );
  }

  function manualOffer() {
    return (
      <button
        className="manualoffer"
        onClick={(event) => {
          event.stopPropagation();
          setManual("typing");
        }}
      >
        click for manual
      </button>
    );
  }

  async function captureKey(event: KeyboardEvent, target: { id: string; side: "left" | "right" }) {
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(null);
      setWarning(null);
      return;
    }
    const chord = chordFrom(event);
    if (!chord) return;
    const row = rowById(target.id);
    if (!row) {
      setCapturing(null);
      return;
    }
    await applyChord(row, target.side, chord);
  }

  // the same keys wherever focus sits, exactly as the footer promises
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // while recording, every key is a candidate chord — including ctrl+c —
      // unless the manual input owns the keyboard
      if (capturing && manual === "typing") return;
      if (capturing && "claim" in capturing) return void captureClaimKey(event, capturing.claim, capturing.rowId);
      if (capturing) return void captureKey(event, capturing);
      // ctrl+c quits from anywhere else, the way it would in the terminal
      if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void finish();
        return;
      }
      if (modal) {
        if (event.key === "Escape") setModal(null);
        return; // enter and tab walk the modal's own buttons
      }
      if (menu) {
        if (event.key === "Escape") {
          setMenu(null);
          event.preventDefault();
        }
        return; // tab and enter walk the menu's own items
      }
      const key = event.key;
      if (key === "Tab") return;
      if (key === "Enter" && document.activeElement?.tagName === "BUTTON") return;
      if (key === "ArrowRight" || key === "n") tryNext();
      else if (key === "ArrowLeft") move(-1);
      else if (key === "u" && currentRow()) void decide(currentRow()!, null);
      // the footer promises q skips this — and ctrl+c must not be the only
      // door out of a page whose whole subject is that ctrl+c is contested
      else if (key === "q") void finish();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // clicking away closes an open menu; boxes stop propagation to stay open
  useEffect(() => {
    const onClick = () => setMenu((open) => (open ? null : open));
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // where the eye should land after each change of screen, matching what the
  // old page focused after every render
  useEffect(() => {
    if (modal) {
      (document.querySelector(".modal .option.primary, .modal .option") as HTMLElement | null)?.focus();
      return;
    }
    if (menu || capturing) return;
    const target =
      at < 0 ? "intro-go" : at >= rows.length ? "apply" : "next";
    document.getElementById(target)?.focus();
  }, [at, modal, menu, capturing, rows.length]);

  const TodeChip = () => (
    <span className="chip">
      {state.logos.editor ? <img src={state.logos.editor} alt="" /> : null}
      <span>terminal-code</span>
    </span>
  );

  /** Every box opens the same two-item menu: custom, and unset — which turns
   * into restore once the side is unset. Clicking away or esc closes it. */
  function menuItems(row: Row, side: "left" | "right") {
    const capture = () => {
      setMenu(null);
      setCapturing({ id: row.id, side });
    };
    if (side === "left" && row.kind === "import") {
      const unbound = claimMove(row) === null;
      return [
        { label: "custom", commit: capture },
        unbound || claimMove(row) !== undefined
          ? { label: "restore keybind", commit: () => void decide(row, null, "claim") }
          : { label: "unset keybind", commit: () => void decide(row, { choice: "terminal" }, "claim") },
      ];
    }
    if (side === "left") {
      const unbound = terminalMove(row) === null;
      return [
        { label: "custom", commit: capture },
        unbound
          ? { label: "restore keybind", commit: () => void decide(row, null) }
          : { label: "unset keybind", commit: () => void decide(row, { choice: "terminal" }) },
      ];
    }
    const unset = editorUnset(row);
    return [
      { label: "custom", commit: capture },
      unset
        ? { label: "restore keybind", commit: () => void decide(row, null) }
        : { label: "unset keybind", commit: () => void decide(row, { choice: "keep" }) },
    ];
  }

  function renderBox(row: Row, side: "left" | "right", mini: boolean) {
    const colliding = collisions(row);
    const isStatic =
      side === "left" && row.kind === "import" && (row.claimant || "imported") === "imported";
    const isCapturing =
      !!capturing && "id" in capturing && capturing.id === row.id && capturing.side === side;
    const menuOpen = !!menu && menu.id === row.id && menu.side === side;
    let shown: string;
    let extra = "";
    if (side === "left") {
      const moved = row.kind === "import" ? claimMove(row) : terminalMove(row);
      shown = isCapturing ? "press a chord…" : moved === undefined ? row.id : moved === null ? "unbound" : moved;
      if (isCapturing) extra = " capturing";
      else if (moved === null) extra = " unbound";
      else if (colliding.has(shown)) extra = " clash";
      if (isStatic) extra += " static";
    } else {
      shown = isCapturing ? "press a chord…" : editorUnset(row) ? "unset" : editorKey(row);
      if (isCapturing) extra = " capturing";
      else if (editorUnset(row)) extra = " unbound";
      else if (colliding.has(shown)) extra = " clash";
    }
    const onClick = (event: React.MouseEvent) => {
      event.stopPropagation();
      if (capturing) {
        // clicking any box while one is listening stops the capture and opens
        // the clicked box's menu — no box is ever dead to a click
        setCapturing(null);
        setWarning(null);
        setMenu({ id: row.id, side });
        return;
      }
      setMenu(menuOpen ? null : { id: row.id, side });
    };
    return (
      <div className="boxwrap">
        {isCapturing && manual === "typing" ? (
          manualInput()
        ) : (
          <button
            className={"box" + (mini ? " mini" : "") + extra}
            onClick={isStatic ? undefined : onClick}
          >
            <span>{shown}</span>
            {!isStatic && <PenIcon />}
          </button>
        )}
        {isCapturing && manual === "offered" && manualOffer()}
        {menuOpen && !isStatic && (
          <div className="menu" onClick={(event) => event.stopPropagation()}>
            {menuItems(row, side).map((item) => (
              <button
                key={item.label}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu(null);
                  item.commit();
                }}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  /** A claimant's binding as one more column in the duel — the same box, menu
   * and capture the other columns have, because it is simply a third shortcut
   * being managed. */
  function renderClaimBox(row: Row, claim: Claim, mini: boolean) {
    const menuId = "claim:" + claim.chord + ":" + claim.command;
    const isCapturing =
      !!capturing && "claim" in capturing &&
      capturing.claim.chord === claim.chord && capturing.claim.command === claim.command;
    const menuOpen = !!menu && menu.id === menuId;
    const held = claim.state; // undefined = still holds its chord
    const shown = isCapturing
      ? "press a chord…"
      : held === undefined ? claim.chord : held?.key ? held.key : "unbound";
    let extra = "";
    if (isCapturing) extra = " capturing";
    else if (held !== undefined && !held?.key) extra = " unbound";
    else if (collisions(row).has(shown)) extra = " clash";
    return (
      <div className="boxwrap">
        {isCapturing && manual === "typing" ? (
          manualInput()
        ) : (
          <button
            className={"box" + (mini ? " mini" : "") + extra}
            onClick={(event) => {
              event.stopPropagation();
              if (capturing) {
                setCapturing(null);
                setWarning(null);
                setMenu({ id: menuId, side: "claim" });
                return;
              }
              setMenu(menuOpen ? null : { id: menuId, side: "claim" });
            }}
          >
            <span>{shown}</span>
            <PenIcon />
          </button>
        )}
        {isCapturing && manual === "offered" && manualOffer()}
        {menuOpen && (
          <div className="menu" onClick={(event) => event.stopPropagation()}>
            {[
              {
                label: "custom",
                commit: () => {
                  setMenu(null);
                  setCapturing({ claim, rowId: row.id });
                },
              },
              held !== undefined
                ? { label: "restore keybind", commit: () => void decideClaimChord(claim, null) }
                : { label: "unset keybind", commit: () => void decideClaimChord(claim, { choice: "terminal" }) },
            ].map((item) => (
              <button
                key={item.label}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu(null);
                  item.commit();
                }}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderColumn(row: Row, side: "left" | "right") {
    const logo =
      side === "left" ? (row.kind === "terminal" ? state.logos.terminal : null) : state.logos.editor;
    const name =
      side === "left" ? (row.kind === "terminal" ? row.terminal.name : row.claimant || "imported") : "terminal-code";
    // both sides describe themselves in the same table of labelled rows; the
    // editor side has more to say — the command id and the holding binding's
    // guard its description was generated from
    const entries: [string, string][] =
      side === "right" && row.detail
        ? [
            ["description", row.means],
            ["command", row.detail.command],
            ...(row.detail.when ? ([["when", row.detail.when]] as [string, string][]) : []),
          ]
        : [
            [
              "description",
              side === "left"
                ? row.kind === "import"
                  ? row.claimant && row.claimant !== "imported"
                    ? row.claimDescribes || row.importedCommand || ""
                    : "an imported keybinding: " + row.importedCommand
                  : row.terminal.short
                : row.means,
            ],
          ];
    return (
      <div className="app">
        <div className="name">
          {logo ? <img src={logo} alt="" /> : null}
          <span>{name}</span>
        </div>
        {renderBox(row, side, false)}
        <div className="caption">
          <DetailTable entries={entries} />
        </div>
      </div>
    );
  }

  function renderClaimColumn(row: Row, claim: Claim) {
    const entries: [string, string][] = [
      ["description", claim.describes],
      ["command", claim.command],
      ...(claim.when ? ([["when", claim.when]] as [string, string][]) : []),
    ];
    return (
      <div className="app" key={claim.chord + ":" + claim.command}>
        <div className="name">{claim.claimant}</div>
        {renderClaimBox(row, claim, false)}
        <div className="caption">
          <DetailTable entries={entries} />
        </div>
      </div>
    );
  }

  /** The duel is the one conflict component: the two sides of a chord, plus
   * any claimant columns that joined. */
  function renderDuel(row: Row) {
    const contested = [...collisions(row)];
    return (
      <div className="duel-block">
        <div className="duel">
          {renderColumn(row, "left")}
          {renderColumn(row, "right")}
          {claimsOf(row).map((claim) => renderClaimColumn(row, claim))}
        </div>
        <div className={"verdict" + (contested.length ? " bad" : " good")}>
          {contested.length === 0 ? "no conflict" : "conflict detected"}
        </div>
      </div>
    );
  }

  function renderStepNav() {
    return (
      <>
        <div className="steps">
          <button className="step" disabled={at === FIRST} onClick={() => move(-1)}>
            <ArrowLeftIcon />
          </button>
          <button className="step" id="next" disabled={at >= rows.length} onClick={tryNext}>
            <ArrowRightIcon />
          </button>
        </div>
        <div className="warn">{warning ? "⚠ " + warning : ""}</div>
      </>
    );
  }

  function renderConflict(row: Row) {
    // one hint, visible on the first screen only — by the second one it is
    // muscle memory. The space stays reserved on every step, so leaving step
    // one never shifts the boxes below. The arrows drop onto each chord box.
    return (
      <main>
        <div className={"tipwrap" + (at === 0 ? "" : " ghost")}>
          <div className="tip">click to remap shortcut</div>
          {/* straight lines with one 90° elbow each, dropping past the app
              names to rest on each chord box's top edge — the arrows must
              touch what they mean: the button */}
          <svg className="tiparrows" width={560} height={72} viewBox="0 0 560 72" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M262 6 L 210 6 L 210 60" /><path d="M204 53 L 210 61 L 216 53" />
            <path d="M298 6 L 350 6 L 350 60" /><path d="M344 53 L 350 61 L 356 53" />
          </svg>
        </div>
        {renderDuel(row)}
        {renderStepNav()}
      </main>
    );
  }

  /** One message, two buttons. Everything the user needs to know is one
   * sentence; anything else on this screen is competition. */
  function renderIntro() {
    return (
      <main>
        <div className="intro">
          <div className="introlead">
            terminal-code and {state.terminalName} have <strong className="introcount">{rows.length}</strong>{" "}
            conflicting shortcuts.
          </div>
          <div className="introrest">
            For the best experience, continue onboarding to resolve the shortcut conflicts. You can
            also skip this step and run <kbd>tode shortcut-setup</kbd> to resolve them later.
          </div>
          <div className="introrest">Estimated Time: {estimatedMinutes(rows.length)}</div>
          <div className="introactions">
            <button onClick={() => void finish()}>do later</button>
            <button
              className="primary"
              id="intro-go"
              onClick={() => {
                setWarning(null);
                setCapturing(null);
                setModal(null);
                setMenu(null);
                setAt(resumeAt);
              }}
            >
              continue
            </button>
          </div>
        </div>
      </main>
    );
  }

  /** Nothing lands until the button. The receipt is the real table — every
   * managed chord with the same live cells the steps use, edited inline. */
  function renderConfirm() {
    // one column per claimant that is involved anywhere: session claim
    // columns plus the claimant side of import rows
    const claimants: string[] = [];
    for (const row of rows) {
      if (row.kind === "import" && row.claimant && !claimants.includes(row.claimant)) {
        claimants.push(row.claimant);
      }
      for (const claim of claimsOf(row)) {
        if (!claimants.includes(claim.claimant)) claimants.push(claim.claimant);
      }
    }
    const open = rows.filter((row) => conflicted(row));
    const head = (logo: string | null, label: string) => (
      <div className="f-head" key={"head:" + label}>
        {logo ? <img src={logo} alt="" /> : null}
        <span>{label}</span>
      </div>
    );
    return (
      <main className="confirm">
        <div className="title">review and confirm</div>
        <div
          className="final"
          style={{ gridTemplateColumns: `max-content repeat(${2 + claimants.length}, minmax(10rem, 1fr))` }}
        >
          <div className="f-head" />
          {head(state.logos.terminal, state.terminalName)}
          {head(state.logos.editor, "terminal-code")}
          {claimants.map((claimant) => head(null, claimant))}
          {rows.map((row) => (
            <Fragment key={row.id}>
              <div className="f-chord">{row.id}</div>
              {row.kind === "terminal" ? renderBox(row, "left", true) : <div />}
              {renderBox(row, "right", true)}
              {claimants.map((claimant) => {
                const claim = claimsOf(row).find((entry) => entry.claimant === claimant);
                return (
                  <Fragment key={claimant}>
                    {claim
                      ? renderClaimBox(row, claim, true)
                      : row.kind === "import" && row.claimant === claimant
                        ? renderBox(row, "left", true)
                        : <div />}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </div>
        <div className="confirmnav">
          <button className="go quiet" disabled={rows.length === 0} onClick={() => setAt(rows.length - 1)}>
            <ArrowLeftIcon />
            <span>back</span>
          </button>
          <button
            className="go"
            id="apply"
            onClick={async () => {
              await post("/confirm", {});
              void finish();
            }}
          >
            apply these changes
          </button>
        </div>
        <div className="warn">
          {warning ? "⚠ " + warning : open.length ? `${open.length} still conflicting` : ""}
        </div>
      </main>
    );
  }

  function renderModal() {
    if (!modal) return null;
    const dismiss = () => setModal(null);
    if ("doLater" in modal) {
      // decisions staged this session are real work; leaving should offer to
      // land them rather than silently walking away from them
      const pending = touched ? rows.filter((row) => row.decision).length : 0;
      return (
        <div className="veil" onClick={(event) => event.target === event.currentTarget && dismiss()}>
          <div className="modal">
            <button className="x" onClick={dismiss}>✕</button>
            <div className="title">finish this later</div>
            {pending > 0 && (
              <div className="note">
                {pending} resolved shortcut{pending === 1 ? " has" : "s have"} not been applied yet.
              </div>
            )}
            <div className="note">
              You can run <kbd>tode shortcut-setup</kbd> in your terminal to continue resolving shortcuts.
            </div>
            <div className="actions compact">
              {pending > 0 ? (
                <>
                  <button className="option" onClick={() => void finish()}>
                    {state.continues ? "continue without applying" : "quit without applying"}
                  </button>
                  <button
                    className="option primary"
                    onClick={async () => {
                      await post("/confirm", {});
                      void finish();
                    }}
                  >
                    apply and continue
                  </button>
                </>
              ) : (
                <button className="option primary" onClick={() => void finish()}>
                  {state.continues ? "continue to terminal-code" : "quit"}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    const row = currentRow();
    return (
      <div className="veil" onClick={(event) => event.target === event.currentTarget && dismiss()}>
        <div className="modal">
          <button className="x" onClick={dismiss}>✕</button>
          <div className="title">shortcuts still conflict</div>
          <div className="actions split">
            <button
              className="option"
              onClick={async () => {
                setModal(null);
                if (row) await decide(row, { choice: "keep" });
                move(1);
              }}
            >
              <span>unset</span>
              <TodeChip />
              <span>bind</span>
            </button>
            <button
              className="option danger"
              onClick={() => {
                setModal(null);
                move(1);
              }}
            >
              continue with conflict
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="progress">
          {at >= 0 && at < rows.length ? `${at + 1} of ${rows.length}` : ""}
        </div>
        {at >= 0 && (
          <button className="later" onClick={() => setModal({ doLater: true })}>
            do later
          </button>
        )}
      </div>
      {at < 0 ? renderIntro() : at >= rows.length ? renderConfirm() : renderConflict(rows[at])}
      {at >= 0 && (
        <div className="nav">
          <kbd>ctrl+c</kbd> quit · <kbd>←</kbd> back · <kbd>→</kbd> forward
        </div>
      )}
      {renderModal()}
    </>
  );
}

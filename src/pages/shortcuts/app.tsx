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
}

/** A claimant column that joined a row's duel this session: a third (fourth,
 * …) shortcut being managed alongside the two. `state` is undefined while the
 * claim still holds its own chord. */
interface Claim {
  chord: string;
  command: string;
  claimant: string;
  describes: string;
  when?: string;
  state?: Decision | null;
}

export interface ManagerState {
  rows: Row[];
  terminalName: string;
  reloadHint: string;
  intro: boolean;
  logos: { terminal: string | null; editor: string | null };
}

type Capturing = { id: string; side: "left" | "right" } | { claim: Claim };
type Menu = { id: string; side: string };
type Modal = { doLater: true } | { conflict: true };
type Claims = Record<string, Claim[]>;

const post = async (url: string, payload: unknown) => {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
  return response.json();
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

/** Every chord this row's sides currently show: the terminal (or claimant)
 * on the left, tode on the right, plus any claimant columns that joined. */
function rowChords(row: Row, claims: Claims): string[] {
  const list: string[] = [];
  const move = row.kind === "import" ? claimMove(row) : terminalMove(row);
  const left = move === undefined ? row.id : move;
  if (left) list.push(left);
  if (!editorUnset(row)) list.push(editorKey(row));
  for (const claim of claims[row.id] ?? []) {
    const held = claim.state === undefined ? claim.chord : claim.state?.key;
    if (held) list.push(held);
  }
  return list;
}

/** The chords bound by more than one side — conflict is a fact about the
 * values on screen, nothing else. */
function collisions(row: Row, claims: Claims): Set<string> {
  const counts: Record<string, number> = {};
  for (const chord of rowChords(row, claims)) counts[chord] = (counts[chord] ?? 0) + 1;
  return new Set(Object.keys(counts).filter((chord) => counts[chord] > 1));
}

const conflicted = (row: Row, claims: Claims) => collisions(row, claims).size > 0;

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

/** One labelled-rows table, the shape every column's caption uses. */
function DetailTable({ entries }: { entries: [string, string][] }) {
  return (
    <div className="detail">
      {entries.map(([label, value]) => (
        <Fragment key={label}>
          <div className="k">{label}</div>
          <div className="v">{value}</div>
        </Fragment>
      ))}
    </div>
  );
}

export function App({ state }: { state: ManagerState }) {
  const FIRST = state.intro ? -1 : 0;
  const [rows, setRows] = useState<Row[]>(state.rows);
  const [at, setAt] = useState(FIRST);
  const [capturing, setCapturing] = useState<Capturing | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [claims, setClaims] = useState<Claims>({});
  // whether this session staged anything — what "unapplied changes" means
  const [touched, setTouched] = useState(false);

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
    if (!row || !conflicted(row, claims)) return move(1);
    setModal({ conflict: true });
  }

  async function decide(row: Row, decision: Decision | null, side?: "claim") {
    const fresh = await post("/decide", { id: row.id, kind: row.kind, decision, side });
    // an error body carries no rows; keeping the old ones keeps the page
    // alive to show the warning
    if (fresh.rows) setRows(fresh.rows);
    setWarning(fresh.ok === false ? fresh.warning : null);
    if (fresh.ok !== false) setTouched(true);
    setCapturing(null);
    setMenu(null);
  }

  async function decideClaimChord(claim: Claim, decision: Decision | null) {
    const fresh = await post("/decide", { id: claim.chord, kind: "claim", decision });
    if (fresh.rows) setRows(fresh.rows);
    setClaims((prev) => {
      const next: Claims = {};
      for (const [id, list] of Object.entries(prev)) {
        next[id] = list.map((entry) =>
          entry.chord === claim.chord ? { ...entry, state: decision ?? undefined } : entry,
        );
      }
      return next;
    });
    setMenu(null);
    setCapturing(null);
  }

  async function applyChord(row: Row, side: "left" | "right", chord: string) {
    const checked = await post("/taken", { chord, id: row.id });
    if (!checked.ok && !checked.claim) {
      setWarning(checked.warning);
      setCapturing(null);
      return;
    }
    if (checked.claim) {
      // an extension holds the chord — the capture applies anyway (a user
      // keybinding outranks the extension's), and the claimant joins the row
      // so the value collision is visible and resolvable in place
      setClaims((prev) => {
        const list = prev[row.id] ?? [];
        if (list.some((entry) => entry.chord === checked.claim.chord)) return prev;
        return { ...prev, [row.id]: [...list, { ...checked.claim, state: undefined }] };
      });
    }
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

  async function captureClaimKey(event: KeyboardEvent, claim: Claim) {
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(null);
      setWarning(null);
      return;
    }
    const chord = chordFrom(event);
    if (!chord) return;
    const checked = await post("/taken", { chord, id: claim.chord });
    if (!checked.ok) {
      setWarning(checked.warning);
      return;
    }
    await decideClaimChord(
      claim,
      checked.chord === claim.chord ? null : { choice: "terminal", key: checked.chord },
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
      // while recording, every key is a candidate chord — including ctrl+c
      if (capturing && "claim" in capturing) return void captureClaimKey(event, capturing.claim);
      if (capturing) return void captureKey(event, capturing);
      // ctrl+c quits from anywhere else, the way it would in the terminal
      if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void post("/done", {});
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
      else if (key === "q") void post("/done", {});
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
      <span>terminal-browser</span>
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
    const colliding = collisions(row, claims);
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
        // clicking the box that is listening stops the capture and brings its
        // menu back — custom starts it again, unset unsets
        if (!isCapturing) return;
        setCapturing(null);
        setMenu({ id: row.id, side });
        return;
      }
      setMenu(menuOpen ? null : { id: row.id, side });
    };
    return (
      <div className="boxwrap">
        <button
          className={"box" + (mini ? " mini" : "") + extra}
          onClick={isStatic ? undefined : onClick}
        >
          <span>{shown}</span>
          {!isStatic && <PenIcon />}
        </button>
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
    const menuId = "claim:" + claim.chord;
    const isCapturing =
      !!capturing && "claim" in capturing && capturing.claim.chord === claim.chord;
    const menuOpen = !!menu && menu.id === menuId;
    const held = claim.state; // undefined = still holds its chord
    const shown = isCapturing
      ? "press a chord…"
      : held === undefined ? claim.chord : held?.key ? held.key : "unbound";
    let extra = "";
    if (isCapturing) extra = " capturing";
    else if (held !== undefined && !held?.key) extra = " unbound";
    else if (collisions(row, claims).has(shown)) extra = " clash";
    return (
      <div className="boxwrap">
        <button
          className={"box" + (mini ? " mini" : "") + extra}
          onClick={(event) => {
            event.stopPropagation();
            if (capturing) return;
            setMenu(menuOpen ? null : { id: menuId, side: "claim" });
          }}
        >
          <span>{shown}</span>
          <PenIcon />
        </button>
        {menuOpen && (
          <div className="menu" onClick={(event) => event.stopPropagation()}>
            {[
              {
                label: "custom",
                commit: () => {
                  setMenu(null);
                  setCapturing({ claim });
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
      side === "left" ? (row.kind === "terminal" ? row.terminal.name : row.claimant || "imported") : "terminal-browser";
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
    return (
      <div className="app" key={claim.chord}>
        <div className="name">{claim.claimant}</div>
        {renderClaimBox(row, claim, false)}
        <div className="caption">
          <DetailTable entries={[["description", claim.describes]]} />
        </div>
      </div>
    );
  }

  /** The duel is the one conflict component: the two sides of a chord, plus
   * any claimant columns that joined. */
  function renderDuel(row: Row) {
    const contested = [...collisions(row, claims)];
    return (
      <div className="duel-block">
        <div className="duel">
          {renderColumn(row, "left")}
          {renderColumn(row, "right")}
          {(claims[row.id] ?? []).map((claim) => renderClaimColumn(row, claim))}
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
          <svg className="tiparrows" width={560} height={48} viewBox="0 0 560 48" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M262 6 L 192 6 L 192 38" /><path d="M186 31 L 192 39 L 198 31" />
            <path d="M298 6 L 368 6 L 368 38" /><path d="M362 31 L 368 39 L 374 31" />
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
            terminal-browser and {state.terminalName} have <strong className="introcount">{rows.length}</strong>{" "}
            conflicting shortcuts.
          </div>
          <div className="introrest">
            For the best experience, continue onboarding to resolve the shortcut conflicts. You can
            also skip this step and run <kbd>tode shortcuts</kbd> to resolve them later.
          </div>
          <div className="introactions">
            <button onClick={() => void post("/done", {})}>do later</button>
            <button className="primary" id="intro-go" onClick={() => move(1)}>
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
      for (const claim of claims[row.id] ?? []) {
        if (!claimants.includes(claim.claimant)) claimants.push(claim.claimant);
      }
    }
    const open = rows.filter((row) => conflicted(row, claims));
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
          {head(state.logos.editor, "terminal-browser")}
          {claimants.map((claimant) => head(null, claimant))}
          {rows.map((row) => (
            <Fragment key={row.id}>
              <div className="f-chord">{row.id}</div>
              {row.kind === "terminal" ? renderBox(row, "left", true) : <div />}
              {renderBox(row, "right", true)}
              {claimants.map((claimant) => {
                const claim = (claims[row.id] ?? []).find((entry) => entry.claimant === claimant);
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
        <button
          className="go"
          id="apply"
          onClick={async () => {
            await post("/confirm", {});
            void post("/done", {});
          }}
        >
          apply these changes
        </button>
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
              You can run <kbd>tode shortcuts</kbd> in your terminal to continue resolving shortcuts.
            </div>
            <div className="actions compact">
              {pending > 0 ? (
                <>
                  <button className="option" onClick={() => void post("/done", {})}>
                    continue without applying
                  </button>
                  <button
                    className="option primary"
                    onClick={async () => {
                      await post("/confirm", {});
                      void post("/done", {});
                    }}
                  >
                    apply and continue
                  </button>
                </>
              ) : (
                <button className="option primary" onClick={() => void post("/done", {})}>
                  continue to terminal-browser
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
              className="option danger"
              onClick={() => {
                setModal(null);
                move(1);
              }}
            >
              continue with conflict
            </button>
            <button
              className="option primary"
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

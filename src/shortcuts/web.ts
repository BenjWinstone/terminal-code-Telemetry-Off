import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { TerminalPalette } from "../terminal/osc";
import { hex } from "../theme/color";
import { cssTokens } from "../webui/tokens";
import type { Decision } from "./store";

/** One contested chord, flattened for the page. `kind` says who the other
 * claimant is: the terminal, or a keybinding the user imported. */
export interface ManagerRow {
  id: string;
  kind: "terminal" | "import";
  /** What the editor runs on the chord. */
  means: string;
  suggestion?: string;
  recommend: "terminal" | "editor" | "keep";
  /** Chords decided together on one screen; only catalog rows carry one. */
  group?: string;
  /** For a derived row: the raw editor command id and its when guard — the
   * metadata the auto-generated label was made from. */
  detail?: string;
  terminal: {
    name: string;
    short: string;
    does: string;
    freed: string;
    tradeoff: string;
    /** Bound if tode freed nothing — the staged decision says the rest. */
    bound: boolean;
  };
  importedCommand?: string;
  /** who else holds the chord: "imported", or an extension's display name */
  claimant?: string;
  /** a human reading of what the claimant's binding does */
  claimDescribes?: string;
  /** the decision about the claimant's own side (unset or moved), staged
   * under its own key so it never collides with the tode-side decision */
  claimDecision?: Decision | null;
  decision: Decision | null;
}

export interface StepAction {
  id: string;
  label: string;
}

/** What the manager walks through, one screen each. Conflicts are the
 * built-in duel; groups decide related chords together; custom steps are
 * whatever the backend wants to offer (an extension install, a hint), with
 * its actions handled server-side through act(). */
export type ManagerStep =
  | { kind: "conflict"; row: ManagerRow }
  | { kind: "group"; id: string; title: string; rows: ManagerRow[] }
  | { kind: "custom"; id: string; title: string; body: string; actions: StepAction[] };

export interface ManagerDeps {
  steps(): ManagerStep[];
  /** Every managed row, decided or not — the confirm screen's table. */
  allRows(): ManagerRow[];
  /** What already holds a candidate chord, or null when it is free. When an
   * extension holds it, `claim` describes the binding so the page can offer
   * to unset or move it on the spot. */
  taken(chord: string): {
    holder: string;
    claim?: { chord: string; command: string; claimant: string; describes: string; when?: string };
  } | null;
  /** Canonical form of a chord the page sends, or null when it is not one. */
  normalize(chord: string): string | null;
  /** Stages one row's decision in memory (null clears it). Nothing lands on
   * disk until confirm(). */
  decide(
    id: string,
    kind: "terminal" | "import" | "claim",
    decision: Decision | null,
    side?: "claim" | "own",
  ): void;
  /** Runs a step's action — group bulk decisions, custom-step work like an
   * extension install. Returns a note for the page to show. */
  act(stepId: string, actionId: string): { note?: string } | Promise<{ note?: string }>;
  /** Writes everything staged: the terminal's freed file, the decisions
   * store, keybindings.json. */
  confirm(): { note: string };
  reloadHint: string;
  terminalName: string;
  palette: TerminalPalette;
  /** First-run mode: open on an intro screen that says why this is here. */
  intro?: boolean;
}

function logoDataUri(name: string): string | null {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "logos", `${name}.png`);
    if (fs.existsSync(candidate)) {
      return `data:image/png;base64,${fs.readFileSync(candidate).toString("base64")}`;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** JSON safe to inline in a <script> block: the only dangerous byte there is
 * the one that could open or close a tag. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildPage(deps: ManagerDeps): string {
  const p = deps.palette;
  const state = {
    steps: deps.steps(),
    table: deps.allRows(),
    terminalName: deps.terminalName,
    reloadHint: deps.reloadHint,
    intro: deps.intro === true,
    logos: { terminal: logoDataUri("ghostty"), editor: logoDataUri("tode") },
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tode shortcuts</title>
<style>
  ${cssTokens(p)}
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 2rem 1.5rem;
    display: flex; flex-direction: column; align-items: center;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  }
  .topbar {
    align-self: flex-end; display: flex; align-items: baseline; gap: 1.1rem;
  }
  .progress { color: var(--faint); }
  .later {
    font: inherit; color: var(--faint); background: none; cursor: pointer;
    border: 1px solid var(--line); padding: .2rem .6rem;
  }
  .later:hover { color: var(--fg); border-color: var(--dim); }
  main {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start; gap: 0;
    padding-top: clamp(2rem, 18vh, 9rem);
    width: 100%; max-width: 44rem; text-align: center;
  }
  /* the confirm table is tall — the vertical centering that suits a single
     duel would push it off the bottom instead */
  main.confirm { padding-top: 1.2rem; }
  .duel { display: flex; gap: 3.5rem; justify-content: center; flex-wrap: wrap; }
  .app { display: flex; flex-direction: column; align-items: center; width: 15rem; }
  .name {
    display: flex; align-items: center; gap: .45rem;
    font-weight: 700; margin-bottom: .55rem;
  }
  .name img { width: 15px; height: 15px; }
  .boxwrap { position: relative; width: 100%; }
  .box {
    position: relative; width: 100%; padding: .85rem 2.2rem; font: inherit; font-weight: 600;
    color: var(--fg); background: none; cursor: pointer;
    border: 2px solid var(--line);
  }
  .box.clash { border-color: var(--clash); }
  .box.unbound { color: var(--dim); border-style: dashed; }
  .box.capturing { color: var(--dim); }
  .box.static { cursor: default; }
  .box .pen {
    position: absolute; left: .8rem; top: 50%; transform: translateY(-50%);
    color: var(--dim); opacity: 0; display: flex;
  }
  .icon svg { display: block; }
  .box:not(.static):hover .pen, .box:not(.static):focus .pen { opacity: 1; }
  .box:not(.static):focus { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--fg) 18%, var(--bg)); }
  .menu {
    position: absolute; top: calc(100% + .35rem); left: 0; right: 0; z-index: 5;
    padding: .25rem; text-align: left;
    background: var(--bg); border: 1px solid var(--line);
    box-shadow: 0 8px 30px color-mix(in srgb, #000 45%, transparent);
  }
  .menu button {
    display: flex; gap: .55rem; align-items: baseline; width: 100%; padding: .35rem .6rem;
    font: inherit; color: var(--fg); background: none; border: none;
    cursor: pointer; text-align: left;
  }
  .menu button:hover, .menu button:focus { background: color-mix(in srgb, var(--fg) 8%, var(--bg)); outline: none; }
  .tipwrap { position: relative; margin-bottom: 2.6rem; }
  .tip { color: var(--faint); }
  .tiparrows {
    position: absolute; top: calc(100% + 4px); left: 50%; transform: translateX(-50%);
    color: var(--faint); pointer-events: none;
  }
  /* the duel wraps to one column on a narrow pane; arrows to nowhere go */
  @media (max-width: 620px) { .tiparrows { display: none; } }
  .caption { color: var(--dim); margin-top: .5rem; min-height: 3.1em; }
  /* every step's caption region is the same height, so the verdict and the
     arrows below never move between steps — sized for a full command id plus
     its guard, nothing truncated */
  .duel-block:not(.tight) .caption { height: 7.8em; overflow: hidden; }
  .caption .detail {
    color: var(--faint); font-size: 11px; margin-top: .3rem;
    overflow-wrap: anywhere; white-space: pre-line;
  }
  .tipwrap.ghost { visibility: hidden; }
  .verdict { margin: 1.6rem 0 0; min-height: 1.6em; }
  .verdict.bad { color: var(--red); }
  .verdict.good { color: var(--green); }
  .steps { display: flex; gap: .8rem; margin-top: 1.1rem; }
  .step {
    width: 3.2rem; padding: .5rem 0; font: inherit;
    display: flex; align-items: center; justify-content: center;
    color: var(--fg); background: none; cursor: pointer;
    border: 1px solid var(--line);
  }
  .step:hover { background: var(--lift); }
  .step:focus { outline: none; border-color: var(--soft); background: var(--lift); }
  .step[disabled] { opacity: .35; cursor: default; }
  .warn { color: var(--yellow); margin-top: .6rem; min-height: 1.3em; }
  .warn.good { color: var(--green); }
  .nav { color: var(--faint); margin-top: 2.2rem; }
  .title { font-weight: 700; }
  .body { color: var(--dim); max-width: 32rem; margin-top: .7rem; }
  .stack { display: flex; flex-direction: column; gap: 1.4rem; margin-top: 1.6rem; }
  .verdict.tight { margin-top: .2rem; min-height: 1.5em; }
  .actions { display: flex; gap: .6rem; margin-top: 1.2rem; flex-wrap: wrap; justify-content: center; }
  .option {
    flex: 1 1 auto; display: inline-flex; flex-wrap: wrap; align-items: center;
    justify-content: center; gap: .45rem; padding: .45rem 1rem; min-width: 0;
    font: inherit; color: var(--fg); background: none;
    border: 1px solid var(--line); cursor: pointer;
  }
  .option:hover { background: var(--lift); }
  .option:focus { outline: none; border-color: var(--soft); background: var(--lift); }
  .chip {
    display: inline-flex; align-items: center; gap: .35rem;
    padding: .05rem .45rem; border: 1px solid var(--line);
    background: color-mix(in srgb, var(--fg) 6%, var(--bg));
  }
  .chip img { width: 13px; height: 13px; }
  /* on a primary button the chip sits on the inverted fill, so its dark-page
     colours flip with it — otherwise its label lands dark-on-dark */
  .option.primary .chip {
    border-color: color-mix(in srgb, var(--bg) 35%, var(--fg));
    background: color-mix(in srgb, var(--bg) 8%, var(--fg));
    color: var(--bg);
  }
  .done-list { color: var(--dim); margin: .8rem 0 0; line-height: 1.9; }
  .final {
    display: grid;
    gap: .55rem 1rem; align-items: center; margin-top: 1.4rem;
    width: 100%; max-width: 52rem;
  }
  .f-head { color: var(--faint); display: flex; gap: .4rem; align-items: center; justify-content: center; font-weight: 700; }
  .f-head img { width: 14px; height: 14px; }
  .f-chord { font-weight: 600; text-align: left; }

  .box.mini { padding: .4rem 1.6rem; border-width: 1.5px; font-weight: 500; }
  .box.mini .pen { left: .4rem; }
  .go {
    margin-top: 1.6rem; padding: .6rem 1.8rem; font: inherit;
    display: inline-flex; align-items: center; gap: .5rem;
    color: var(--fg); background: none; cursor: pointer;
    border: 1px solid var(--line);
  }
  .go:hover { background: var(--lift); }
  .go:focus { outline: none; border-color: var(--soft); background: var(--lift); }
  .go[disabled] { opacity: .4; cursor: default; }
  .intro { text-align: left; max-width: 34rem; width: 100%; }
  .introlead { color: var(--fg); }
  .introcount { font-weight: 700; }
  .introrest { color: var(--dim); margin-top: .8rem; }
  .introactions { display: flex; gap: 1rem; margin-top: 2rem; }
  .introactions button {
    font: inherit; padding: .65rem 1.7rem; cursor: pointer; white-space: nowrap;
    color: var(--dim); background: none; border: 1px solid var(--line);
  }
  .introactions button:hover { color: var(--fg); border-color: var(--dim); }
  .introactions button.primary {
    color: var(--bg); background: var(--fg); border-color: var(--fg); font-weight: 600;
  }
  .introactions button.primary:hover { opacity: .88; }
  .introactions button:focus { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--fg) 18%, var(--bg)); }
  .veil {
    position: fixed; inset: 0; display: flex; align-items: flex-start; justify-content: center;
    padding-top: clamp(2rem, 18vh, 9rem);
    background: color-mix(in srgb, var(--bg) 72%, transparent);
  }
  .modal {
    position: relative; background: var(--bg); border: 1px solid var(--line);
    padding: 1.2rem 1.4rem; min-width: min(24rem, 92vw); max-width: min(40rem, 92vw); text-align: left;
    box-shadow: 0 12px 40px color-mix(in srgb, #000 45%, transparent);
  }
  .modal .title { margin: 0 1.4rem 1rem 0; }
  .modal .actions { margin-top: 0; }
  .modal .note { color: var(--dim); margin: 0 0 1.1rem; }
  .actions.compact { justify-content: flex-end; margin-top: 1.3rem; }
  .actions.compact .option { flex: 0 0 auto; padding: .5rem 1.2rem; }
  .option.primary { color: var(--bg); background: var(--fg); border-color: var(--fg); font-weight: 600; }
  .option.primary:hover { opacity: .88; background: var(--fg); }
  .actions.split { justify-content: space-between; margin-top: 1.3rem; }
  .actions.split .option { flex: 0 0 auto; padding: .5rem 1.2rem; }
  .option.danger { border-color: transparent; color: var(--red); }
  .option.danger:hover { background: color-mix(in srgb, var(--red) 12%, var(--bg)); }
  .modal .x {
    position: absolute; top: .35rem; right: .45rem; padding: .15rem .45rem;
    font: inherit; color: var(--faint); background: none; border: none; cursor: pointer;
  }
  .modal .x:hover { color: var(--fg); }
  kbd {
    border: 1px solid var(--line); border-bottom-width: 2px;
    padding: 0 .35ch; font: inherit;
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="progress" id="progress"></div>
  <button class="later" id="later" type="button">do later</button>
</div>
<main id="main"></main>
<div class="nav" id="nav"></div>
<div id="veil"></div>
<script>
const STATE = ${inlineJson(state)};
let steps = STATE.steps;
let table = STATE.table;
const FIRST = STATE.intro ? -1 : 0;
let at = FIRST;
let capturing = null; // { id, side } while recording, or null
let warning = null;   // { tone: "bad" | "good", text }
let modal = null;     // { chord: string | null } or { doLater: true }
// whether this session staged anything — what "unapplied changes" means
let touched = false;
let menu = null;      // { id, side } or null
// claimant columns that joined a row's duel this session, keyed by row id:
// each is a third (fourth, …) shortcut being managed alongside the two
const claims = {};

const post = async (url, payload) => {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
  return response.json();
};

const editorKey = (row) =>
  row.decision && row.decision.choice === "editor" && row.decision.key ? row.decision.key : row.id;

const editorUnset = (row) => !!row.decision && row.decision.choice === "keep";

/** Whether the terminal still holds the contested chord itself. */
const leftBound = (row) =>
  row.kind === "import" ? true : row.terminal.bound && !(row.decision && row.decision.choice === "terminal");

/** Every chord this row's sides currently show: the terminal (or claimant)
 * on the left, tode on the right, plus any claimant columns that joined. */
function rowChords(row) {
  const list = [];
  const move = row.kind === "import" ? claimMove(row) : terminalMove(row);
  const left = move === undefined ? row.id : move;
  if (left) list.push(left);
  if (!editorUnset(row)) list.push(editorKey(row));
  for (const claim of claims[row.id] || []) {
    const held = claim.state === undefined ? claim.chord : claim.state.key;
    if (held) list.push(held);
  }
  return list;
}

/** The chords bound by more than one side — conflict is a fact about the
 * values on screen, nothing else. */
function collisions(row) {
  const counts = {};
  for (const chord of rowChords(row)) counts[chord] = (counts[chord] || 0) + 1;
  return new Set(Object.keys(counts).filter((chord) => counts[chord] > 1));
}

const conflicted = (row) => collisions(row).size > 0;

const allRows = () =>
  steps.flatMap((step) =>
    step.kind === "conflict" ? [step.row] : step.kind === "group" ? step.rows : []);

const currentStep = () => (at >= 0 && at < steps.length ? steps[at] : null);
const currentRow = () => {
  const step = currentStep();
  return step && step.kind === "conflict" ? step.row : null;
};
const rowById = (id) =>
  allRows().find((row) => row.id === id) ?? table.find((row) => row.id === id) ?? null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ICONS = {
  left: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
  right: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  pen: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>',
};

function icon(name, size) {
  const holder = el("span", "icon");
  holder.innerHTML = ICONS[name];
  const svg = holder.firstChild;
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  return holder;
}

const todeChip = () => {
  const unit = el("span", "chip");
  if (STATE.logos.editor) {
    const img = document.createElement("img");
    img.src = STATE.logos.editor;
    unit.appendChild(img);
  }
  unit.appendChild(el("span", null, "tode"));
  return unit;
};

/** Where the terminal's action lives now: its own chord (undefined means no
 * decision), a moved-to chord, or null for unbound. */
const terminalMove = (row) =>
  row.decision && row.decision.choice === "terminal" ? (row.decision.key ?? null) : undefined;

/** Same shape for a claimant's binding (an extension holding the chord). */
const claimMove = (row) =>
  row.claimDecision && row.claimDecision.choice === "terminal"
    ? (row.claimDecision.key ?? null)
    : undefined;

/** Every box opens the same two-item menu: custom, and unset — which turns
 * into restore once the side is unset. Clicking away or esc closes it. */
function menuItems(row, side) {
  const capture = () => {
    menu = null;
    capturing = { id: row.id, side };
    render();
  };
  if (side === "left" && row.kind === "import") {
    const unbound = claimMove(row) === null;
    return [
      { label: "custom", commit: capture },
      unbound || claimMove(row) !== undefined
        ? { label: "restore keybind", commit: () => decide(row, null, "claim") }
        : { label: "unset keybind", commit: () => decide(row, { choice: "terminal" }, "claim") },
    ];
  }
  if (side === "left") {
    const unbound = terminalMove(row) === null;
    return [
      { label: "custom", commit: capture },
      unbound
        ? { label: "restore keybind", commit: () => decide(row, null) }
        : { label: "unset keybind", commit: () => decide(row, { choice: "terminal" }) },
    ];
  }
  const unset = editorUnset(row);
  return [
    { label: "custom", commit: capture },
    unset
      ? { label: "restore keybind", commit: () => decide(row, null) }
      : { label: "unset keybind", commit: () => decide(row, { choice: "keep" }) },
  ];
}

function boxWithMenu(row, side, mini) {
  const wrap = el("div", "boxwrap");
  const box = el("button", "box" + (mini ? " mini" : ""));
  box.id = side + ":" + row.id;
  const colliding = collisions(row);
  const isStatic = side === "left" && row.kind === "import" && (row.claimant || "imported") === "imported";
  const isCapturing = capturing !== null && capturing.id === row.id && capturing.side === side;
  const menuOpen = menu !== null && menu.id === row.id && menu.side === side;
  let shown;
  if (side === "left") {
    const move = row.kind === "import" ? claimMove(row) : terminalMove(row);
    shown = isCapturing ? "press a chord…" : move === undefined ? row.id : move === null ? "unbound" : move;
    if (isCapturing) box.classList.add("capturing");
    else if (move === null) box.classList.add("unbound");
    else if (colliding.has(shown)) box.classList.add("clash");
    if (isStatic) box.classList.add("static");
  } else {
    shown = isCapturing ? "press a chord…" : editorUnset(row) ? "unset" : editorKey(row);
    if (isCapturing) box.classList.add("capturing");
    else if (editorUnset(row)) box.classList.add("unbound");
    else if (colliding.has(shown)) box.classList.add("clash");
  }
  box.appendChild(el("span", null, shown));
  if (!isStatic) {
    const pen = el("span", "pen");
    pen.appendChild(icon("pen", 15));
    box.appendChild(pen);
    box.onclick = (event) => {
      event.stopPropagation();
      if (capturing !== null) {
        // clicking the box that is listening stops the capture and brings its
        // menu back — custom starts it again, unset unsets
        if (!isCapturing) return;
        capturing = null;
        menu = { id: row.id, side };
        render();
        return;
      }
      menu = menuOpen ? null : { id: row.id, side };
      render();
    };
  }
  wrap.appendChild(box);

  if (menuOpen && !isStatic) {
    const list = el("div", "menu");
    list.onclick = (event) => event.stopPropagation();
    for (const item of menuItems(row, side)) {
      const option = el("button", null);
      option.appendChild(el("span", null, item.label));
      option.onclick = (event) => {
        event.stopPropagation();
        menu = null;
        const done = item.commit();
        if (done === null) render();
      };
      list.appendChild(option);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function appColumn(row, side) {
  const app = el("div", "app");
  const name = el("div", "name");
  const logo = side === "left"
    ? (row.kind === "terminal" ? STATE.logos.terminal : null)
    : STATE.logos.editor;
  if (logo) {
    const img = document.createElement("img");
    img.src = logo;
    name.appendChild(img);
  }
  name.appendChild(el("span", null, side === "left"
    ? (row.kind === "terminal" ? row.terminal.name : row.claimant || "imported")
    : "tode"));
  app.appendChild(name);
  app.appendChild(boxWithMenu(row, side, false));
  const caption = el("div", "caption");
  caption.textContent = side === "left"
    ? (row.kind === "import"
       ? (row.claimant && row.claimant !== "imported"
          ? (row.claimDescribes || row.importedCommand)
          : "an imported keybinding: " + row.importedCommand)
       : row.terminal.short)
    : row.means;
  // a derived row's label came from a command id; the id itself and its when
  // guard are the real metadata, so they ride along for anyone who wants them
  if (side === "right" && row.detail) caption.appendChild(el("div", "detail", row.detail));
  app.appendChild(caption);
  return app;
}

/** The duel is the one conflict component; single screens show one, group
 * screens stack several identical ones. */
function duelBlock(row, tight) {
  const holder = el("div", "duel-block" + (tight ? " tight" : ""));
  const duel = el("div", "duel");
  duel.appendChild(appColumn(row, "left"));
  duel.appendChild(appColumn(row, "right"));
  for (const claim of claims[row.id] || []) duel.appendChild(claimColumn(row, claim));
  holder.appendChild(duel);
  const contested = [...collisions(row)];
  holder.appendChild(el("div", "verdict" + (tight ? " tight" : "") + (contested.length ? " bad" : " good"),
    contested.length === 0 ? "no conflict" : "conflict detected"));
  return holder;
}

function stepNav(main) {
  const nav = el("div", "steps");
  const back = el("button", "step");
  back.appendChild(icon("left", 16));
  back.disabled = at === FIRST;
  back.onclick = () => move(-1);
  const next = el("button", "step");
  next.appendChild(icon("right", 16));
  next.id = "next";
  next.disabled = at >= steps.length;
  next.onclick = tryNext;
  nav.appendChild(back);
  nav.appendChild(next);
  main.appendChild(nav);
  const warn = el("div", "warn" + (warning && warning.tone === "good" ? " good" : ""));
  warn.textContent = warning ? (warning.tone === "good" ? warning.text : "⚠ " + warning.text) : "";
  main.appendChild(warn);
  return next;
}

function render() {
  const main = document.getElementById("main");
  main.replaceChildren();
  main.className = at >= steps.length ? "confirm" : "";
  document.getElementById("progress").textContent =
    at >= 0 && at < steps.length ? (at + 1) + " of " + steps.length : "";
  // the intro is one message and two buttons — no corner button, no key hints
  document.getElementById("later").style.display = at < 0 ? "none" : "";
  document.getElementById("nav").innerHTML =
    at < 0 ? "" : "<kbd>ctrl+c</kbd> quit · <kbd>←</kbd> back · <kbd>→</kbd> forward";
  renderModal();

  if (at < 0) return renderIntro(main);
  if (at >= steps.length) return renderConfirm(main);

  const step = steps[at];
  if (step.kind === "conflict") return renderConflict(main, step.row);
  if (step.kind === "group") return renderGroup(main, step);
  return renderCustom(main, step);
}

function renderConflict(main, row) {
  // one hint, visible on the first screen only — by the second one it is
  // muscle memory. The space stays reserved on every step, so leaving step
  // one never shifts the boxes below. The arrows drop onto each chord box.
  {
    const wrap = el("div", "tipwrap" + (at === 0 ? "" : " ghost"));
    wrap.appendChild(el("div", "tip", "click to remap shortcut"));
    // straight lines with one 90° elbow each, ending over the inner ear of
    // either chord box (the duel is 2×15rem boxes with a 3.5rem gap)
    wrap.insertAdjacentHTML(
      "beforeend",
      '<svg class="tiparrows" width="560" height="48" viewBox="0 0 560 48" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M262 6 L 192 6 L 192 38"/><path d="M186 31 L 192 39 L 198 31"/>' +
        '<path d="M298 6 L 368 6 L 368 38"/><path d="M362 31 L 368 39 L 374 31"/>' +
        "</svg>",
    );
    main.appendChild(wrap);
  }
  main.appendChild(duelBlock(row, false));
  const next = stepNav(main);
  if (menu === null && capturing === null) next.focus();
}

function renderGroup(main, step) {
  main.appendChild(el("div", "title", step.title));
  const stack = el("div", "stack");
  for (const row of step.rows) stack.appendChild(duelBlock(row, true));
  main.appendChild(stack);
  const next = stepNav(main);
  if (menu === null && capturing === null) next.focus();
}

function renderCustom(main, step) {
  main.appendChild(el("div", "title", step.title));
  main.appendChild(el("div", "body", step.body));
  const actions = el("div", "actions");
  for (const action of step.actions) {
    const button = el("button", "option", action.label);
    button.onclick = () => act(step, action.id);
    actions.appendChild(button);
  }
  main.appendChild(actions);
  const next = stepNav(main);
  next.focus();
}

/** The eye lands on the headline, drops to the one-line why, then the single
 * button. Nothing else competes. */
/** One message, two buttons. Everything the user needs to know is one
 * sentence; anything else on this screen is competition. */
function renderIntro(main) {
  const wrap = el("div", "intro");
  const lead = el("div", "introlead");
  lead.appendChild(document.createTextNode("tode and " + STATE.terminalName + " have "));
  lead.appendChild(el("strong", "introcount", String(allRows().length)));
  lead.appendChild(document.createTextNode(" conflicting shortcuts."));
  wrap.appendChild(lead);
  const rest = el("div", "introrest");
  rest.appendChild(document.createTextNode(
    "For the best experience, continue onboarding to resolve the shortcut conflicts. " +
    "You can also skip this step and run "));
  rest.appendChild(el("kbd", null, "tode shortcuts"));
  rest.appendChild(document.createTextNode(" to resolve them later."));
  wrap.appendChild(rest);
  const actions = el("div", "introactions");
  const later = el("button", null, "do later");
  later.onclick = () => post("/done", {});
  const go = el("button", "primary", "continue");
  go.onclick = () => move(1);
  actions.appendChild(later);
  actions.appendChild(go);
  wrap.appendChild(actions);
  main.appendChild(wrap);
  go.focus();
}

/** Nothing lands until the button. The receipt is the real table — every
 * managed chord with the same live cells the steps use, edited inline. */
function renderConfirm(main) {
  main.appendChild(el("div", "title", "review and confirm"));

  // one column per claimant that is involved anywhere: session claim columns
  // plus the claimant side of import rows
  const claimants = [];
  for (const row of table) {
    if (row.kind === "import" && row.claimant && !claimants.includes(row.claimant)) {
      claimants.push(row.claimant);
    }
    for (const claim of claims[row.id] || []) {
      if (!claimants.includes(claim.claimant)) claimants.push(claim.claimant);
    }
  }

  const grid = el("div", "final");
  grid.style.gridTemplateColumns =
    "max-content repeat(" + (2 + claimants.length) + ", minmax(10rem, 1fr))";
  const head = (logo, label) => {
    const cell = el("div", "f-head");
    if (logo) {
      const img = document.createElement("img");
      img.src = logo;
      cell.appendChild(img);
    }
    cell.appendChild(el("span", null, label));
    return cell;
  };
  grid.appendChild(el("div", "f-head", ""));
  grid.appendChild(head(STATE.logos.terminal, STATE.terminalName));
  grid.appendChild(head(STATE.logos.editor, "tode"));
  for (const claimant of claimants) grid.appendChild(head(null, claimant));

  for (const row of table) {
    grid.appendChild(el("div", "f-chord", row.id));
    grid.appendChild(row.kind === "terminal" ? boxWithMenu(row, "left", true) : el("div"));
    grid.appendChild(boxWithMenu(row, "right", true));
    for (const claimant of claimants) {
      const claim = (claims[row.id] || []).find((entry) => entry.claimant === claimant);
      if (claim) grid.appendChild(claimBox(row, claim, true));
      else if (row.kind === "import" && row.claimant === claimant) {
        grid.appendChild(boxWithMenu(row, "left", true));
      } else grid.appendChild(el("div"));
    }
  }
  main.appendChild(grid);
  const open = table.filter((row) => conflicted(row));
  const apply = el("button", "go", "apply these changes");
  apply.onclick = async () => {
    await post("/confirm", {});
    post("/done", {});
  };
  main.appendChild(apply);
  const warn = el("div", "warn");
  warn.textContent = warning
    ? "⚠ " + warning.text
    : open.length
      ? open.length + " still conflicting"
      : "";
  main.appendChild(warn);
  if (menu === null && capturing === null) apply.focus();
}

function renderModal() {
  const veil = document.getElementById("veil");
  veil.replaceChildren();
  veil.className = "";
  veil.onclick = null;
  if (!modal) return;
  veil.className = "veil";
  const row = currentRow();
  const card = el("div", "modal");
  const dismiss = () => {
    modal = null;
    render();
  };
  veil.onclick = (event) => {
    if (event.target === veil) dismiss();
  };
  const x = el("button", "x", "✕");
  x.onclick = dismiss;
  card.appendChild(x);
  if (modal.doLater) {
    card.appendChild(el("div", "title", "finish this later"));
    // decisions staged this session are real work; leaving should offer to
    // land them rather than silently walking away from them
    const pending = touched ? table.filter((row) => row.decision).length : 0;
    if (pending > 0) {
      card.appendChild(el("div", "note",
        pending + " resolved shortcut" + (pending === 1 ? " has" : "s have") + " not been applied yet."));
    }
    const note = el("div", "note");
    note.appendChild(document.createTextNode("You can run "));
    note.appendChild(el("kbd", null, "tode shortcuts"));
    note.appendChild(document.createTextNode(" in your terminal to continue resolving shortcuts."));
    card.appendChild(note);
    const actions = el("div", "actions compact");
    if (pending > 0) {
      const skip = el("button", "option", "continue without applying");
      skip.onclick = () => post("/done", {});
      const applyIt = el("button", "option primary", "apply and continue");
      applyIt.onclick = async () => {
        await post("/confirm", {});
        post("/done", {});
      };
      actions.appendChild(skip);
      actions.appendChild(applyIt);
      card.appendChild(actions);
      veil.appendChild(card);
      applyIt.focus();
    } else {
      const leave = el("button", "option primary", "continue to tode");
      leave.onclick = () => post("/done", {});
      actions.appendChild(leave);
      card.appendChild(actions);
      veil.appendChild(card);
      leave.focus();
    }
    return;
  }
  card.appendChild(el("div", "title", "shortcuts still conflict"));
  const options = el("div", "actions split");
  const carryOn = el("button", "option danger", "continue with conflict");
  carryOn.onclick = () => {
    modal = null;
    move(1);
  };
  const unset = el("button", "option primary");
  unset.appendChild(el("span", null, "unset"));
  unset.appendChild(todeChip());
  unset.appendChild(el("span", null, "bind"));
  unset.onclick = async () => {
    modal = null;
    await decide(row, { choice: "keep" });
    move(1);
  };
  options.appendChild(carryOn);
  options.appendChild(unset);
  card.appendChild(options);
  veil.appendChild(card);
  unset.focus();
}

/** A claimant's binding as one more column in the duel — the same box, menu
 * and capture the other columns have, because it is simply a third shortcut
 * being managed. */
function claimBox(row, claim, mini) {
  const wrap = el("div", "boxwrap");
  const box = el("button", "box" + (mini ? " mini" : ""));
  const menuId = "claim:" + claim.chord;
  const isCapturing = capturing !== null && capturing.claim === claim;
  const menuOpen = menu !== null && menu.id === menuId;
  const state = claim.state; // undefined = still holds its chord
  const shown = isCapturing
    ? "press a chord…"
    : state === undefined ? claim.chord : state.key ? state.key : "unbound";
  if (isCapturing) box.classList.add("capturing");
  else if (state !== undefined && !state.key) box.classList.add("unbound");
  else if (collisions(row).has(shown)) box.classList.add("clash");
  box.appendChild(el("span", null, shown));
  const pen = el("span", "pen");
  pen.appendChild(icon("pen", 15));
  box.appendChild(pen);
  box.onclick = (event) => {
    event.stopPropagation();
    if (capturing !== null) return;
    menu = menuOpen ? null : { id: menuId, side: "claim" };
    render();
  };
  wrap.appendChild(box);

  if (menuOpen) {
    const list = el("div", "menu");
    list.onclick = (event) => event.stopPropagation();
    const items = [
      { label: "custom", commit: () => {
        menu = null;
        capturing = { claim };
        render();
      } },
      state !== undefined
        ? { label: "restore keybind", commit: () => decideClaimChord(claim, null) }
        : { label: "unset keybind", commit: () => decideClaimChord(claim, { choice: "terminal" }) },
    ];
    for (const item of items) {
      const option = el("button", null);
      option.appendChild(el("span", null, item.label));
      option.onclick = (event) => {
        event.stopPropagation();
        menu = null;
        item.commit();
      };
      list.appendChild(option);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function claimColumn(row, claim) {
  const app = el("div", "app");
  app.appendChild(el("div", "name", claim.claimant));
  app.appendChild(claimBox(row, claim, false));
  app.appendChild(el("div", "caption", claim.describes));
  return app;
}

function move(direction) {
  warning = null;
  capturing = null;
  modal = null;
  menu = null;
  at = Math.max(FIRST, Math.min(at + direction, steps.length));
  render();
}

async function tryNext() {
  if (at < 0) return move(1);
  if (at >= steps.length) return;
  const row = currentRow();
  if (!row || !conflicted(row)) return move(1);
  modal = { conflict: true };
  render();
}

async function decide(row, decision, side) {
  const fresh = await post("/decide", { id: row.id, kind: row.kind, decision, side });
  // an error body carries no steps or table; keeping the old ones keeps the
  // page alive to show the warning
  if (fresh.steps) steps = fresh.steps;
  if (fresh.table) table = fresh.table;
  warning = fresh.ok === false ? { tone: "bad", text: fresh.warning } : null;
  if (fresh.ok !== false) touched = true;
  capturing = null;
  menu = null;
  render();
}

async function act(step, actionId) {
  const fresh = await post("/act", { stepId: step.id, actionId });
  if (fresh.steps) steps = fresh.steps;
  if (fresh.table) table = fresh.table;
  at = Math.min(at, steps.length);
  warning =
    fresh.ok === false
      ? { tone: "bad", text: fresh.warning }
      : fresh.note
        ? { tone: "good", text: fresh.note }
        : null;
  render();
}

function chordFrom(event) {
  const mods = [];
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

async function applyChord(row, side, chord) {
  const checked = await post("/taken", { chord, id: row.id });
  if (!checked.ok && !checked.claim) {
    warning = { tone: "bad", text: checked.warning };
    capturing = null;
    render();
    return;
  }
  if (checked.claim) {
    // an extension holds the chord — the capture applies anyway (a user
    // keybinding outranks the extension's), and the claimant joins the row
    // so the value collision is visible and resolvable in place
    const list = (claims[row.id] = claims[row.id] || []);
    if (!list.some((entry) => entry.chord === checked.claim.chord)) {
      list.push({ ...checked.claim, state: undefined });
    }
  }
  const final = checked.chord || chord;
  if (side === "left" && row.kind === "import") {
    decide(row, final === row.id ? null : { choice: "terminal", key: final }, "claim");
    return;
  }
  if (side === "left") {
    decide(row, final === row.id ? null : { choice: "terminal", key: final });
    return;
  }
  decide(row, final === row.id && row.kind !== "import"
    ? null
    : { choice: "editor", key: final });
}

async function captureKey(event) {
  event.preventDefault();
  if (event.key === "Escape") { capturing = null; warning = null; render(); return; }
  const chord = chordFrom(event);
  if (!chord) return;
  const side = capturing.side;
  const row = rowById(capturing.id);
  if (!row) { capturing = null; render(); return; }
  await applyChord(row, side, chord);
}

async function decideClaimChord(claim, decision) {
  const fresh = await post("/decide", { id: claim.chord, kind: "claim", decision });
  steps = fresh.steps;
  table = fresh.table;
  claim.state = decision ?? undefined;
  menu = null;
  capturing = null;
  render();
}

async function captureClaimKey(event) {
  event.preventDefault();
  const claim = capturing.claim;
  if (event.key === "Escape") { capturing = null; warning = null; render(); return; }
  const chord = chordFrom(event);
  if (!chord) return;
  const checked = await post("/taken", { chord, id: claim.chord });
  if (!checked.ok) { warning = { tone: "bad", text: checked.warning }; render(); return; }
  await decideClaimChord(claim, checked.chord === claim.chord ? null : { choice: "terminal", key: checked.chord });
}

document.addEventListener("click", () => {
  if (menu !== null) {
    menu = null;
    render();
  }
});

document.getElementById("later").onclick = () => {
  modal = { doLater: true };
  render();
};

document.addEventListener("keydown", (event) => {
  // while recording, every key is a candidate chord — including ctrl+c
  if (capturing !== null && capturing.claim) return captureClaimKey(event);
  if (capturing !== null) return captureKey(event);
  // ctrl+c quits from anywhere else, the way it would in the terminal
  if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    post("/done", {});
    return;
  }
  if (modal) {
    if (event.key === "Escape") { modal = null; render(); }
    return; // enter and tab walk the modal's own buttons
  }
  if (menu !== null) {
    if (event.key === "Escape") {
      menu = null;
      render();
      event.preventDefault();
    }
    return; // tab and enter walk the menu's own items
  }
  const key = event.key;
  if (key === "Tab") return;
  if (key === "Enter" && document.activeElement && document.activeElement.tagName === "BUTTON") return;
  if (key === "ArrowRight" || key === "n") tryNext();
  else if (key === "ArrowLeft") move(-1);
  else if (key === "u" && currentRow()) decide(currentRow(), null);
  // the footer promises q skips this — and ctrl+c must not be the only door
  // out of a page whose whole subject is that ctrl+c is contested
  else if (key === "q") post("/done", {});
  else return;
  event.preventDefault();
});

render();
</script>
</body>
</html>
`;
}

function body(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let read = "";
    request.on("data", (chunk) => (read += chunk));
    request.on("end", () => resolve(read));
  });
}

/** The manager as a local http server: the page is the ui, these routes are
 * the whole api. Decisions stage in memory; only /confirm writes. Resolves
 * its `done` promise when the page asks to close. */
export function startManager(
  deps: ManagerDeps,
): Promise<{ port: number; done: Promise<void>; close(): void; served(): boolean }> {
  let finish: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  // whether any browser ever fetched the page — the difference between a
  // wizard the user saw and one that never made it onto the screen
  let served = false;
  const server = http.createServer(async (request, response) => {
    const ok = (payload: unknown, type = "application/json") => {
      response.writeHead(200, { "content-type": type });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    try {
      if (request.method === "GET") {
        served = true;
        return ok(buildPage(deps), "text/html; charset=utf-8");
      }
      const sent = JSON.parse((await body(request)) || "{}");
      if (request.url === "/taken") {
        const chord = deps.normalize(String(sent.chord ?? ""));
        if (!chord) return ok({ ok: false, warning: `${sent.chord} does not parse as a chord` });
        const info = chord === sent.id ? null : deps.taken(chord);
        if (info) {
          return ok({
            ok: false,
            warning: `${chord} is already bound to ${info.holder}`,
            claim: info.claim ?? null,
          });
        }
        return ok({ ok: true, chord });
      }
      if (request.url === "/decide") {
        const decision = sent.decision as Decision | null;
        if (decision?.choice === "editor" && decision.key) {
          const key = deps.normalize(decision.key);
          if (!key) {
            return ok({
              ok: false,
              warning: `${decision.key} does not parse`,
              steps: deps.steps(),
              table: deps.allRows(),
            });
          }
          decision.key = key;
        }
        deps.decide(
          String(sent.id),
          sent.kind === "claim" ? "claim" : sent.kind === "import" ? "import" : "terminal",
          decision,
          sent.side === "claim" ? "claim" : "own",
        );
        return ok({ ok: true, steps: deps.steps(), table: deps.allRows() });
      }
      if (request.url === "/act") {
        const acted = await deps.act(String(sent.stepId ?? ""), String(sent.actionId ?? ""));
        return ok({ ok: true, steps: deps.steps(), table: deps.allRows(), note: acted?.note ?? "" });
      }
      if (request.url === "/confirm") {
        const confirmed = deps.confirm();
        return ok({ ok: true, steps: deps.steps(), table: deps.allRows(), note: confirmed.note });
      }
      if (request.url === "/done") {
        ok({ ok: true });
        finish();
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, warning: String(error) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, done, close: () => server.close(), served: () => served });
    });
  });
}

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { TerminalPalette } from "../terminal/osc";
import { ensurePagesBuilt, servePage } from "../webui/pages";
import type { Decision } from "./store";

/** One contested chord, flattened for the page. `kind` says who the other
 * claimant is: the terminal, or a keybinding the user imported. */
export interface ManagerRow {
  id: string;
  kind: "terminal" | "import";
  /** What the editor runs on the chord. */
  means: string;
  /** The raw editor command id and the holding binding's when guard — the
   * metadata the auto-generated label was made from, rendered as label →
   * value rows. */
  detail?: { command: string; when?: string };
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

export interface ManagerDeps {
  /** Every managed row, decided or not. The stepper walks them one per
   * screen; the confirm screen tables them all. */
  rows(): ManagerRow[];
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

/** What the page fetches on load: everything dynamic, next to nothing else —
 * the page itself is a prebuilt react app (src/pages/shortcuts) served as
 * static files. */
function managerState(deps: ManagerDeps) {
  return {
    rows: deps.rows(),
    terminalName: deps.terminalName,
    reloadHint: deps.reloadHint,
    intro: deps.intro === true,
    logos: { terminal: logoDataUri(deps.terminalName.toLowerCase()), editor: logoDataUri("tode") },
  };
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
  ensurePagesBuilt();
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
      if (request.method === "GET" && request.url === "/state") {
        return ok(managerState(deps));
      }
      const got = servePage("shortcuts", deps.palette, request, response);
      if (got === "page") served = true;
      if (got) return;
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
              rows: deps.rows(),
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
        return ok({ ok: true, rows: deps.rows() });
      }
      if (request.url === "/confirm") {
        const confirmed = deps.confirm();
        return ok({ ok: true, note: confirmed.note });
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

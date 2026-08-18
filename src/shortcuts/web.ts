import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { TerminalPalette } from "../terminal/osc";
import { ensurePagesBuilt, servePage } from "../webui/pages";
import type { Decision } from "./store";

export interface ManagerRow {
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
  claims?: {
    chord: string;
    command: string;
    claimant: string;
    describes: string;
    when?: string;
    resting?: boolean;
    decided?: Decision | null;
  }[];
}

export interface ManagerDeps {
  rows(): ManagerRow[];
  taken(chord: string, id?: string, command?: string, side?: "terminal" | "editor"): {
    holder: string;
    claim?: { chord: string; command: string; claimant: string; describes: string; when?: string };
  } | null;
  normalize(chord: string): string | null;
  decide(
    id: string,
    kind: "terminal" | "import" | "claim",
    decision: Decision | null,
    side?: "claim" | "own",
    claim?: { command: string; when?: string },
  ): void;
  confirm(): { note: string };
  next?(): Promise<string | null>;
  continues?: boolean;
  reloadHint: string;
  terminalName: string;
  palette: TerminalPalette;
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

function managerState(deps: ManagerDeps) {
  return {
    rows: deps.rows(),
    terminalName: deps.terminalName,
    reloadHint: deps.reloadHint,
    intro: deps.intro === true,
    continues: deps.continues === true,
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

export function startManager(
  deps: ManagerDeps,
): Promise<{ port: number; done: Promise<void>; close(): void; served(): boolean }> {
  ensurePagesBuilt();
  let finish: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
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
        const info =
          chord === sent.id
            ? null
            : deps.taken(
                chord,
                String(sent.id ?? ""),
                sent.command ? String(sent.command) : undefined,
                sent.side === "terminal" || sent.side === "editor" ? sent.side : undefined,
              );
        if (info) {
          return ok({
            ok: false,
            warning: `${chord} is already bound to ${info.holder}`,
            claim: info.claim ?? null,
            chord,
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
          sent.action ? { command: String(sent.action), when: sent.guard ? String(sent.guard) : undefined } : undefined,
        );
        return ok({ ok: true, rows: deps.rows() });
      }
      if (request.url === "/confirm") {
        const confirmed = deps.confirm();
        return ok({ ok: true, note: confirmed.note });
      }
      if (request.url === "/done") {
        const next = deps.next ? await deps.next() : null;
        ok({ ok: true, next });
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

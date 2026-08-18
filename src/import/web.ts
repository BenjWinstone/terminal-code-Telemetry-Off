import fs from "node:fs";
import http from "node:http";

import type { TerminalPalette } from "../terminal/osc";
import { ensurePagesBuilt, servePage } from "../webui/pages";


export interface ImportPageEditor {
  name: string;
  iconPng?: string | null;
}

export interface ImportReportRow {
  kind: "ok" | "warn";
  label: string;
  value: string;
}

export interface ImportPageDeps {
  palette: TerminalPalette;
  editors: ImportPageEditor[];
  run(name: string): ImportReportRow[];
  next?(): Promise<string | null>;
}

function iconDataUri(png: string | null | undefined): string | null {
  if (!png) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`;
  } catch {
    return null;
  }
}

function importState(deps: ImportPageDeps) {
  return {
    editors: deps.editors.map((editor) => ({
      name: editor.name,
      icon: iconDataUri(editor.iconPng),
    })),
  };
}

function body(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
  });
}

export function startImportPage(
  deps: ImportPageDeps,
): Promise<{ port: number; done: Promise<void>; close(): void; served(): boolean }> {
  ensurePagesBuilt();
  let finish: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  let served = false;
  const server = http.createServer(async (request, response) => {
    const ok = (payload: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    try {
      if (request.method === "GET" && request.url === "/state") {
        return ok(importState(deps));
      }
      const got = servePage("import", deps.palette, request, response);
      if (got === "page") served = true;
      if (got) return;
      const sent = JSON.parse((await body(request)) || "{}");
      if (request.url === "/import") {
        const name = String(sent.name ?? "");
        if (!deps.editors.some((editor) => editor.name === name)) {
          return ok({ ok: false, warning: `${name} is not one of the choices` });
        }
        return ok({ ok: true, rows: deps.run(name) });
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

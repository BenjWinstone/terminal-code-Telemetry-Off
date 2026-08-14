import fs from "node:fs";
import http from "node:http";

import type { TerminalPalette } from "../terminal/osc";
import { cssTokens } from "../webui/tokens";

/** The first-run import screen: one question, the editors found on this
 * machine, two buttons. Same tokens and same shape as the shortcuts intro —
 * it has to read as the same program. */

export interface ImportPageEditor {
  name: string;
  /** png path for the app's icon, shown when it exists */
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
  /** Runs the actual import; returns the rows the page shows as the receipt. */
  run(name: string): ImportReportRow[];
}

function iconDataUri(png: string | null | undefined): string | null {
  if (!png) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`;
  } catch {
    return null;
  }
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildImportPage(deps: ImportPageDeps): string {
  const state = {
    editors: deps.editors.map((editor) => ({
      name: editor.name,
      icon: iconDataUri(editor.iconPng),
    })),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tode import</title>
<style>
  ${cssTokens(deps.palette)}
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 2rem 1.5rem;
    display: flex; flex-direction: column; align-items: center;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  }
  main {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding-top: clamp(2rem, 18vh, 9rem);
    width: 100%; max-width: 44rem;
  }
  .intro { text-align: left; max-width: 34rem; width: 100%; }
  .introlead { color: var(--fg); }
  .introrest { color: var(--dim); margin-top: .8rem; }
  kbd {
    border: 1px solid var(--line); border-bottom-width: 2px;
    padding: 0 .35ch; font: inherit;
  }
  .editors { margin-top: 1.6rem; display: flex; flex-direction: column; gap: .45rem; }
  .editor {
    display: flex; align-items: center; gap: .7rem; padding: .55rem .9rem;
    font: inherit; text-align: left; cursor: pointer;
    color: var(--dim); background: none; border: 1px solid var(--line);
  }
  .editor img { width: 18px; height: 18px; }
  .editor .spacer { width: 18px; height: 18px; }
  .editor.active { color: var(--fg); border-color: var(--soft); background: var(--lift); }
  .editor:focus { outline: none; }
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
  .report { margin-top: 1.6rem; display: flex; flex-direction: column; gap: .35rem; }
  .report .row { display: flex; gap: .8rem; }
  .report .mark { color: var(--green); }
  .report .row.warn .mark { color: var(--yellow); }
  .report .label { color: var(--dim); min-width: 9ch; }
</style>
</head>
<body>
<main id="main"></main>
<script>
const STATE = ${inlineJson(state)};
let at = 0;
let busy = false;

const post = async (url, payload) => {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(payload ?? {}) });
  return response.json();
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function render() {
  const main = document.getElementById("main");
  main.replaceChildren();
  const wrap = el("div", "intro");
  wrap.appendChild(el("div", "introlead", "Import config from another editor"));

  const list = el("div", "editors");
  STATE.editors.forEach((editor, index) => {
    const row = el("button", "editor" + (index === at ? " active" : ""));
    if (editor.icon) {
      const img = document.createElement("img");
      img.src = editor.icon;
      row.appendChild(img);
    } else {
      row.appendChild(el("span", "spacer"));
    }
    row.appendChild(el("span", null, editor.name));
    row.onclick = () => {
      at = index;
      render();
    };
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const actions = el("div", "introactions");
  const skip = el("button", null, "skip");
  skip.onclick = () => post("/done", {});
  const go = el("button", "primary", busy ? "importing…" : "import " + STATE.editors[at].name);
  go.disabled = busy;
  go.onclick = start;
  actions.appendChild(skip);
  actions.appendChild(go);
  wrap.appendChild(actions);
  main.appendChild(wrap);
  go.focus();
}

async function start() {
  if (busy) return;
  busy = true;
  render();
  const result = await post("/import", { name: STATE.editors[at].name });
  busy = false;
  if (result.ok === false) return render();
  renderReport(result.rows ?? []);
}

function renderReport(rows) {
  const main = document.getElementById("main");
  main.replaceChildren();
  const wrap = el("div", "intro");
  wrap.appendChild(el("div", "introlead", "imported from " + STATE.editors[at].name));
  const report = el("div", "report");
  for (const item of rows) {
    const row = el("div", "row" + (item.kind === "warn" ? " warn" : ""));
    row.appendChild(el("span", "mark", item.kind === "warn" ? "!" : "✓"));
    row.appendChild(el("span", "label", item.label));
    row.appendChild(el("span", null, item.value));
    report.appendChild(row);
  }
  wrap.appendChild(report);
  const actions = el("div", "introactions");
  const done = el("button", "primary", "continue to tode");
  done.onclick = () => post("/done", {});
  actions.appendChild(done);
  wrap.appendChild(actions);
  main.appendChild(wrap);
  done.focus();
}

document.addEventListener("keydown", (event) => {
  if (busy) return;
  const key = event.key;
  if (key === "Escape") return void post("/done", {});
  if (key === "ArrowUp" || (event.ctrlKey && key.toLowerCase() === "p")) {
    at = Math.max(0, at - 1);
  } else if (key === "ArrowDown" || (event.ctrlKey && key.toLowerCase() === "n")) {
    at = Math.min(STATE.editors.length - 1, at + 1);
  } else if (/^[1-9]$/.test(key) && Number(key) <= STATE.editors.length) {
    at = Number(key) - 1;
  } else {
    return;
  }
  event.preventDefault();
  render();
});

render();
</script>
</body>
</html>`;
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
  let finish: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  let served = false;
  const server = http.createServer(async (request, response) => {
    const ok = (payload: unknown, type = "application/json") => {
      response.writeHead(200, { "content-type": type });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    try {
      if (request.method === "GET") {
        served = true;
        return ok(buildImportPage(deps), "text/html; charset=utf-8");
      }
      const sent = JSON.parse((await body(request)) || "{}");
      if (request.url === "/import") {
        const name = String(sent.name ?? "");
        if (!deps.editors.some((editor) => editor.name === name)) {
          return ok({ ok: false, warning: `${name} is not one of the choices` });
        }
        return ok({ ok: true, rows: deps.run(name) });
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { TerminalPalette } from "../terminal/osc";
import { cssTokens } from "./tokens";

/** The pages are vite-built react apps: src/pages/<name> compiles to plain
 * html, one js and one css in assets/pages/<name> (npm run build:pages). A
 * checkout rebuilds them on demand when the sources are newer than the build;
 * an installed tode has no sources and just serves what shipped. */

const PAGES = ["shortcuts", "import"] as const;
export type PageName = (typeof PAGES)[number];

function findUp(relative: string): string | null {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stamp = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
    if (stamp > newest) newest = stamp;
  }
  return newest;
}

/** In a checkout, rebuild the pages when a source moved past the build. The
 * check is mtimes over src/pages, so an untouched tree costs a few stats and
 * never starts vite. */
export function ensurePagesBuilt(): void {
  const config = findUp("vite.config.mts");
  if (!config) return; // no sources around: serve what shipped
  const root = path.dirname(config);
  const sources = path.join(root, "src", "pages");
  if (!fs.existsSync(sources)) return;
  let builtAt = Infinity;
  for (const page of PAGES) {
    try {
      builtAt = Math.min(builtAt, fs.statSync(path.join(root, "assets", "pages", page, "index.html")).mtimeMs);
    } catch {
      builtAt = 0;
    }
  }
  if (builtAt > Math.max(newestMtime(sources), fs.statSync(config).mtimeMs)) return;
  execFileSync("npm", ["run", "-s", "build:pages"], { cwd: root, stdio: "ignore" });
}

function pageDir(name: PageName): string {
  const found = findUp(path.join("assets", "pages", name, "index.html"));
  if (!found) throw new Error(`the ${name} page is not built — run: npm run build:pages`);
  return path.dirname(found);
}

/** The built page with the terminal's palette injected into <head>, so the
 * first paint is already themed rather than flashing browser-default white. */
export function pageHtml(name: PageName, palette: TerminalPalette): string {
  const html = fs.readFileSync(path.join(pageDir(name), "index.html"), "utf8");
  const tokens = `<style id="tode-tokens">${cssTokens(palette)}</style>`;
  return html.includes("</head>") ? html.replace("</head>", `${tokens}</head>`) : `${tokens}${html}`;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Answers the GET side of a page server: "/" is the built html, "/assets/*"
 * its js and css. Returns what was served so callers can track first paint,
 * or null when the request is not the page's (the POST api, typically). */
export function servePage(
  name: PageName,
  palette: TerminalPalette,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): "page" | "asset" | null {
  if (request.method !== "GET") return null;
  const url = (request.url ?? "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageHtml(name, palette));
    return "page";
  }
  const asset = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!asset || asset[1].includes("..")) return null;
  const file = path.join(pageDir(name), "assets", asset[1]);
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    response.writeHead(404);
    response.end();
    return "asset";
  }
  response.writeHead(200, {
    "content-type": TYPES[path.extname(asset[1])] ?? "application/octet-stream",
    "content-length": String(data.byteLength),
  });
  response.end(data);
  return "asset";
}

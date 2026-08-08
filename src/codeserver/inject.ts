import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

/** code-server in front of a proxy that puts tode's css into the workbench page.
 *
 * The page needs the css before its first paint, and reaching in over the
 * devtools protocol after the fact means a visible flash, so the html is edited
 * on its way through instead. Everything that is not the document is piped
 * straight across. */
export const FONT_ROUTE = "/__tode/font.ttf";
export const TIMING_ROUTE = "/__tode/timing";
export const EXTERNAL_ROUTE = "/__tode/external";

/** Reports the workbench's own startup marks back so tode can print a breakdown
 * without having to attach a debugger to read them. */
export function timingScript(nonce: string): string {
  return `<script nonce="${nonce}">(function(){
  var send = function(){
    try {
      var nav = performance.getEntriesByType('navigation')[0] || {};
      var marks = {};
      performance.getEntriesByType('mark').forEach(function(m){
        if (m.name.indexOf('code/') === 0) marks[m.name] = Math.round(m.startTime);
      });
      navigator.sendBeacon(${JSON.stringify(TIMING_ROUTE)}, JSON.stringify({
        at: Date.now(),
        origin: Math.round(performance.timeOrigin),
        responseEnd: Math.round(nav.responseEnd || 0),
        domInteractive: Math.round(nav.domInteractive || 0),
        loadEnd: Math.round(nav.loadEventEnd || 0),
        marks: marks
      }));
    } catch (e) {}
  };
  var elsewhere = function(url){
    try {
      var here = new URL(location.href);
      var there = new URL(url, location.href);
      if (there.protocol !== 'http:' && there.protocol !== 'https:') return false;
      return there.origin !== here.origin;
    } catch (e) { return false; }
  };
  var sendAway = function(url){
    try { navigator.sendBeacon(${JSON.stringify(EXTERNAL_ROUTE)}, String(url)); } catch (e) {}
  };
  var nativeOpen = window.open;
  window.open = function(url, name, features){
    if (url && elsewhere(url)) { sendAway(url); return null; }
    return nativeOpen.call(window, url, name, features);
  };
  document.addEventListener('click', function(event){
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || !elsewhere(link.href)) return;
    event.preventDefault();
    sendAway(link.href);
  }, true);
  var ready = function(){ document.documentElement.classList.add('tode-ready'); };
  var done = false;
  var settle = function(){ if (done) return; done = true; ready(); setTimeout(send, 50); };
  // never leave the skeleton covering a working editor
  setTimeout(ready, 8000);
  var poll = setInterval(function(){
    if (performance.getEntriesByName('code/didStartWorkbench').length) { clearInterval(poll); settle(); }
  }, 25);
  setTimeout(function(){ clearInterval(poll); settle(); }, 30000);
})();</script>`;
}

/** Hands a url to whatever the desktop uses for it. Only http and https, and
 * never through a shell, because this listens on a port. */
export function openExternally(url: string, recordTo?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (recordTo) {
    try {
      fs.writeFileSync(`${recordTo}.external.txt`, parsed.toString());
    } catch {}
  }
  if (process.env.TODE_NO_OPEN) return true;
  try {
    execFile("open", [parsed.toString()], () => {});
  } catch {}
  return true;
}

export function createInjector(
  upstreamPort: number,
  cssFile: string,
  fontFile?: string,
  holdMs = 20_000,
): http.Server {
  const upstreamHost = `127.0.0.1:${upstreamPort}`;

  const readCss = (): string => {
    try {
      return fs.readFileSync(cssFile, "utf8");
    } catch {
      return "";
    }
  };

  // code-server checks that a request comes from its own origin, so the
  // rewritten headers have to say so even though the browser said otherwise
  const forwardHeaders = (incoming: http.IncomingHttpHeaders, wantsHtml: boolean) => {
    const headers: http.IncomingHttpHeaders = { ...incoming, host: upstreamHost };
    for (const name of ["origin", "referer"] as const) {
      const value = headers[name];
      if (typeof value === "string") {
        headers[name] = value.replace(/^https?:\/\/[^/]+/, `http://${upstreamHost}`);
      }
    }
    // an encoded body cannot be edited, so documents are asked for in the clear
    if (wantsHtml) headers["accept-encoding"] = "identity";
    return headers;
  };

  /** The workbench is served with a strict script-src, so an injected script has
   * to carry the same nonce or the browser drops it without a word. */
  const reporter = (headers: http.IncomingHttpHeaders): string => {
    const policy = headers["content-security-policy"];
    const nonce = typeof policy === "string" ? /'nonce-([^']+)'/.exec(policy)?.[1] : null;
    return nonce ? timingScript(nonce) : "";
  };

  const started = Date.now();
  let everAnswered = false;
  const server: http.Server = http.createServer((request, response) => {
    // serving the font here means the page has it whether or not it was ever
    // installed into the operating system
    if (fontFile && request.url?.startsWith(FONT_ROUTE)) {
      try {
        const font = fs.readFileSync(fontFile);
        response.writeHead(200, {
          "content-type": "font/ttf",
          "content-length": String(font.byteLength),
          "cache-control": "public, max-age=31536000, immutable",
        });
        response.end(font);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    if (request.url?.startsWith(EXTERNAL_ROUTE)) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        openExternally(Buffer.concat(chunks).toString("utf8").trim(), cssFile);
        response.writeHead(204);
        response.end();
      });
      return;
    }
    if (request.url?.startsWith(TIMING_ROUTE)) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          fs.writeFileSync(`${cssFile}.timing.json`, Buffer.concat(chunks).toString("utf8"));
        } catch {}
        response.writeHead(204);
        response.end();
      });
      return;
    }
    const wantsHtml = (request.headers.accept ?? "").includes("text/html");
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: forwardHeaders(request.headers, wantsHtml),
      },
      (from) => {
        everAnswered = true;
        const type = from.headers["content-type"] ?? "";
        const css = readCss();
        if (!type.includes("text/html") || !css) {
          response.writeHead(from.statusCode ?? 502, from.headers);
          from.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        from.on("data", (chunk: Buffer) => chunks.push(chunk));
        from.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const style = `<style id="tode-injected">${css}</style>${reporter(from.headers)}`;
          const patched = body.includes("</head>")
            ? body.replace("</head>", `${style}</head>`)
            : `${style}${body}`;
          const out = Buffer.from(patched, "utf8");
          const headers = { ...from.headers, "content-length": String(out.byteLength) };
          delete headers["content-encoding"];
          // the whole body is in hand now, and a length cannot be sent alongside
          // the chunked encoding the upstream may have used
          delete headers["transfer-encoding"];
          response.writeHead(from.statusCode ?? 200, headers);
          response.end(out);
        });
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      // code-server may still be booting: the browser was started alongside it
      // rather than after it, so the request waits instead of failing
      if (error.code === "ECONNREFUSED" && !everAnswered && Date.now() - started < holdMs) {
        setTimeout(() => server.emit("request", request, response), 60);
        return;
      }
      if (!response.headersSent) response.writeHead(502);
      response.end("tode: code-server is not answering\n");
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, client: net.Socket, clientHead: Buffer) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: forwardHeaders(request.headers, false),
    });
    upstream.on("upgrade", (from, target: net.Socket, upstreamHead: Buffer) => {
      const lines = Object.entries(from.headers).map(([name, value]) => `${name}: ${value}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      // whatever arrived in the same packet as each handshake belongs to the
      // other end, and has already been read off its socket
      if (upstreamHead?.length) client.write(upstreamHead);
      if (clientHead?.length) target.write(clientHead);
      target.pipe(client);
      client.pipe(target);
      // an upgraded socket allows half open, so a browser going away shows up as
      // "end" and never as "close". Watching only for close would leave the
      // connection to code-server behind on every reload.
      const drop = () => {
        target.destroy();
        client.destroy();
      };
      for (const event of ["end", "close", "error"] as const) {
        target.on(event, drop);
        client.on(event, drop);
      }
    });
    upstream.on("error", () => client.destroy());
    upstream.end();
  });

  return server;
}

/** Two things the workbench cannot be told through settings.
 *
 * The last row of device pixels goes uncovered when the terminal reports a
 * fractional pixel ratio, and the page's own white canvas shows through it as a
 * hairline. Painting the root element covers the whole canvas whatever the
 * rounding does.
 *
 * There is also no setting for the font of the interface itself, only for the
 * editor and the terminal, so the rest of the workbench is styled here. */
export interface WelcomeColors {
  accent: string;
  text: string;
  faint: string;
  rule: string;
}

/** The chords worth knowing, laid out in one preformatted block because a
 * pseudo element is all the markup css gets. */
const WELCOME_LINES = [
  ["ctrl p", "go to file"],
  ["ctrl \u21e7 p", "commands"],
  ["ctrl \u21e7 f", "search"],
  ["ctrl `", "terminal"],
  ["ctrl c", "quit tode"],
];

export function injectedCss(
  background: string,
  fontFamily: string,
  skeleton?: { sidebar: string; line: string },
  welcome?: WelcomeColors,
): string {
  const stack = `"${fontFamily}", Menlo, Monaco, monospace`;
  return [
    ...(skeleton
      ? [
          // the workbench takes about half a second to paint, and an empty pane
          // for that long reads as slower than it is. This is the shape of it in
          // the terminal's own colours, cleared the moment vscode is up. Sizes
          // are capped as fractions because a pane can be very narrow.
          `html:not(.tode-ready)::before{content:"";position:fixed;inset:0;`,
          `z-index:2147483647;pointer-events:none;background:`,
          `linear-gradient(${skeleton.sidebar},${skeleton.sidebar}) 0 0/100% 36px no-repeat,`,
          `linear-gradient(${skeleton.line},${skeleton.line}) 0 100%/100% 22px no-repeat,`,
          `linear-gradient(${skeleton.sidebar},${skeleton.sidebar}) 0 36px/min(220px,42%) 100% no-repeat,`,
          `${background};}`,
        ]
      : []),
    `@font-face{font-family:"${fontFamily}";src:url("${FONT_ROUTE}") format("truetype");font-weight:100 900;font-display:block;}`,
    `html,body{background:${background} !important;}`,
    "html{overflow:hidden;}",
    "body{margin:0;}",
    `.monaco-workbench{background:${background};font-family:${stack} !important;}`,
    `.monaco-workbench .part,.monaco-workbench .monaco-list,.monaco-workbench .monaco-inputbox,`,
    `.monaco-workbench input,.monaco-workbench select,.monaco-workbench textarea,`,
    `.monaco-menu,.quick-input-widget,.monaco-hover,.notifications-toasts`,
    `{font-family:${stack} !important;}`,
    `:root{--monaco-monospace-font:${stack};}`,
    ...(welcome
      ? [
          // vscode's empty editor is a greyed out picture of an editor. This puts
          // something useful there instead, in css alone so that it comes back
          // every time vscode rebuilds the watermark.
          ".editor-group-watermark>.watermark-container>.letterpress{display:none;}",
          ".editor-group-watermark{display:flex;align-items:center;justify-content:center;}",
          ".editor-group-watermark>.watermark-container{display:block;text-align:left;}",
          `.editor-group-watermark>.watermark-container::before{content:"tode";display:block;`,
          `font:600 22px ${stack};color:${welcome.accent};letter-spacing:-0.02em;margin:0 0 2px;}`,
          `.editor-group-watermark>.watermark-container>.shortcuts::before{`,
          `content:"${WELCOME_LINES.map(([k]) => k).join("\\A ")}";`,
          `white-space:pre;display:inline-block;vertical-align:top;margin-right:20px;`,
          `font:400 12px ${stack};color:${welcome.text};line-height:1.9;}`,
          `.editor-group-watermark>.watermark-container>.shortcuts::after{`,
          `content:"${WELCOME_LINES.map(([, v]) => v).join("\\A ")}";`,
          `white-space:pre;display:inline-block;vertical-align:top;`,
          `font:400 12px ${stack};color:${welcome.faint};line-height:1.9;}`,
          `.editor-group-watermark>.watermark-container>.shortcuts{`,
          `display:block;border-top:1px solid ${welcome.rule};padding-top:10px;margin-top:8px;}`,
        ]
      : []),
  ].join("");
}

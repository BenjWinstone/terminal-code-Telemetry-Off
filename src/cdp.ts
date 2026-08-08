/** Enough of the devtools protocol to set a page's user agent and send it
 * somewhere, which is all tode needs from the browser it drives. */

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function targets(port: number): Promise<Target[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`cdp list failed (${response.status})`);
  return (await response.json()) as Target[];
}

export async function pageTarget(port: number, timeoutMs = 5000): Promise<Target> {
  const deadline = Date.now() + timeoutMs;
  let last = "no page target";
  while (Date.now() < deadline) {
    try {
      const page = (await targets(port)).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(last);
}

export class CdpSession {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try {
        message = JSON.parse(String((event as MessageEvent).data));
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("cdp connect timed out"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cdp connect failed"));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

/** vscode for the web reads nothing but the user agent string to decide which
 * platform it is on, and that decision picks its whole keymap. Telling it linux
 * is what puts quick open on ctrl+p instead of a cmd chord the terminal eats. */
export const LINUX_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export async function navigateAsLinux(port: number, url: string): Promise<void> {
  const target = await pageTarget(port);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl!);
  try {
    await session.send("Page.enable");
    await session.send("Emulation.setUserAgentOverride", {
      userAgent: LINUX_USER_AGENT,
      platform: "Linux x86_64",
      acceptLanguage: "en-US",
    });
    await session.send("Page.navigate", { url });
  } finally {
    session.close();
  }
}

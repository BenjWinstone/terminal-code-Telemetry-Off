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

/** The workbench reads the user agent (and userAgentData) to pick its keymap.
 * tode no longer masquerades — each platform gets its native keymap and the
 * shortcut wizard settles the terminal's side — but the keymap generator
 * still wears this to dump the linux table from a mac. */
export const LINUX_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

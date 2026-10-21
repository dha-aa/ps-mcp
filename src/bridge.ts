// The link to Photoshop. A UXP plugin can't accept connections, so the server listens on 127.0.0.1 and the
// plugin connects to it. Each server writes BRIDGE_DIR/<pid>.json with its port and token; the plugin
// watches that folder and connects to every server it finds (several Claude sessions can run at once).
//
// Protocol (JSON text frames):
//   plugin -> server  {type:"hello", version, photoshop}
//   server -> plugin  {type:"call", id, cmd, args}  |  {type:"cancel", id}
//   plugin -> server  {type:"result", id, result}  |  {type:"error", id, error:{code,message,hint}}
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { PsToolError, toErrorBody } from "./errors.ts";

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Bridge {
  call(cmd: string, args: unknown, opts?: CallOptions): Promise<unknown>;
  /** Something the model should know about the connection (an outdated plugin), or undefined. */
  warning(): string | undefined;
  close(): Promise<void>;
}

export interface WsBridgeOptions {
  dir: string;
  version: string;
  /** The plugin build expected (plugin/js/build.json). */
  build?: string;
  timeoutMs: number;
  connectWaitMs: number;
  log?: (msg: string) => void;
}

interface Pending {
  cmd: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

const PANEL_HINT = "Open Photoshop and its MCP panel (Plugins > Photoshop MCP). The panel connects by itself within 2 s.";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes bridge files left by servers that are no longer running. */
export function pruneBridgeFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m || Number(m[1]) === process.pid || pidAlive(Number(m[1]))) continue;
    try {
      unlinkSync(join(dir, n));
    } catch {
      // another server pruned it first
    }
  }
}

export class WsBridge implements Bridge {
  readonly port: number;
  readonly file: string;
  private readonly wss: WebSocketServer;
  private readonly opts: WsBridgeOptions;
  private socket: WebSocket | null = null;
  private waiters: Array<() => void> = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** What the plugin said in its hello: shown in errors and get_document. */
  plugin: { version?: string; build?: string; photoshop?: string } | null = null;

  private constructor(wss: WebSocketServer, port: number, file: string, opts: WsBridgeOptions) {
    this.wss = wss;
    this.port = port;
    this.file = file;
    this.opts = opts;
  }

  static async start(opts: WsBridgeOptions): Promise<WsBridge> {
    const token = randomBytes(24).toString("hex");
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: 256 * 1024 * 1024,
      verifyClient: (info: { req: { url?: string } }) => {
        const url = new URL(info.req.url ?? "/", "http://127.0.0.1");
        return url.searchParams.get("token") === token;
      },
    });
    await new Promise<void>((res, rej) => {
      wss.once("listening", res);
      wss.once("error", rej);
    });
    const port = (wss.address() as { port: number }).port;
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    pruneBridgeFiles(opts.dir);
    const file = join(opts.dir, `${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ pid: process.pid, port, token, version: opts.version }), { mode: 0o600 });
    const bridge = new WsBridge(wss, port, file, opts);
    wss.on("connection", (ws) => bridge.attach(ws));
    return bridge;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  private attach(ws: WebSocket): void {
    // One plugin at a time: a reloaded panel replaces the old connection.
    if (this.socket) this.socket.close(4000, "replaced by a newer connection");
    this.socket = ws;
    this.log("plugin connected");
    ws.on("message", (data) => this.onMessage(ws, String(data)));
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.plugin = null;
      this.log("plugin disconnected");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new PsToolError("BRIDGE_DOWN", `Photoshop disconnected while running ${p.cmd}.`, "Check whether Photoshop is still open, then retry. " + PANEL_HINT));
      }
    });
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private onMessage(ws: WebSocket, text: string): void {
    let msg: { type?: string; id?: number; result?: unknown; error?: unknown; version?: string; build?: string; photoshop?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      this.log("ignored a frame that is not JSON");
      return;
    }
    if (msg.type === "hello") {
      this.plugin = { version: msg.version, build: msg.build, photoshop: msg.photoshop };
      const w = this.warning();
      if (w) this.log(w);
      return;
    }
    if (ws !== this.socket || typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return; // timed out already
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "result") p.resolve(msg.result);
    else {
      const e = toErrorBody(msg.error);
      p.reject(new PsToolError(e.code, e.message, e.hint));
    }
  }

  warning(): string | undefined {
    const p = this.plugin;
    if (!p || !this.opts.build || p.build === this.opts.build) return undefined;
    return `Photoshop is running an older build of the plugin (${p.version ?? "?"} ${p.build ?? "?"}, server has ${this.opts.version} ${this.opts.build}). Ask the user to reload it: UXP Developer Tools > Photoshop MCP > Reload.`;
  }

  private waitForPlugin(ms: number): Promise<boolean> {
    if (this.socket) return Promise.resolve(true);
    return new Promise((res) => {
      const done = () => {
        clearTimeout(t);
        res(true);
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((f) => f !== done);
        res(false);
      }, ms);
      this.waiters.push(done);
    });
  }

  async call(cmd: string, args: unknown, opts: CallOptions = {}): Promise<unknown> {
    if (!(await this.waitForPlugin(this.opts.connectWaitMs)) || !this.socket) {
      throw new PsToolError("BRIDGE_DOWN", "Photoshop is not connected.", PANEL_HINT);
    }
    const ws = this.socket;
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs;
    return new Promise((resolve, reject) => {
      const giveUp = (err: PsToolError) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        // The plugin drops the command if it hasn't started yet.
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "cancel", id }));
        reject(err);
      };
      const timer = setTimeout(
        () =>
          giveUp(
            new PsToolError(
              "TIMEOUT",
              `${cmd} got no answer from Photoshop in ${Math.round(timeoutMs / 1000)} s.`,
              "Photoshop may be busy (a dialog, a modal tool or a long filter). If it had started, it may still finish: check get_document before retrying.",
            ),
          ),
        timeoutMs,
      );
      this.pending.set(id, { cmd, resolve, reject, timer });
      opts.signal?.addEventListener("abort", () => giveUp(new PsToolError("TIMEOUT", `${cmd} was cancelled.`)), { once: true });
      ws.send(JSON.stringify({ type: "call", id, cmd, args }));
    });
  }

  async close(): Promise<void> {
    try {
      unlinkSync(this.file);
    } catch {
      // already gone
    }
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((res) => this.wss.close(() => res()));
  }

  /** Synchronous clean-up for process exit. */
  removeFileSync(): void {
    try {
      if (JSON.parse(readFileSync(this.file, "utf8")).port === this.port) unlinkSync(this.file);
    } catch {
      // already gone
    }
  }
}

// The link to the servers: queue, connections, panel, startup. Joined last.

// ---------------------------------------------------------------- queue (Photoshop runs one command at a time)

interface Job {
  ws: WebSocket;
  id: number;
  cmd: string;
  args: Args;
  cancelled: boolean;
}

const queue: Job[] = [];
let running = false;
let lastCommand = "";

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length) {
    const j = queue.shift()!;
    if (j.cancelled) continue;
    lastCommand = j.cmd;
    render("Running " + j.cmd);
    let reply: object;
    try {
      const fn = Object.prototype.hasOwnProperty.call(commands, j.cmd) ? commands[j.cmd] : null;
      if (!fn) fail("UNSUPPORTED", `This plugin has no command ${j.cmd}.`, "The server is newer than the plugin: reload the plugin (UXP Developer Tools > Reload).");
      reply = { type: "result", id: j.id, result: await fn(j.args || {}) };
    } catch (e) {
      reply = { type: "error", id: j.id, error: toErr(e) };
    }
    if (j.ws.readyState === 1) j.ws.send(JSON.stringify(reply));
  }
  running = false;
  render();
}

// ---------------------------------------------------------------- connections

interface Conn {
  ws: WebSocket | null;
  port: number;
  retryAt: number;
}

const conns = new Map<string, Conn>();
let bridgeDir = "";
let scanError = "";

function onMessage(ws: WebSocket, text: string): void {
  let m: { type?: string; id?: number; cmd?: string; args?: Args };
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (m.type === "call" && typeof m.id === "number" && typeof m.cmd === "string") {
    queue.push({ ws, id: m.id, cmd: m.cmd, args: m.args || {}, cancelled: false });
    void pump();
  } else if (m.type === "cancel") {
    for (const j of queue) if (j.ws === ws && j.id === m.id) j.cancelled = true;
  }
}

function connect(name: string, info: { port: number; token: string }): void {
  const c: Conn = { ws: null, port: info.port, retryAt: 0 };
  conns.set(name, c);
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`);
  c.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", version: PLUGIN_VERSION, build: PLUGIN_BUILD, photoshop: ps.app.version }));
    render();
  };
  ws.onmessage = (ev) => onMessage(ws, String(ev.data));
  ws.onclose = () => {
    if (c.ws !== ws) return;
    c.ws = null;
    c.retryAt = Date.now() + RETRY_MS;
    for (const j of queue) if (j.ws === ws) j.cancelled = true;
    render();
  };
}

async function scan(): Promise<void> {
  let names: string[] = [];
  try {
    if (!bridgeDir) bridgeDir = uos.homedir().replace(/\\/g, "/").replace(/\/$/, "") + "/.photoshop-mcp/bridges";
    names = (await ufs.readdir("file:" + bridgeDir)).filter((n) => /^\d+\.json$/.test(n));
    scanError = "";
  } catch (e) {
    // The folder appears when the first server starts.
    scanError = /no such|not found|ENOENT|-2\b/i.test(toErr(e).message) ? "" : toErr(e).message;
  }
  for (const [name, c] of conns) {
    if (names.indexOf(name) < 0) {
      if (c.ws) c.ws.close();
      conns.delete(name);
    }
  }
  for (const name of names) {
    const c = conns.get(name);
    if (c && (c.ws || Date.now() < c.retryAt)) continue;
    try {
      const info = JSON.parse(await ufs.readFile("file:" + bridgeDir + "/" + name, { encoding: "utf-8" }));
      if (typeof info.port === "number" && typeof info.token === "string") connect(name, info);
    } catch {
      // half-written file: next scan
    }
  }
  render();
}

// ---------------------------------------------------------------- panel

function render(activity?: string): void {
  if (typeof document === "undefined") return;
  const open = Array.from(conns.values()).filter((c) => c.ws && c.ws.readyState === 1).length;
  const status = document.getElementById("status");
  const detail = document.getElementById("detail");
  if (status) {
    status.textContent = open ? `Connected to ${open} MCP server${open > 1 ? "s" : ""}` : "Waiting for an MCP server";
    status.className = open ? "ok" : "wait";
  }
  if (detail) {
    detail.textContent = scanError ? "Can't read " + bridgeDir + ": " + scanError : activity || (lastCommand ? "Last: " + lastCommand : "v" + PLUGIN_VERSION);
  }
}

if (typeof __PS_MCP_TEST__ !== "undefined") {
  Object.assign(__PS_MCP_TEST__, { commands, toErr, scan, conns, queue, setBridgeDir: (d: string) => (bridgeDir = d), version: PLUGIN_VERSION, build: PLUGIN_BUILD });
} else {
  void scan();
  setInterval(() => void scan(), SCAN_MS);
}
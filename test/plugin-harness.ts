// Runs the real built plugin (plugin/js/main.js) in a vm with a fake Photoshop, the way UXP would load it.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fakePhotoshop } from "./fake-ps.ts";

const SRC = readFileSync(new URL("../plugin/js/main.js", import.meta.url), "utf8");

export interface PluginInternals {
  commands: Record<string, (a: Record<string, unknown>) => Promise<any>>;
  toErr(e: unknown): { code: string; message: string; hint?: string };
  scan(): Promise<void>;
  conns: Map<string, { ws: WebSocket | null }>;
  queue: unknown[];
  setBridgeDir(d: string): void;
  version: string;
}

export function loadPlugin(opts: { home?: string; build?: string } = {}) {
  const fake = fakePhotoshop();
  const internals = {} as PluginInternals;
  const modules: Record<string, unknown> = {
    photoshop: fake.photoshop,
    uxp: fake.uxp,
    fs: fake.fs,
    os: { homedir: () => opts.home ?? "/nonexistent-home", platform: () => "darwin" },
  };
  const ctx = vm.createContext({
    require: (n: string) => {
      if (!(n in modules)) throw new Error("plugin required unknown module " + n);
      return modules[n];
    },
    WebSocket,
    setTimeout,
    setInterval,
    clearTimeout,
    console,
    __PS_MCP_TEST__: internals,
  });
  const src = opts.build ? SRC.replace(/const PLUGIN_BUILD = "[^"]*"/, `const PLUGIN_BUILD = "${opts.build}"`) : SRC;
  vm.runInContext(src, ctx, { filename: "plugin/js/main.js" });
  // Results and errors cross the wire as JSON (errors mapped by the plugin's toErr, as its queue does);
  // round-trip them so tests compare plain values, not vm-realm arrays.
  const raw = internals.commands;
  const commands: PluginInternals["commands"] = {};
  for (const k of Object.keys(raw)) {
    commands[k] = async (a) => {
      let r;
      try {
        r = await raw[k](a);
      } catch (e) {
        throw JSON.parse(JSON.stringify(internals.toErr(e)));
      }
      return JSON.parse(JSON.stringify(r));
    };
  }
  return { ...fake, plugin: { ...internals, commands } };
}

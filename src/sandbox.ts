// Path arguments may only point inside ALLOWED_DIRS.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { PsToolError } from "./errors.ts";

/** Resolves symlinks of the longest existing prefix, so a link can't point out of the sandbox. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
      cur = up;
    }
  }
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Expands `~`, makes the path absolute and checks it against the allowed folders. Returns the absolute path. */
export function assertAllowed(path: string, allowed: string[]): string {
  const expanded = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
  if (!isAbsolute(expanded)) {
    throw new PsToolError("BAD_ARGS", `Path must be absolute: ${path}`, "Pass a full path such as /Users/me/Desktop/ref.png.");
  }
  const abs = realish(resolve(expanded));
  if (!allowed.some((d) => inside(abs, realish(d)))) {
    throw new PsToolError(
      "FORBIDDEN",
      `Path is outside the allowed folders: ${path}`,
      `Allowed: ${allowed.join(", ")}. Set PS_MCP_ALLOWED_DIRS to change them.`,
    );
  }
  return abs;
}

import fs from "node:fs";
import path from "node:path";

export interface Target {
  folder: string | null;
  file: string | null;
}

/** A folder opens as a folder and a file opens as just that file.
 *
 * Handing vscode the folder a file happens to sit in is how you end up indexing
 * an entire home directory because someone edited a note in it. Ask for the
 * project explicitly when you want it. */
export function resolveTarget(argument: string | undefined, cwd: string): Target {
  const requested = path.resolve(cwd, argument ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(requested);
  } catch {
    throw new Error(`no such file or folder: ${requested}`);
  }
  if (stat.isDirectory()) return { folder: requested, file: null };
  return { folder: null, file: requested };
}

export function workbenchUrl(origin: string, target: Target): string {
  const url = new URL(origin);
  if (target.folder) url.searchParams.set("folder", target.folder);
  if (target.file) {
    // the authority is what tells vscode the path lives on the machine serving
    // the workbench; without it the file quietly fails to open
    const uri = `vscode-remote://${url.host}${target.file}`;
    url.searchParams.set("payload", JSON.stringify([["openFile", uri]]));
  }
  return url.toString();
}

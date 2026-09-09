import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/** runnerd is shipped and verified separately from the JavaScript provider pack. */
export function normalizeProviderPackLayout(packRoot) {
  const dist = join(packRoot, "dist");
  if (!existsSync(dist)) return;
  if (!lstatSync(dist).isDirectory()) {
    throw new Error("Provider pack dist must be a directory");
  }
  const bin = join(dist, "bin");
  if (!existsSync(bin)) return;
  if (!lstatSync(bin).isDirectory()) {
    throw new Error("Provider pack dist/bin must be a directory");
  }
  rmSync(join(bin, "paperclip-runnerd"), { force: true });
  // Keep every other entry, including future provider executables.
  if (readdirSync(bin).length === 0) rmdirSync(bin);
}

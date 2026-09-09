import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256File(path) {
  return `sha256:${createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")}`;
}

export function sha256Tree(root) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\n`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${sha256File(absolutePath)}\n`);
      } else if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${readlinkSync(absolutePath)}\n`,
        );
      } else {
        throw new Error(
          `Provider pack tree contains unsupported entry ${relativePath}`,
        );
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}


/** Verify exported bytes before replacing any prior working provider pack. */
export function verifyProviderPack(root, { revision, lockSha256 }) {
  const manifest = JSON.parse(readFileSync(join(root, "provider-pack.json"), "utf8"));
  const payload = manifest.payload;
  if (manifest.schema !== "paperclip-runner/remote-provider-pack/v1"
    || payload?.runnerSourceRevision !== revision
    || payload.target?.platform !== "linux" || payload.target?.architecture !== "x64"
    || manifest.digest !== `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`) {
    throw new Error("Canonical provider-pack manifest mismatch");
  }
  const expectedPaths = {
    nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml",
    opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
    opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
  };
  const canonicalRoot = realpathSync(root);
  for (const [name, expectedPath] of Object.entries(expectedPaths)) {
    const artifact = payload.artifacts?.[name];
    if (artifact?.path !== expectedPath || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      throw new Error("Canonical provider-pack artifact metadata mismatch");
    }
    const file = realpathSync(resolve(root, expectedPath));
    if (!file.startsWith(`${canonicalRoot}${sep}`) || sha256File(file) !== artifact.sha256) {
      throw new Error("Canonical provider-pack artifact integrity mismatch");
    }
  }
  if (payload.artifacts.productionLock.sha256 !== `sha256:${lockSha256}` || sha256Tree(join(root, "dist")) !== payload.distDigest) {
    throw new Error("Canonical provider-pack lock or compiled output mismatch");
  }
  const bridgeDigest = `sha256:${createHash("sha256")
    .update(payload.artifacts.opencodeProxy.sha256).update("\n")
    .update(payload.artifacts.acpxSidecar.sha256).update("\n")
    .update(payload.distDigest).digest("hex")}`;
  if (payload.bridgeDigest !== bridgeDigest) throw new Error("Canonical provider-pack bridge integrity mismatch");
  return manifest;
}

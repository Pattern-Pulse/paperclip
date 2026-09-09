import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { validateWorkFilePath } from "@paperclipai/shared";

const entrySchema = z.object({ path: z.string().refine((value) => { try { validateWorkFilePath(value); return true; } catch { return false; } }),
  kind: z.enum(["file", "directory"]), byteSize: z.number().int().nonnegative().max(1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), executable: z.boolean(), linkTarget: z.string().max(1024).optional() });
export type WorkTreeEntry = z.infer<typeof entrySchema>;
let source: Promise<string> | undefined;
// Requests are base64 encoded twice (file bytes, then JSON). Stay below
// Linux's 128 KiB single-argument limit, including a provider shell wrapper.
const WRITE_CHUNK_BYTES = 48 * 1024;
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_OPERATIONS = 256;
export type WorkFileTransfer = { entry: WorkTreeEntry; body?: Readable };

function transientTransportFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const statuses = [502, 503, 504];
  return ["ECONNRESET", "EPIPE", "EAI_AGAIN", "ECONNABORTED"].includes(String(detail.code ?? ""))
    || error.message === "socket hang up"
    || [detail.status, detail.statusCode, detail.response?.status].some((status) => statuses.includes(status as number))
    // The plugin RPC preserves this SDK error's message but not its response
    // metadata. Do not classify arbitrary script output containing "502".
    || (error.name === "JsonRpcCallError" && detail.code === -32002
      && /^Request failed with status code (502|503|504)(?:: Sandbox command requested here)?$/.test(error.message));
}

export function workFolderTransport(runner: CommandManagedRuntimeRunner) {
  // Native file-sync providers already support bounded stdin uploads. SSH
  // runners explicitly advertise streaming stdin. Other providers retain the
  // small-argv transport without assuming additional capabilities.
  const bulkStdin = Boolean(runner.syncIn && runner.syncOut) || runner.supportsSingleStreamStdinProgress === true;
  async function command(input: Record<string, unknown>, stdin?: string, deadline = Date.now() + 120_000): Promise<unknown> {
    source ??= readFile(new URL("./scripts/work-folder-io.mjs", import.meta.url), "utf8");
    const args = ["--input-type=module", "-e", await source, Buffer.from(JSON.stringify(input)).toString("base64")];
    const readOnly = ["home", "scan", "read", "read-batch", "batch-status"].includes(String(input.operation));
    let result;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadline) throw new Error("Work folder transfer deadline exceeded");
      try {
        result = await runner.execute({ command: "node", args, ...(stdin === undefined ? {} : { stdin }), bypassSession: true,
          timeoutMs: Math.max(1, deadline - Date.now()) });
        break;
      } catch (error) {
        // A lost read response is safe to repeat. Staging writes, publishes and
        // moves may already have happened, so never replay them here.
        const waitMs = 250 * (attempt + 1);
        if (!readOnly || attempt >= 2 || !transientTransportFailure(error) || Date.now() + waitMs >= deadline) throw error;
        await delay(waitMs);
      }
    }
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Work folder ${String(input.operation)} failed: ${result.stderr.slice(0, 1500)}`);
    return JSON.parse(result.stdout);
  }
  async function writeBatch(root: string, stagingRoot: string, body: string) {
    const deadline = Date.now() + 120_000;
    const identity = { root, stagingRoot, batchId: randomUUID(),
      batchSha256: createHash("sha256").update(body).digest("hex"), batchReceiptKey: randomBytes(32).toString("hex") };
    const completedSchema = z.object({ completed: z.number().int().nonnegative().max(512) });
    const resultSchema = z.union([completedSchema, z.object({ pending: z.literal(true) })]);
    const statusSchema = z.discriminatedUnion("state", [
      z.object({ state: z.literal("missing") }), z.object({ state: z.literal("running") }),
      completedSchema.extend({ state: z.literal("completed") }),
      z.object({ state: z.literal("failed"), error: z.string().max(500) }),
    ]);
    let attempts = 0;
    let pending = false;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!pending) {
        attempts++;
        try {
          const result = resultSchema.parse(await command({ operation: "batch", ...identity }, body, deadline));
          if ("completed" in result) return result;
          pending = true;
        } catch (error) {
          if (!transientTransportFailure(error)) throw error;
          lastError = error;
        }
      }
      // An upstream error may have lost only the response. First inspect the
      // sandbox receipt. A claimed batch is never replayed; it must complete
      // or remain visibly recoverable when this bounded wait expires.
      const status = statusSchema.parse(await command({ operation: "batch-status", ...identity }, undefined, deadline));
      if (status.state === "completed") return { completed: status.completed };
      if (status.state === "failed") throw new Error(`Work folder batch failed: ${status.error}`);
      pending = status.state === "running";
      if (!pending && attempts >= 3) throw lastError ?? new Error("Work folder batch receipt is missing");
      const waitMs = pending ? 500 : 250 * attempts;
      if (Date.now() + waitMs >= deadline) break;
      await delay(waitMs);
    }
    throw new Error("Work folder batch outcome is uncertain; retaining sandbox for recovery");
  }
  async function home() {
    const result = z.object({ home: z.string().startsWith("/") }).parse(await command({ operation: "home" }));
    return result.home;
  }
  async function scan(root: string, repository = false) {
    return z.array(entrySchema).max(100_000).parse(await command({ operation: "scan", root, repository }));
  }
  function read(root: string, filePath: string, byteSize: number) {
    validateWorkFilePath(filePath);
    return Readable.from((async function* () {
      for (let offset = 0; offset < byteSize;) {
        const length = bulkStdin ? 1024 * 1024 : 256 * 1024;
        const result = z.object({ data: z.string().max(Math.ceil(length / 3) * 4) }).parse(await command({ operation: "read", root, path: filePath, offset, length }));
        const bytes = Buffer.from(result.data, "base64");
        if (bytes.length === 0 || offset + bytes.length > byteSize) throw new Error("Work file changed during transfer");
        offset += bytes.length;
        yield bytes;
      }
    })());
  }
  async function readBatch(root: string, entries: WorkTreeEntry[]) {
    if (entries.length > 64) throw new Error("Work folder read batch exceeds entry limit");
    let bytes = 0;
    for (const entry of entries) {
      entrySchema.parse(entry);
      if (entry.kind !== "file" || entry.linkTarget) throw new Error("Work folder read batch requires regular files");
      bytes += entry.byteSize;
    }
    if (bytes > 1024 * 1024) throw new Error("Work folder read batch exceeds byte limit");
    if (!entries.length) return [];
    const result = z.array(z.object({ data: z.string().max(Math.ceil(1024 * 1024 / 3) * 4) })).max(64)
      .parse(await command({ operation: "read-batch", root, entries: entries.map(({ path, byteSize }) => ({ path, byteSize })) }));
    if (result.length !== entries.length) throw new Error("Work folder read batch did not complete");
    return result.map(({ data }, index) => {
      const buffer = Buffer.from(data, "base64");
      if (buffer.length !== entries[index]!.byteSize) throw new Error("Work file changed during transfer");
      return buffer;
    });
  }
  async function writeChunks(root: string, stagingRoot: string, entry: WorkTreeEntry, body: Readable) {
    const stagingPath = randomUUID();
    let offset = 0;
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (let start = 0; start < chunk.length; start += WRITE_CHUNK_BYTES) {
        const bytes = chunk.subarray(start, start + WRITE_CHUNK_BYTES);
        await command({ operation: "write", root: stagingRoot, path: stagingPath, offset, data: bytes.toString("base64") });
        offset += bytes.length;
      }
    }
    if (offset === 0) await command({ operation: "write", root: stagingRoot, path: stagingPath, offset: 0, data: "" });
    if (offset !== entry.byteSize) throw new Error("Work file size changed during transfer");
    await command({ operation: "publish", root, stagingRoot, stagingPath, path: entry.path,
      sha256: entry.sha256, executable: entry.executable });
  }
  async function writeMany(root: string, stagingRoot: string, transfers: AsyncIterable<WorkFileTransfer>,
    beforePublish?: (entries: WorkTreeEntry[]) => Promise<void>) {
    let publishedEntries: WorkTreeEntry[] = [];
    let operations: Array<Record<string, unknown>> = [];
    let bufferedBytes = 0;
    async function flush() {
      if (!operations.length) return;
      const body = JSON.stringify(operations);
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Work folder batch exceeds transfer limit");
      if (publishedEntries.length) await beforePublish?.(publishedEntries);
      const result = await writeBatch(root, stagingRoot, body);
      if (result.completed !== operations.length) throw new Error("Work folder batch did not complete");
      operations = []; bufferedBytes = 0; publishedEntries = [];
    }
    async function append(operation: Record<string, unknown>, bytes = 0, entry?: WorkTreeEntry) {
      if (bufferedBytes + bytes > BATCH_BYTES || operations.length >= BATCH_OPERATIONS) await flush();
      operations.push(operation); bufferedBytes += bytes;
      if (entry) publishedEntries.push({ ...entry });
    }
    for await (const { entry, body } of transfers) {
      try {
        entrySchema.parse(entry);
        if (entry.linkTarget) throw new Error("Work folder batch cannot materialize symlinks");
        if (entry.kind === "directory") {
          if (body) throw new Error("Directory transfer cannot have a body");
          if (bulkStdin) await append({ operation: "mkdir", path: entry.path }, 0, entry);
          else {
            await beforePublish?.([entry]);
            await command({ operation: "mkdir", root, path: entry.path });
          }
          continue;
        }
        if (!body) throw new Error("Work file transfer source is missing");
        if (!bulkStdin) {
          await beforePublish?.([entry]);
          await writeChunks(root, stagingRoot, entry, body);
          continue;
        }
        const stagingPath = randomUUID();
        let offset = 0;
        for await (const value of body) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          for (let start = 0; start < chunk.length; start += 256 * 1024) {
            const bytes = chunk.subarray(start, start + 256 * 1024);
            if (offset + bytes.length > entry.byteSize) throw new Error("Work file size changed during transfer");
            await append({ operation: "write", path: stagingPath, offset, data: bytes.toString("base64") }, bytes.length);
            offset += bytes.length;
          }
        }
        if (offset === 0) await append({ operation: "write", path: stagingPath, offset: 0, data: "" });
        if (offset !== entry.byteSize) throw new Error("Work file size changed during transfer");
        await append({ operation: "publish", stagingPath, path: entry.path, sha256: entry.sha256, executable: entry.executable }, 0, entry);
      } finally { body?.destroy(); }
    }
    if (bulkStdin) await flush();
  }
  async function write(root: string, stagingRoot: string, entry: WorkTreeEntry, body: Readable) {
    return writeMany(root, stagingRoot, (async function* () { yield { entry, body }; })());
  }
  return { home, scan, read, readBatch: bulkStdin ? readBatch : undefined, write, writeMany,
    moveRoot: async (source: string, root: string) => { await command({ operation: "move-root", source, root }); },
    symlink: async (root: string, stagingRoot: string, entry: WorkTreeEntry) => { await command({ operation: "symlink", root, stagingRoot, stagingPath: randomUUID(), path: entry.path, linkTarget: entry.linkTarget }); },
    mkdirRoot: async (root: string) => { await command({ operation: "mkdir-root", root }); },
    mkdir: async (root: string, filePath: string) => { await command({ operation: "mkdir", root, path: filePath }); },
    remove: async (root: string, filePath: string) => { await command({ operation: "remove", root, path: filePath }); },
  };
}
export type WorkFolderTransport = ReturnType<typeof workFolderTransport>;
export function workFolderPaths(home: string) {
  return Object.fromEntries(["task", "agent", "user", "project", "repos", ".cache", ".codex", ".paperclip-work-folders"].map((name) => [name, path.posix.join(home, name)]));
}

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issues, startEmbeddedPostgresTestDatabase,
  taskRepositoryBindings, workFolderObjects, type Db } from "@paperclipai/db";
import * as garbage from "../services/work-folder-garbage.js";
import { workFolderRepositoryService } from "../services/work-folder-repositories.js";
import type { WorkFolderTransport, WorkTreeEntry } from "../services/work-folder-transport.js";
import type { PutObjectInput, StorageProvider } from "../storage/types.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("bounded repository checkpoint transfers", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-repository-pool-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Checkpoint pool" });
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const taskId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Checkpoint" });
    const [binding] = await db.insert(taskRepositoryBindings).values({ companyId, taskId,
      workspaceId: randomUUID(), name: "repository" }).returning();
    const contents = new Map<string, Buffer>();
    const objects = new Map<string, Buffer>();
    const sources: Readable[] = [];
    let entries: WorkTreeEntry[] = [];
    const scan = vi.fn(async () => entries);
    const transport: WorkFolderTransport = {
      home: async () => "/home/runner", scan, readBatch: undefined,
      read: vi.fn((_root, filePath) => {
        const source = Readable.from([contents.get(filePath)!]);
        sources.push(source);
        return source;
      }),
      write: vi.fn(async () => {}),
      writeMany: vi.fn(async (_root, _stagingRoot, transfers) => {
        for await (const { body } of transfers) {
          if (body) for await (const chunk of body) { void chunk; }
        }
      }),
      moveRoot: vi.fn(async () => {}),
      symlink: vi.fn(async () => {}), mkdirRoot: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    };
    const putObject = vi.fn(async (input: PutObjectInput) => {
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      objects.set(input.objectKey, Buffer.concat(chunks));
    });
    const headObject = vi.fn(async ({ objectKey }: { objectKey: string }) => ({ exists: objects.has(objectKey) }));
    const storage: StorageProvider = {
      id: "local_disk", putObject, headObject,
      getObject: async ({ objectKey }) => ({ stream: Readable.from([objects.get(objectKey)!]) }),
      deleteObject: async ({ objectKey }) => { objects.delete(objectKey); },
    };
    function file(filePath: string, text = filePath): WorkTreeEntry {
      const bytes = Buffer.from(text);
      contents.set(filePath, bytes);
      return { path: filePath, kind: "file", byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), executable: false };
    }
    const service = workFolderRepositoryService(db, storage, transport);
    return { binding: binding!, file, objects, sources, scan, transport, storage, putObject, headObject,
      setEntries: (next: WorkTreeEntry[]) => { entries = next; },
      save: () => service.checkpoint(binding!, "/repository"),
      current: async () => (await db.select().from(taskRepositoryBindings).where(eq(taskRepositoryBindings.id, binding!.id)))[0]!,
    };
  }

  it("bounds HEADs and streaming PUTs to four, deduplicates content, and preserves manifest order", async () => {
    const f = await fixture();
    const entries = [f.file("z"), f.file("b"), f.file("same-z", "z"),
      f.file("c"), f.file("a"), f.file("fifth"), f.file("empty", "")];
    entries[2]!.executable = true;
    f.setEntries(entries);
    const registered = vi.spyOn(garbage, "registerWorkFolderObject");
    const heads = gate(), puts = gate();
    let activeHeads = 0, maximumHeads = 0, activePuts = 0, maximumPuts = 0;
    f.headObject.mockImplementation(async () => {
      activeHeads++;
      maximumHeads = Math.max(maximumHeads, activeHeads);
      try { await heads.promise; return { exists: false }; } finally { activeHeads--; }
    });
    const put = f.putObject.getMockImplementation()!;
    f.putObject.mockImplementation(async (input) => {
      if (!input.objectKey.includes("/blobs/")) return put(input);
      activePuts++;
      maximumPuts = Math.max(maximumPuts, activePuts);
      try { await puts.promise; await put(input); } finally { activePuts--; }
    });
    const saving = f.save();
    try {
      await vi.waitFor(() => expect(activeHeads).toBe(4));
      expect(f.headObject).toHaveBeenCalledTimes(4);
      expect(registered).toHaveBeenCalledTimes(4);
      heads.release();
      await vi.waitFor(() => expect(activePuts).toBe(4));
      expect(f.headObject).toHaveBeenCalledTimes(4);
      expect(registered).toHaveBeenCalledTimes(4);
      expect((await f.current()).checkpointKey).toBeNull();
    } finally { heads.release(); puts.release(); }
    await saving;
    expect(maximumHeads).toBe(4);
    expect(maximumPuts).toBe(4);
    expect(f.headObject).toHaveBeenCalledTimes(6);
    const blobPuts = f.putObject.mock.calls.filter(([input]) => input.objectKey.includes("/blobs/"));
    expect(blobPuts).toHaveLength(6);
    expect(new Set(blobPuts.map(([input]) => input.objectKey)).size).toBe(6);
    expect(registered.mock.calls.filter(([, , input]) => input.objectKey.includes("/blobs/"))).toHaveLength(6);
    const manifest = JSON.parse(f.objects.get(f.binding.checkpointKey!)!.toString("utf8"));
    expect(manifest.files.map(({ objectKey: _key, ...entry }: WorkTreeEntry & { objectKey: string }) => entry)).toEqual(entries);
    expect(manifest.files[0].objectKey).toBe(manifest.files[2].objectKey);
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
  });

  it("drains in-flight PUTs after failure without scheduling more blobs or replacing the protected checkpoint", async () => {
    const f = await fixture();
    const original = f.file("saved");
    f.setEntries([original]);
    await f.save();
    const previous = await f.current();
    const failed = f.file("fail"), queued = f.file("must-not-start");
    f.setEntries([original, failed, f.file("held-a"), f.file("held-b"), f.file("held-c"), queued]);
    const failedKey = `${companyId}/task-repositories/${f.binding.id}/blobs/${failed.sha256}`;
    const queuedKey = `${companyId}/task-repositories/${f.binding.id}/blobs/${queued.sha256}`;
    const fail = gate(), held = gate();
    const error = new Error("Injected permanent PUT failure");
    const put = f.putObject.getMockImplementation()!;
    let active = 0, settled = false;
    f.putObject.mockClear();
    f.headObject.mockClear();
    f.scan.mockClear();
    f.putObject.mockImplementation(async (input) => {
      active++;
      try {
        if (input.objectKey === failedKey) { await fail.promise; throw error; }
        await held.promise;
        await put(input);
      } finally { active--; }
    });
    const outcome = f.save().then(() => ({ error: null }), (failure: unknown) => ({ error: failure }))
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(active).toBe(4));
      fail.release();
      await vi.waitFor(() => expect(active).toBe(3));
      await setImmediate();
      expect(settled).toBe(false);
      expect((await f.current()).checkpointKey).toBe(previous.checkpointKey);
      expect(f.headObject.mock.calls.some(([input]) => input.objectKey === queuedKey)).toBe(false);
      expect(f.putObject.mock.calls.some(([input]) => input.objectKey.includes("/checkpoints/"))).toBe(false);
    } finally { fail.release(); held.release(); }
    expect((await outcome).error).toBe(error);
    expect(active).toBe(0);
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
    expect(f.scan).toHaveBeenCalledTimes(1);
    expect((await f.current()).checkpointKey).toBe(previous.checkpointKey);
    const tracked = await db.select().from(workFolderObjects).where(eq(workFolderObjects.repositoryBindingId, f.binding.id));
    expect(tracked.find((object) => object.objectKey === previous.checkpointKey)!.deleteAfter).toBeNull();
    expect(tracked.find((object) => object.objectKey.endsWith(`/blobs/${original.sha256}`))!.deleteAfter).toBeNull();
    expect(tracked.filter((object) => object.deleteAfter !== null)).toHaveLength(4);
  });

  it("drains failed concurrent HEADs without opening more file streams", async () => {
    const f = await fixture();
    const first = f.file("fail-head");
    f.setEntries([first, f.file("two"), f.file("three"), f.file("four"), f.file("queued")]);
    const fail = gate(), held = gate();
    const error = new Error("HEAD unavailable");
    let active = 0, settled = false;
    f.headObject.mockImplementation(async ({ objectKey }) => {
      active++;
      try {
        if (objectKey.endsWith(`/blobs/${first.sha256}`)) { await fail.promise; throw error; }
        await held.promise;
        return { exists: false };
      } finally { active--; }
    });
    const outcome = f.save().then(() => ({ error: null }), (failure: unknown) => ({ error: failure }))
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(active).toBe(4));
      fail.release();
      await vi.waitFor(() => expect(active).toBe(3));
      await setImmediate();
      expect(settled).toBe(false);
      expect(f.sources).toHaveLength(0);
    } finally { fail.release(); held.release(); }
    expect((await outcome).error).toBe(error);
    expect(active).toBe(0);
    expect(f.headObject).toHaveBeenCalledTimes(4);
    expect(f.sources).toHaveLength(0);
    expect(f.putObject).not.toHaveBeenCalled();
    expect((await f.current()).checkpointKey).toBeNull();
  });

  it("rejects a changed second scan even after every concurrent blob transfer succeeds", async () => {
    const f = await fixture();
    const entries = [f.file("one"), f.file("two"), f.file("three"), f.file("four"), f.file("five")];
    f.scan.mockResolvedValueOnce(entries).mockResolvedValueOnce([...entries, f.file("changed")]);
    await expect(f.save()).rejects.toThrow("Repository changed during checkpoint");
    expect(f.putObject).toHaveBeenCalledTimes(5);
    expect(f.putObject.mock.calls.every(([input]) => input.objectKey.includes("/blobs/"))).toBe(true);
    expect((await f.current()).checkpointKey).toBeNull();
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
  });
});

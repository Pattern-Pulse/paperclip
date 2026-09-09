import { Readable } from "node:stream";
import type { WorkTreeEntry } from "./work-folder-transport.js";

const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_ENTRIES = 64;
const MAX_CACHED_BATCHES = 4;

/**
 * A checkpoint-local cache, not a snapshot or a retry source. The caller limits
 * concurrent readers to four. At most four 1 MiB batches stay cached; evicted
 * batches held by those active readers can add at most another 4 MiB. Larger
 * files use the separately bounded streaming fallback. Metadata is O(entries).
 */
export function createWorkFolderReadCache(
  entries: WorkTreeEntry[],
  load: (entries: WorkTreeEntry[]) => Promise<Buffer[]>,
  fallback: (entry: WorkTreeEntry) => Readable,
) {
  const locations = new Map<string, { batch: WorkTreeEntry[]; index: number }>();
  let batch: WorkTreeEntry[] = [];
  let batchBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.linkTarget || entry.byteSize > MAX_BATCH_BYTES) continue;
    if (batch.length >= MAX_BATCH_ENTRIES || batchBytes + entry.byteSize > MAX_BATCH_BYTES) {
      batch = []; batchBytes = 0;
    }
    locations.set(entry.path, { batch, index: batch.length });
    batch.push(entry); batchBytes += entry.byteSize;
  }
  const cached = new Map<WorkTreeEntry[], Promise<Buffer[]>>();
  const readPaths = new Set<string>();
  let cleared = false;

  function getBatch(group: WorkTreeEntry[]) {
    let result = cached.get(group);
    if (result) {
      cached.delete(group); cached.set(group, result);
      return result;
    }
    result = Promise.resolve().then(() => load(group)).then((buffers) => {
      if (buffers.length !== group.length || buffers.some((buffer, index) =>
        !Buffer.isBuffer(buffer) || buffer.length !== group[index]!.byteSize)) {
        throw new Error("Work folder batch content does not match its entries");
      }
      return buffers;
    }).catch((error: unknown) => {
      if (cached.get(group) === result) cached.delete(group);
      throw error;
    });
    cached.set(group, result);
    while (cached.size > MAX_CACHED_BATCHES) cached.delete(cached.keys().next().value!);
    return result;
  }

  function read(entry: WorkTreeEntry): Readable {
    const repeated = readPaths.has(entry.path);
    readPaths.add(entry.path);
    const location = locations.get(entry.path);
    // Mark each source request, even if its stream is never consumed. A retry
    // must reopen the physical file instead of replaying possibly stale bytes.
    return Readable.from((async function* () {
      if (cleared || repeated || !location) {
        const source = fallback(entry);
        try { yield* source; } finally { source.destroy(); }
        return;
      }
      const buffers = await getBatch(location.batch);
      yield buffers[location.index]!;
    })());
  }
  function clear() {
    cleared = true;
    cached.clear();
    locations.clear();
    readPaths.clear();
  }
  return { read, clear };
}

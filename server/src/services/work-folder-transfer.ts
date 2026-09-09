import { measureSandboxOperation } from "./sandbox-performance.js";
import type { WorkFileTransfer } from "./work-folder-transport.js";

// Open a few storage responses ahead without buffering their bodies. Drain all
// pending opens on failure so abandoned HTTP response streams are closed too.
export async function* prefetchWorkFiles<T>(
  entries: Iterable<T>,
  open: (entry: T, fileIndex: number) => Promise<WorkFileTransfer>,
): AsyncGenerator<WorkFileTransfer> {
  type Result = { value: WorkFileTransfer } | { error: unknown };
  const iterator = entries[Symbol.iterator]();
  const pending: Array<Promise<Result>> = [];
  let opened = 0, consumed = 0;
  function enqueue() {
    const next = iterator.next();
    if (!next.done) {
      const fileIndex = opened++;
      pending.push(Promise.resolve().then(() => measureSandboxOperation("work_folder.prefetch.open", { fileIndex, parallelism: 4 }, async () => open(next.value, fileIndex)))
      .then((value): Result => {
        // A response can fail while queued, before its async iterator exists.
        // Keep that error handled; consuming the stream still throws it.
        value.body?.on("error", () => {});
        return { value };
      }, (error): Result => ({ error })));
    }
  }
  try {
    for (let i = 0; i < 4; i++) enqueue();
    while (pending.length) {
      const next = pending.shift()!;
      const result = await measureSandboxOperation("work_folder.prefetch.wait", { fileIndex: consumed++, parallelism: 4 }, async () => next);
      if ("error" in result) throw result.error;
      try { yield result.value; } finally { result.value.body?.destroy(); }
      enqueue();
    }
  } finally {
    for (const result of await measureSandboxOperation("work_folder.prefetch.drain", { files: pending.length, parallelism: 4 }, async () => Promise.all(pending))) {
      if ("value" in result) result.value.body?.destroy();
    }
    iterator.return?.();
  }
}

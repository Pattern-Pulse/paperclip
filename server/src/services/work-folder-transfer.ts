import type { WorkFileTransfer } from "./work-folder-transport.js";

// Open a few storage responses ahead without buffering their bodies. Drain all
// pending opens on failure so abandoned HTTP response streams are closed too.
export async function* prefetchWorkFiles<T>(
  entries: Iterable<T>,
  open: (entry: T) => Promise<WorkFileTransfer>,
): AsyncGenerator<WorkFileTransfer> {
  type Result = { value: WorkFileTransfer } | { error: unknown };
  const iterator = entries[Symbol.iterator]();
  const pending: Array<Promise<Result>> = [];
  function enqueue() {
    const next = iterator.next();
    if (!next.done) pending.push(Promise.resolve().then(() => open(next.value))
      .then((value): Result => {
        // A response can fail while queued, before its async iterator exists.
        // Keep that error handled; consuming the stream still throws it.
        value.body?.on("error", () => {});
        return { value };
      }, (error): Result => ({ error })));
  }
  try {
    for (let i = 0; i < 4; i++) enqueue();
    while (pending.length) {
      const result = await pending.shift()!;
      if ("error" in result) throw result.error;
      try { yield result.value; } finally { result.value.body?.destroy(); }
      enqueue();
    }
  } finally {
    for (const result of await Promise.all(pending)) {
      if ("value" in result) result.value.body?.destroy();
    }
    iterator.return?.();
  }
}

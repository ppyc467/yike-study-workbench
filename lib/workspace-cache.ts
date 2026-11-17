import type { Cache, Snapshot } from "./outbox";

type StoredDraft = Omit<Cache, "base"> & { base: Omit<Snapshot, "state">; snapshotKey: string };
let connection: Promise<IDBDatabase> | undefined;

function pruneSnapshots(transaction: IDBTransaction) {
  const used = new Set<string>();
  const drafts = transaction.objectStore("drafts").openCursor();
  drafts.onsuccess = () => {
    const draft = drafts.result;
    if (draft) { used.add(draft.value.snapshotKey); draft.continue(); return; }
    const snapshots = transaction.objectStore("snapshots").openCursor();
    snapshots.onsuccess = () => {
      const cursor = snapshots.result;
      if (cursor) { if (!used.has(String(cursor.key))) cursor.delete(); cursor.continue(); }
    };
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("yike-workspace-v2", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("snapshots");
      request.result.createObjectStore("drafts");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
  });
  return connection;
}

/** Snapshot rows are shared by tabs at the same confirmed revision. */
export async function writeWorkspaceCache(key: string, cache: Cache): Promise<void> {
  const db = await openDatabase();
  const snapshotKey = `${key.slice(0, key.lastIndexOf(":"))}:${cache.base.revision}${cache.handledDiscards?.length ? `:${key}:${cache.handledDiscards.at(-1)}` : ""}`;
  const { state: _state, ...base } = cache.base;
  const draft: StoredDraft = { ...cache, base, snapshotKey };
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["snapshots", "drafts"], "readwrite");
    transaction.objectStore("snapshots").put(cache.base, snapshotKey);
    transaction.objectStore("drafts").put(draft, key);
    pruneSnapshots(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

export async function readWorkspaceCaches(prefix: string): Promise<{ key: string; value: Cache }[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["snapshots", "drafts"], "readonly");
    const drafts = transaction.objectStore("drafts").openCursor();
    const result: { key: string; value: Cache }[] = [];
    drafts.onsuccess = () => {
      const cursor = drafts.result;
      if (!cursor) return;
      const key = String(cursor.key);
      if (key.startsWith(prefix)) {
        const draft = cursor.value as StoredDraft;
        const snapshot = transaction.objectStore("snapshots").get(draft.snapshotKey);
        snapshot.onsuccess = () => {
          if (snapshot.result?.state) result.push({ key, value: { ...draft, base: { ...snapshot.result, ...draft.base } } });
        };
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function removeWorkspaceCache(key: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["drafts", "snapshots"], "readwrite");
    transaction.objectStore("drafts").delete(key);
    pruneSnapshots(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

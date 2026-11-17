import { env } from "cloudflare:workers";
import { StudyError, type Workspace } from "../lib/study";
import {
  createWorkspaceStore,
  type WorkspaceRepository,
  type WorkspaceRow,
  type WorkspaceStore,
  type WorkspaceValues,
} from "../lib/workspace-store";

const COLLECTIONS = ["projects", "tasks", "notes", "sessions", "reviews"] as const;
type Collection = typeof COLLECTIONS[number];
type StoredRecord = { kind: Collection; id: string; position: number; json: string };
type RecordRow = { kind: Collection; recordId: string; position: number; recordJson: string };
type Metadata = Record<string, unknown> & { _recordStorageVersion?: number; _recordCollections?: Collection[] };

// D1 has a per-row limit. The complete workspace can grow across independent records.
const MAX_RECORD_BYTES = 1_500_000;
const CHUNK_BYTES = 240_000;
const ROW_COLUMNS = "user_id AS userId, state_json AS stateJson, revision, last_mutation_id AS lastMutationId, updated_at AS updatedAt";
const WRITE_GUARD = "EXISTS (SELECT 1 FROM study_workspaces WHERE user_id = ? AND write_token = ?)";
const encoder = new TextEncoder();

function database(): D1Database {
  if (!env.DB) throw new Error("学习记录数据库暂时无法连接");
  return env.DB;
}

function key(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function checkedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (encoder.encode(json).byteLength > MAX_RECORD_BYTES) {
    throw new StudyError("单条学习记录内容过大，请将长笔记分成多篇后保存");
  }
  return json;
}

function splitState(stateJson: string, previous?: WorkspaceRow) {
  const state = JSON.parse(stateJson) as Workspace & Record<string, unknown>;
  const metadata: Metadata = { ...state };
  const records: StoredRecord[] = [];
  const collections: Collection[] = [];
  for (const kind of COLLECTIONS) {
    const entries = state[kind];
    if (!Array.isArray(entries)) continue;
    delete metadata[kind];
    collections.push(kind);
    const entriesWithPositions = entries.map((entry, index) => ({
      kind, id: entry.id as string, position: index, json: checkedJson(entry),
    }));
    // Normal editing only appends/removes records. Keep surviving positions so deleting
    // an early task does not rewrite thousands of unrelated task or session rows.
    if (previous?.recordPositions) {
      const positions = previous.recordPositions;
      let lastPosition = -1;
      let appended = false;
      let preservedOrder = true;
      for (const record of entriesWithPositions) {
        const position = positions[key(kind, record.id)];
        if (position === undefined) appended = true;
        else if (appended || position <= lastPosition) preservedOrder = false;
        else lastPosition = position;
      }
      if (preservedOrder) {
        let nextPosition = 0;
        for (const record of entriesWithPositions) {
          nextPosition = Math.max(nextPosition, (positions[key(kind, record.id)] ?? -1) + 1);
        }
        for (const record of entriesWithPositions) {
          record.position = positions[key(kind, record.id)] ?? nextPosition++;
        }
      }
    }
    for (const record of entriesWithPositions) records.push(record);
  }
  // Existing conversation guards and deletion triggers use this compact task index.
  metadata.tasks = state.tasks.map(task => ({ id: task.id }));
  metadata._recordStorageVersion = 1;
  metadata._recordCollections = collections;
  return { metadataJson: checkedJson(metadata), records };
}

function joinState(row: WorkspaceRow, entries: RecordRow[]): WorkspaceRow {
  const metadata = JSON.parse(row.stateJson) as Metadata;
  if (metadata._recordStorageVersion !== 1) return row;
  const state: Record<string, unknown> = { ...metadata };
  delete state.tasks;
  delete state._recordStorageVersion;
  delete state._recordCollections;
  const recordPositions: Record<string, number> = {};
  for (const kind of metadata._recordCollections ?? []) {
    state[kind] = entries.filter(record => record.kind === kind)
      .sort((left, right) => left.position - right.position)
      .map(record => {
        recordPositions[key(kind, record.recordId)] = record.position;
        return JSON.parse(record.recordJson);
      });
  }
  return { ...row, stateJson: JSON.stringify(state), recordPositions };
}

/** Pack JSON values into bounded SQL parameters instead of one statement per record. */
function chunks(values: unknown[]): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let bytes = 2;
  for (const value of values) {
    const json = JSON.stringify(value);
    const size = encoder.encode(json).byteLength + 1;
    if (current.length && bytes + size > CHUNK_BYTES) {
      result.push(`[${current.join(",")}]`);
      current = [];
      bytes = 2;
    }
    current.push(json);
    bytes += size;
  }
  if (current.length) result.push(`[${current.join(",")}]`);
  return result;
}

async function writeRecords(userId: string, values: WorkspaceValues, expectedRevision?: number, previous?: WorkspaceRow): Promise<WorkspaceRow | undefined> {
  const db = database();
  const next = splitState(values.stateJson, previous);
  const previousRecords = previous?.recordPositions ? splitState(previous.stateJson, previous).records : [];
  const before = new Map(previousRecords.map(record => [key(record.kind, record.id), record]));
  const after = new Map(next.records.map(record => [key(record.kind, record.id), record]));
  const changed = next.records.filter(record => {
    const old = before.get(key(record.kind, record.id));
    return !old || old.json !== record.json || old.position !== record.position;
  });
  const removed = previousRecords.filter(record => !after.has(key(record.kind, record.id)))
    .map(record => key(record.kind, record.id));
  // A unique attempt token makes every statement depend on THIS CAS winning,
  // including concurrent requests that reuse the same mutationId.
  const token = crypto.randomUUID();
  const first = expectedRevision === undefined
    ? db.prepare(`INSERT INTO study_workspaces (user_id, state_json, revision, last_mutation_id, updated_at, write_token)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`)
      .bind(userId, next.metadataJson, values.revision, values.lastMutationId, values.updatedAt, token)
    : db.prepare(`UPDATE study_workspaces SET state_json = ?, revision = ?, last_mutation_id = ?, updated_at = ?, write_token = ?
        WHERE user_id = ? AND revision = ? RETURNING user_id`)
      .bind(next.metadataJson, values.revision, values.lastMutationId, values.updatedAt, token, userId, expectedRevision);
  const statements = [first];
  for (const payload of chunks(changed.map(record => ({ kind: record.kind, id: record.id, position: record.position, data: JSON.parse(record.json) })))) {
    statements.push(db.prepare(`INSERT INTO study_workspace_records (user_id, kind, record_id, position, record_json)
      SELECT ?, json_extract(value, '$.kind'), json_extract(value, '$.id'), json_extract(value, '$.position'), json_extract(value, '$.data')
      FROM json_each(?) WHERE ${WRITE_GUARD}
      ON CONFLICT (user_id, kind, record_id) DO UPDATE SET position = excluded.position, record_json = excluded.record_json`)
      .bind(userId, payload, userId, token));
  }
  for (const payload of chunks(removed)) {
    statements.push(db.prepare(`DELETE FROM study_workspace_records
      WHERE user_id = ? AND kind || ':' || record_id IN (SELECT value FROM json_each(?)) AND ${WRITE_GUARD}`)
      .bind(userId, payload, userId, token));
  }
  const result = await db.batch(statements);
  if (!result[0].results.length) return undefined;
  const recordPositions = Object.fromEntries(next.records.map(record => [key(record.kind, record.id), record.position]));
  return { userId, ...values, recordPositions };
}

const repository: WorkspaceRepository = {
  async read(userId) {
    const db = database();
    // Both queries see one committed revision, including during lazy legacy migration.
    const [workspace, records] = await db.batch([
      db.prepare(`SELECT ${ROW_COLUMNS} FROM study_workspaces WHERE user_id = ?`).bind(userId),
      db.prepare(`SELECT kind, record_id AS recordId, position, record_json AS recordJson
        FROM study_workspace_records WHERE user_id = ?`).bind(userId),
    ]);
    const row = workspace.results[0] as WorkspaceRow | undefined;
    return row ? joinState(row, records.results as RecordRow[]) : undefined;
  },
  async readVersion(userId) {
    const row = await database().prepare("SELECT revision FROM study_workspaces WHERE user_id = ?")
      .bind(userId).first<{ revision: number }>();
    return row?.revision ?? 0;
  },
  async insert(userId, values) {
    return writeRecords(userId, values);
  },
  async update(userId, expectedRevision, values, previous) {
    const source = previous ?? await this.read(userId);
    return writeRecords(userId, values, expectedRevision, source);
  },
};

export const workspaceStore: WorkspaceStore = createWorkspaceStore({
  repository,
  storage: process.env.NODE_ENV === "development" ? "local" : "cloud",
});

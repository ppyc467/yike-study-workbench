import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
import type { Workspace } from "../lib/study";
import type { WorkspaceRepository, WorkspaceStore, WorkspaceValues } from "../lib/workspace-store";

const study = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
const NOW = Date.parse("2026-11-11T15:00:00+08:00");
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const coreModule = { exports: {} as typeof import("../lib/workspace-store") };
vm.runInNewContext(compile("../lib/workspace-store.ts"), {
  module: coreModule, exports: coreModule.exports, TextEncoder, JSON,
  require: () => study,
});
const core = coreModule.exports;

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0000_fearless_molly_hayes.sql", "0001_task_chat.sql", "0002_workspace_records.sql"]) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
  }
  let failAfterRecordWrites: number | undefined;
  let recordWriteCount = 0;
  const executed: { query: string; changes: number }[] = [];
  class Statement {
    readonly query: string;
    readonly values: (string | number | null)[];
    constructor(query: string, values: (string | number | null)[] = []) {
      this.query = query;
      this.values = values;
    }
    bind(...values: (string | number | null)[]) { return new Statement(this.query, values); }
    execute() {
      if (/^(INSERT INTO|DELETE FROM) study_workspace_records/.test(this.query)) {
        if (failAfterRecordWrites !== undefined && recordWriteCount >= failAfterRecordWrites) {
          throw new Error("Injected record write failure");
        }
        recordWriteCount++;
      }
      const results = sqlite.prepare(this.query).all(...this.values);
      const changes = sqlite.prepare("SELECT changes() AS count").get() as { count: number };
      executed.push({ query: this.query, changes: changes.count });
      return { results, meta: { changes: changes.count }, success: true };
    }
    async first() { return this.execute().results[0] ?? null; }
  }
  const database = {
    prepare(query: string) { return new Statement(query); },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let repository!: WorkspaceRepository;
  const module = { exports: {} as { workspaceStore: WorkspaceStore } };
  vm.runInNewContext(compile("../db/workspace-store.ts"), {
    module, exports: module.exports, TextEncoder, JSON, crypto, process: { env: { NODE_ENV: "test" } },
    require: (name: string) => {
      if (name === "cloudflare:workers") return { env: { DB: database } };
      if (name === "../lib/study") return study;
      assert.equal(name, "../lib/workspace-store");
      return { ...core, createWorkspaceStore(options: Parameters<typeof core.createWorkspaceStore>[0]) {
        repository = options.repository;
        return core.createWorkspaceStore({ ...options, now: () => NOW });
      } };
    },
  });
  let mutationNumber = 0;
  return {
    sqlite, executed, repository, store: module.exports.workspaceStore,
    failRecordWrite(after = 0) { recordWriteCount = 0; failAfterRecordWrites = after; },
    async mutate(commands: unknown[], userId = "user-a") {
      const snapshot = await module.exports.workspaceStore.readVersion(userId);
      return module.exports.workspaceStore.mutate(userId, { baseRevision: snapshot.revision, mutationId: `write-${++mutationNumber}`, commands });
    },
    legacy(state: Workspace & Record<string, unknown>, userId = "user-a", revision = 4) {
      sqlite.prepare("INSERT INTO study_workspaces (user_id, state_json, revision, updated_at) VALUES (?, ?, ?, ?)")
        .run(userId, JSON.stringify(state), revision, NOW);
    },
    count(table: string) { return (sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count; },
  };
}

function task(id: string) {
  return { type: "task.add", id, projectId: "course", title: id, at: NOW };
}

function values(state: Workspace, revision = 1, mutationId = "direct"): WorkspaceValues {
  return { stateJson: JSON.stringify(state), revision, lastMutationId: mutationId, updatedAt: NOW };
}

test("legacy reads preserve JSON and first successful mutation migrates all collections atomically", async () => {
  const f = fixture();
  const state = study.applyCommand(study.initialWorkspace(), task("old-task") as Parameters<typeof study.applyCommand>[1]) as Workspace & Record<string, unknown>;
  state.customPreference = { retained: true };
  f.legacy(state);
  const original = (f.sqlite.prepare("SELECT state_json AS json FROM study_workspaces").get() as { json: string }).json;
  assert.deepEqual((await f.store.read("user-a")).state, state);
  assert.equal(f.count("study_workspace_records"), 0);
  assert.equal((f.sqlite.prepare("SELECT state_json AS json FROM study_workspaces").get() as { json: string }).json, original);
  const saved = await f.mutate([{ type: "task.update", id: "old-task", title: "已迁移", at: NOW }]);
  assert.equal(saved.revision, 5);
  assert.equal(saved.state.tasks[0].title, "已迁移");
  assert.deepEqual((await f.store.read("user-a")).state, saved.state);
  assert.deepEqual(((await f.store.read("user-a")).state as Workspace & Record<string, unknown>).customPreference, { retained: true });
  assert.ok(f.count("study_workspace_records") >= 4);
  const metadata = JSON.parse((f.sqlite.prepare("SELECT state_json AS json FROM study_workspaces").get() as { json: string }).json);
  assert.equal(metadata._recordStorageVersion, 1);
  assert.deepEqual(metadata.tasks, [{ id: "old-task" }]);
  f.sqlite.close();
});

test("ordinary note saves grow beyond 1.5MB with bounded individual D1 rows", async () => {
  const f = fixture();
  for (let index = 0; index < 12; index++) {
    await f.mutate([{ type: "note.add", id: `note-${index}`, projectId: "course", title: `课程笔记${index}`, body: "学".repeat(50_000), at: NOW }]);
  }
  const saved = await f.store.read("user-a");
  assert.equal(saved.state.notes?.length, 12);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved.state)).byteLength > 1_800_000);
  const lengths = f.sqlite.prepare("SELECT length(CAST(record_json AS BLOB)) AS bytes FROM study_workspace_records").all() as { bytes: number }[];
  assert.ok(lengths.every(row => row.bytes < 1_500_000));
  assert.equal((await f.store.readVersion("user-a")).revision, 12);
  f.sqlite.close();
});

test("editing or deleting one record leaves sibling rows untouched and preserves display order", async () => {
  const f = fixture();
  await f.mutate([task("first"), task("second"), task("third")]);
  f.executed.length = 0;
  await f.mutate([{ type: "task.update", id: "second", notes: "只改这一条", at: NOW }]);
  const writes = f.executed.filter(entry => entry.query.startsWith("INSERT INTO study_workspace_records"));
  assert.deepEqual(writes.map(entry => entry.changes), [1]);
  f.executed.length = 0;
  await f.mutate([{ type: "task.delete", id: "first", at: NOW }]);
  assert.equal(f.executed.filter(entry => entry.query.startsWith("INSERT INTO study_workspace_records")).length, 0);
  assert.deepEqual(f.executed.filter(entry => entry.query.startsWith("DELETE FROM study_workspace_records")).map(entry => entry.changes), [1]);
  await f.mutate([task("fourth")]);
  assert.deepEqual((await f.store.read("user-a")).state.tasks.map(item => item.id), ["second", "third", "fourth"]);
  f.sqlite.close();
});

test("concurrent first writes have one CAS winner and cannot leak the losing records", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.store.mutate("user-a", { baseRevision: 0, mutationId: "first", commands: [task("first")] }),
    f.store.mutate("user-a", { baseRevision: 0, mutationId: "second", commands: [task("second")] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failed = results.find(result => result.status === "rejected");
  assert.ok(failed?.status === "rejected" && failed.reason instanceof core.WorkspaceConflict);
  assert.deepEqual((await f.store.read("user-a")).state.tasks.map(item => item.id), ["first"]);
  const record = f.sqlite.prepare("SELECT record_id AS id FROM study_workspace_records WHERE kind = 'tasks'").all() as { id: string }[];
  assert.deepEqual(record.map(item => item.id), ["first"]);
  f.sqlite.close();
});

test("concurrent same-mutation attempts cannot write different records after losing their own CAS", async () => {
  const f = fixture();
  await f.mutate([task("base")]);
  const results = await Promise.all([
    f.store.mutate("user-a", { baseRevision: 1, mutationId: "same-attempt", commands: [task("winner")] }),
    f.store.mutate("user-a", { baseRevision: 1, mutationId: "same-attempt", commands: [task("must-not-appear")] }),
  ]);
  assert.equal(results[0].revision, 2);
  assert.equal(results[1].revision, 2);
  assert.deepEqual((await f.store.read("user-a")).state.tasks.map(item => item.id), ["base", "winner"]);
  assert.equal(f.count("study_workspace_records"), 5);
  f.sqlite.close();
});

test("record write failures roll back metadata, task deletion and chat cleanup together", async () => {
  const f = fixture();
  await f.mutate([task("protected")]);
  f.sqlite.prepare("INSERT INTO task_chat_conversations (user_id, task_id, memory, updated_at) VALUES (?, ?, ?, ?)")
    .run("user-a", "protected", "必须保留的学习记忆", NOW);
  f.failRecordWrite();
  await assert.rejects(f.mutate([{ type: "task.delete", id: "protected", at: NOW }]), /Injected record write failure/);
  assert.equal((await f.store.readVersion("user-a")).revision, 1);
  assert.deepEqual((await f.store.read("user-a")).state.tasks.map(item => item.id), ["protected"]);
  assert.equal(f.count("task_chat_conversations"), 1);
  f.sqlite.close();
});

test("the compact task index preserves chat membership and cleans removed tasks across normalized writes", async () => {
  const f = fixture();
  await f.mutate([task("task-a"), task("task-b")]);
  f.sqlite.prepare("INSERT INTO task_chat_conversations (user_id, task_id, memory, updated_at) VALUES (?, ?, ?, ?)")
    .run("user-a", "task-a", "学习记忆", NOW);
  const exists = f.sqlite.prepare(`SELECT EXISTS (SELECT 1 FROM study_workspaces w, json_each(w.state_json, '$.tasks') task
    WHERE w.user_id = ? AND json_extract(task.value, '$.id') = ?) AS found`).get("user-a", "task-a") as { found: number };
  assert.equal(exists.found, 1);
  await f.mutate([{ type: "task.update", id: "task-a", title: "改名保留对话", at: NOW }]);
  assert.equal(f.count("task_chat_conversations"), 1);
  await f.mutate([{ type: "task.delete", id: "task-a", at: NOW }]);
  assert.equal(f.count("task_chat_conversations"), 0);
  assert.deepEqual((await f.store.read("user-a")).state.tasks.map(item => item.id), ["task-b"]);
  f.sqlite.close();
});

test("lightweight revision checks avoid record reads and enforce identity isolation", async () => {
  const f = fixture();
  await f.mutate([task("private-a")]);
  await f.mutate([task("private-b")], "user-b");
  f.executed.length = 0;
  assert.deepEqual(structuredClone(await f.store.readVersion("user-a")), { revision: 1, serverNow: NOW, storage: "cloud" });
  assert.deepEqual(f.executed.map(entry => entry.query), ["SELECT revision FROM study_workspaces WHERE user_id = ?"]);
  assert.equal((await f.store.readVersion("missing-user")).revision, 0);
  assert.deepEqual((await f.store.read("user-a")).state.tasks.map(item => item.id), ["private-a"]);
  assert.deepEqual((await f.store.read("user-b")).state.tasks.map(item => item.id), ["private-b"]);
  await assert.rejects(f.store.readVersion(""), /请先登录/);
  f.sqlite.close();
});

test("future scalar metadata and review arrays survive record storage and intentional reordering", async () => {
  const f = fixture();
  let state = study.applyCommand(study.initialWorkspace(), task("one") as Parameters<typeof study.applyCommand>[1]);
  state = study.applyCommand(state, task("two") as Parameters<typeof study.applyCommand>[1]);
  const extended = { ...state, customSetting: "preserved", reviews: [{ id: "review-a", taskId: "one", question: "问题", answer: "答案", createdAt: NOW, dueAt: NOW, intervalDays: 0, attempts: [] }] };
  await f.repository.insert("user-a", values(extended));
  const previous = await f.repository.read("user-a");
  assert.ok(previous);
  const reordered = { ...extended, tasks: [...extended.tasks].reverse() };
  await f.repository.update("user-a", 1, values(reordered, 2), previous);
  assert.deepEqual((await f.store.read("user-a")).state, reordered);
  const row = f.sqlite.prepare("SELECT record_json AS json FROM study_workspace_records WHERE kind = 'reviews'").get() as { json: string };
  assert.equal(JSON.parse(row.json).id, "review-a");
  f.sqlite.close();
});

test("individual oversized records fail before any workspace metadata is written", async () => {
  const f = fixture();
  const oversized = { ...study.initialWorkspace(), notes: [{ id: "huge", projectId: "course", title: "巨大正文", body: "x".repeat(1_500_001), important: false, createdAt: NOW, updatedAt: NOW }] };
  await assert.rejects(f.repository.insert("user-a", values(oversized)), /单条学习记录内容过大/);
  assert.equal(f.count("study_workspaces"), 0);
  assert.equal(f.count("study_workspace_records"), 0);
  f.sqlite.close();
});

test("legacy paused timers keep every segment, session id and original optional fields through migration", async () => {
  const f = fixture();
  let state = study.applyCommand(study.initialWorkspace(), task("timer-task") as Parameters<typeof study.applyCommand>[1]);
  state = study.applyCommand(state, { type: "session.start", id: "ongoing", taskId: "timer-task", mode: "free", targetMs: 0, at: NOW - 120_000 });
  state = study.applyCommand(state, { type: "session.pause", at: NOW - 60_000 });
  delete state.notes;
  delete state.reviews;
  f.legacy(state);
  await f.mutate([{ type: "settings.goal", minutes: 180, at: NOW }]);
  const migrated = (await f.store.read("user-a")).state;
  assert.equal(migrated.activeSessionId, "ongoing");
  assert.deepEqual(migrated.sessions, state.sessions);
  assert.equal(study.sessionElapsedMs(migrated.sessions[0], NOW), 60_000);
  assert.equal(Object.hasOwn(migrated, "notes"), false);
  assert.equal(Object.hasOwn(migrated, "reviews"), false);
  f.sqlite.close();
});

test("a later migration chunk failure leaves the complete legacy JSON and all chats intact", async () => {
  const f = fixture();
  let state = study.applyCommand(study.initialWorkspace(), task("legacy-task") as Parameters<typeof study.applyCommand>[1]);
  for (let index = 0; index < 8; index++) {
    state = study.applyCommand(state, { type: "note.add", id: `legacy-${index}`, projectId: "course", title: "旧笔记", body: "学".repeat(50_000), at: NOW });
  }
  f.legacy(state);
  f.sqlite.prepare("INSERT INTO task_chat_conversations (user_id, task_id, memory, updated_at) VALUES (?, ?, ?, ?)")
    .run("user-a", "legacy-task", "旧记忆", NOW);
  const original = (f.sqlite.prepare("SELECT state_json AS json FROM study_workspaces").get() as { json: string }).json;
  f.failRecordWrite(1);
  await assert.rejects(f.mutate([{ type: "settings.goal", minutes: 180, at: NOW }]), /Injected record write failure/);
  assert.ok(f.executed.some(entry => entry.query.startsWith("INSERT INTO study_workspace_records") && entry.changes > 0));
  assert.equal(f.count("study_workspace_records"), 0);
  assert.equal((f.sqlite.prepare("SELECT state_json AS json FROM study_workspaces").get() as { json: string }).json, original);
  assert.equal((await f.store.readVersion("user-a")).revision, 4);
  assert.deepEqual((await f.store.read("user-a")).state, state);
  assert.equal(f.count("task_chat_conversations"), 1);
  f.sqlite.close();
});

test("concurrent migration and task deletion cannot mix the two candidate states", async () => {
  const f = fixture();
  const state = study.applyCommand(study.initialWorkspace(), task("legacy") as Parameters<typeof study.applyCommand>[1]);
  f.legacy(state);
  const results = await Promise.allSettled([
    f.store.mutate("user-a", { baseRevision: 4, mutationId: "migrate-winner", commands: [{ type: "task.update", id: "legacy", title: "保留任务", at: NOW }] }),
    f.store.mutate("user-a", { baseRevision: 4, mutationId: "migrate-loser", commands: [{ type: "task.delete", id: "legacy", at: NOW }] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const snapshot = await f.store.read("user-a");
  assert.equal(snapshot.revision, 5);
  assert.equal(snapshot.state.tasks[0].title, "保留任务");
  assert.equal(f.count("study_workspace_records"), 4);
  f.sqlite.close();
});

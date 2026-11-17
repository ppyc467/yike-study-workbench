import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { Command } from "../lib/study";
import type { WorkspaceRepository, WorkspaceRow, WorkspaceValues } from "../lib/workspace-store";

const study = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
const compiled = ts.transpileModule(readFileSync(new URL("../lib/workspace-store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const storeModule = { exports: {} as typeof import("../lib/workspace-store") };
vm.runInNewContext(compiled, {
  module: storeModule, exports: storeModule.exports, TextEncoder, JSON,
  require: (name: string) => { assert.equal(name, "./study"); return study; },
});
const { createWorkspaceStore, WorkspaceConflict } = storeModule.exports;
const NOW = Date.parse("2026-10-23T10:00:00+08:00");
const USER = "test-user-one";

class MemoryRepository implements WorkspaceRepository {
  rows = new Map<string, WorkspaceRow>();
  reads: { userId: string; revision: number }[] = [];
  writes = 0;

  async read(userId: string) {
    const row = this.rows.get(userId);
    this.reads.push({ userId, revision: row?.revision ?? 0 });
    return row ? structuredClone(row) : undefined;
  }
  async insert(userId: string, values: WorkspaceValues) {
    if (this.rows.has(userId)) return undefined;
    const row = { userId, ...structuredClone(values) };
    this.rows.set(userId, row);
    this.writes++;
    return structuredClone(row);
  }
  async update(userId: string, expectedRevision: number, values: WorkspaceValues) {
    if (this.rows.get(userId)?.revision !== expectedRevision) return undefined;
    const row = { userId, ...structuredClone(values) };
    this.rows.set(userId, row);
    this.writes++;
    return structuredClone(row);
  }
}

function fixture() {
  const repository = new MemoryRepository();
  const store = createWorkspaceStore({ repository, now: () => NOW, storage: "local" });
  return { repository, store };
}

function add(id = "task-1"): Command {
  return { type: "task.add", id, projectId: "course", title: `练习 ${id}`, at: NOW };
}
function request(baseRevision = 0, mutationId = "operation-1", commands: Command[] = [add()]) {
  return { baseRevision, mutationId, commands };
}

test("reading an empty workspace returns a fresh snapshot without persisting or inventing progress", async () => {
  const { repository, store } = fixture();
  const snapshot = await store.read(USER);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.serverNow, NOW);
  assert.equal(snapshot.storage, "local");
  assert.deepEqual(snapshot.state, study.initialWorkspace());
  assert.equal(repository.writes, 0);
  snapshot.state.projects[0].title = "仅修改返回值";
  assert.equal((await store.read(USER)).state.projects[0].title, "课程学习");
});

test("two first-ever saves have a single winner and return the winner's snapshot on conflict", async () => {
  const { repository, store } = fixture();
  const results = await Promise.allSettled([
    store.mutate(USER, request(0, "create-first", [add("first")])),
    store.mutate(USER, request(0, "create-second", [add("second")])),
  ]);
  assert.deepEqual(repository.reads.slice(0, 2).map((entry) => entry.revision), [0, 0]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof WorkspaceConflict);
  const saved = await store.read(USER);
  assert.equal(saved.revision, 1);
  assert.equal(saved.state.tasks.length, 1);
  assert.equal(repository.writes, 1);
  assert.deepEqual(rejected.reason.snapshot, saved);
});

test("concurrent updates based on the same revision cannot overwrite the winning edit", async () => {
  const { repository, store } = fixture();
  await store.mutate(USER, request());
  repository.reads.length = 0;
  const results = await Promise.allSettled([
    store.mutate(USER, request(1, "edit-first", [{ type: "task.update", id: "task-1", notes: "第一份笔记", at: NOW }])),
    store.mutate(USER, request(1, "edit-second", [{ type: "task.update", id: "task-1", notes: "第二份笔记", at: NOW }])),
  ]);
  assert.deepEqual(repository.reads.slice(0, 2).map((entry) => entry.revision), [1, 1]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected" && rejected.reason instanceof WorkspaceConflict);
  const saved = await store.read(USER);
  assert.equal(saved.revision, 2);
  assert.equal(repository.writes, 2);
  assert.equal(saved.state.tasks[0].notes, "第一份笔记");
  assert.deepEqual(rejected.reason.snapshot, saved);
});

test("an immediate retry, including two racing copies, acknowledges only one persisted mutation", async () => {
  const { repository, store } = fixture();
  const payload = request();
  const [first, raced] = await Promise.all([
    store.mutate(USER, payload),
    store.mutate(USER, payload),
  ]);
  assert.deepEqual(first, raced);
  assert.deepEqual(await store.mutate(USER, payload), first);
  assert.equal(repository.writes, 1);
  assert.equal((await store.read(USER)).state.tasks.length, 1);
});

test("a delayed retry after another successful mutation conflicts and preserves the newer state", async () => {
  const { repository, store } = fixture();
  const original = request();
  await store.mutate(USER, original);
  await store.mutate(USER, request(1, "next-operation", [{ type: "task.update", id: "task-1", notes: "后来保存的笔记", at: NOW }]));
  await assert.rejects(store.mutate(USER, original), WorkspaceConflict);
  const saved = await store.read(USER);
  assert.equal(saved.revision, 2);
  assert.equal(saved.state.tasks[0].notes, "后来保存的笔记");
  assert.equal(repository.writes, 2);
});

test("invalid input and commands are rejected before reading or writing any workspace", async () => {
  const { repository, store } = fixture();
  const invalid: unknown[] = [
    null, [], "invalid", {},
    { ...request(), userId: "someone-else" },
    { ...request(), baseRevision: -1 },
    { ...request(), baseRevision: 1.5 },
    { ...request(), mutationId: "" },
    { ...request(), mutationId: "x".repeat(101) },
    { ...request(), commands: [] },
    { ...request(), commands: Array.from({ length: 101 }, () => add()) },
    { ...request(), commands: [{ ...add(), admin: true }] },
    { ...request(), commands: [{ ...add(), title: "  " }] },
    { ...request(), commands: [{ type: "task.update", id: "task-1", pinned: "true", at: NOW }] },
    { ...request(), commands: [{ type: "task.update", id: "task-1", notes: "a".repeat(20_001), at: NOW }] },
  ];
  for (const payload of invalid) await assert.rejects(store.mutate(USER, payload), study.StudyError);
  assert.equal(repository.reads.length, 0);
  assert.equal(repository.writes, 0);
});

test("future commands beyond the clock tolerance are rejected while the exact boundary is accepted", async () => {
  const { repository, store } = fixture();
  await assert.rejects(store.mutate(USER, request(0, "future", [{ ...add(), at: NOW + 60_001 }])), /设备时间超前/);
  assert.equal(repository.writes, 0);
  const saved = await store.mutate(USER, request(0, "within-tolerance", [{ ...add(), at: NOW + 60_000 }]));
  assert.equal(saved.revision, 1);
  assert.equal(saved.state.tasks[0].createdAt, NOW + 60_000);
});

test("a failing command leaves earlier commands in the same batch uncommitted", async () => {
  const { repository, store } = fixture();
  await assert.rejects(store.mutate(USER, request(0, "atomic-batch", [
    add(),
    { type: "task.update", id: "task-1", projectId: "missing", at: NOW },
  ])), /所属项目不存在/);
  assert.equal(repository.writes, 0);
  assert.equal((await store.read(USER)).state.tasks.length, 0);
});

test("running and paused timers remain protected when mutations arrive through the shared store", async () => {
  for (const paused of [false, true]) {
    const { repository, store } = fixture();
    const commands: Command[] = [add(), { type: "session.start", id: "session-1", taskId: "task-1", mode: "free", targetMs: 0, at: NOW }];
    if (paused) commands.push({ type: "session.pause", at: NOW });
    const initial = await store.mutate(USER, request(0, "start", commands));
    for (const fields of [{ status: "done" as const }, { archived: true }]) {
      await assert.rejects(store.mutate(USER, request(1, "cannot-finish", [{ type: "task.update", id: "task-1", ...fields, at: NOW }])), /请先结束/);
      assert.deepEqual(await store.read(USER), initial);
    }
    assert.equal(repository.writes, 1);
  }
});

test("user identities isolate reads, revisions, mutation acknowledgements and state", async () => {
  const { repository, store } = fixture();
  await store.mutate(USER, request());
  const empty = await store.read("test-user-two");
  assert.equal(empty.revision, 0);
  assert.equal(empty.state.tasks.length, 0);
  const second = await store.mutate("test-user-two", request(0, "operation-1", [add("different-task")]));
  assert.equal(second.revision, 1);
  assert.equal(second.state.tasks[0].id, "different-task");
  assert.equal((await store.read(USER)).state.tasks[0].id, "task-1");
  assert.equal(repository.rows.size, 2);
  assert.equal(repository.writes, 2);
});

test("empty or invalid identity cannot trigger repository reads or writes", async () => {
  const { repository, store } = fixture();
  for (const userId of ["", "   ", null, undefined, 42] as unknown as string[]) {
    await assert.rejects(store.read(userId), /请先登录/);
    await assert.rejects(store.mutate(userId, request()), /请先登录/);
  }
  assert.equal(repository.reads.length, 0);
  assert.equal(repository.writes, 0);
});

test("a workspace can exceed the former whole-state limit while preserving ordinary writes", async () => {
  const { repository, store } = fixture();
  const state = study.initialWorkspace();
  state.tasks = Array.from({ length: 73 }, (_, index) => ({
    id: `task-${index}`, projectId: "course", title: "任务", status: "todo", notes: "a".repeat(20_000), createdAt: NOW,
  }));
  const stateJson = JSON.stringify(state);
  assert.ok(new TextEncoder().encode(stateJson).byteLength < 1_500_000);
  repository.rows.set(USER, { userId: USER, stateJson, revision: 1, lastMutationId: "seed", updatedAt: NOW });
  const saved = await store.mutate(USER, request(1, "large-notes", [{ type: "task.update", id: "task-0", notes: "学".repeat(20_000), at: NOW }]));
  assert.equal(repository.writes, 1);
  assert.ok(new TextEncoder().encode(repository.rows.get(USER)!.stateJson).byteLength > 1_500_000);
  assert.equal(saved.state.tasks[0].notes, "学".repeat(20_000));
  assert.equal((await store.read(USER)).revision, 2);
});

test("lightweight versions use the repository optimization and retain legacy repository compatibility", async () => {
  const legacy = fixture();
  assert.deepEqual(structuredClone(await legacy.store.readVersion(USER)), { revision: 0, serverNow: NOW, storage: "local" });
  assert.equal(legacy.repository.reads.length, 1);
  let versionReads = 0;
  const repository = new MemoryRepository() as MemoryRepository & { readVersion: (userId: string) => Promise<number> };
  repository.readVersion = async userId => { assert.equal(userId, USER); versionReads++; return 17; };
  const store = createWorkspaceStore({ repository, now: () => NOW });
  assert.deepEqual(structuredClone(await store.readVersion(USER)), { revision: 17, serverNow: NOW, storage: "cloud" });
  assert.equal(versionReads, 1);
  assert.equal(repository.reads.length, 0);
  await assert.rejects(store.readVersion(""), /请先登录/);
  assert.equal(versionReads, 1);
});

test("a stale task deletion cannot erase history saved by another device, including a race after both reads", async () => {
  for (const deleteHistory of [undefined, true]) {
    const { repository, store } = fixture();
    await store.mutate(USER, request());
    repository.reads.length = 0;
    const deletion = request(1, "delete-after-review", [{ type: "task.delete", id: "task-1", deleteHistory, at: NOW }]);
    const results = await Promise.allSettled([
      store.mutate(USER, request(1, "new-study-record", [
        { type: "session.start", id: "new-session", taskId: "task-1", mode: "free", targetMs: 0, at: NOW - 60_000 },
        { type: "session.finish", at: NOW },
      ])),
      store.mutate(USER, deletion),
    ]);
    assert.deepEqual(repository.reads.slice(0, 2).map((entry) => entry.revision), [1, 1], "both devices read the same revision before the race");
    assert.equal(results[0].status, "fulfilled");
    assert.ok(results[1].status === "rejected" && results[1].reason instanceof WorkspaceConflict);
    const saved = await store.read(USER);
    assert.equal(saved.revision, 2);
    assert.equal(saved.state.tasks[0].id, "task-1");
    assert.equal(saved.state.sessions[0].id, "new-session");
    assert.equal(study.totalsByDay(saved.state, NOW)["2026-10-23"], 60_000);
    assert.deepEqual(results[1].reason.snapshot, saved);
    await assert.rejects(store.mutate(USER, deletion), WorkspaceConflict, "an already-stale request also remains rejected");
    await assert.rejects(store.mutate(USER, request(2, "delete-without-confirmation", [
      { type: "task.delete", id: "task-1", at: NOW },
    ])), /确认同时删除学习记录/);
    assert.equal(repository.writes, 2);
    const confirmed = request(2, "delete-confirmed-history", [{ type: "task.delete", id: "task-1", deleteHistory: true, at: NOW }]);
    const removed = await store.mutate(USER, confirmed);
    assert.equal(removed.revision, 3);
    assert.equal(removed.state.tasks.length, 0);
    assert.equal(removed.state.sessions.length, 0);
    assert.equal(removed.state.activeSessionId, null);
    assert.deepEqual(await store.mutate(USER, confirmed), removed, "retrying the same delete acknowledges its original save");
    assert.equal(repository.writes, 3);
  }
});

test("an unconfirmed history deletion rolls back earlier edits in the same batch", async () => {
  const { repository, store } = fixture();
  const original = await store.mutate(USER, request(0, "task-with-history", [
    add(),
    { type: "session.start", id: "session-1", taskId: "task-1", mode: "free", targetMs: 0, at: NOW },
    { type: "session.finish", at: NOW },
  ]));
  await assert.rejects(store.mutate(USER, request(1, "unsafe-batch", [
    { type: "task.update", id: "task-1", notes: "不应留下的修改", at: NOW },
    { type: "task.delete", id: "task-1", at: NOW },
  ])), /确认同时删除学习记录/);
  assert.deepEqual(await store.read(USER), original);
  assert.equal(repository.writes, 1);
});

test("independent note CRUD on an older snapshot supports identical retries without duplicate notes", async () => {
  const { repository, store } = fixture();
  const legacy = study.applyCommand(study.initialWorkspace(), add());
  delete legacy.notes;
  legacy.tasks[0].notes = "原有任务笔记";
  repository.rows.set(USER, { userId: USER, stateJson: JSON.stringify(legacy), revision: 1, lastMutationId: "legacy", updatedAt: NOW });
  const creation = request(1, "create-note", [{ type: "note.add", id: "note-1", projectId: "course", title: "复习笔记", body: "初始正文", at: NOW }]);
  const [first, raced] = await Promise.all([store.mutate(USER, creation), store.mutate(USER, creation)]);
  assert.deepEqual(first, raced);
  assert.deepEqual(await store.mutate(USER, creation), first);
  assert.equal(first.state.notes?.length, 1);
  assert.equal(repository.writes, 1);
  const edit = request(2, "edit-note", [{ type: "note.update", id: "note-1", body: "补充正文", important: true, projectId: "english", at: NOW }]);
  const changed = await store.mutate(USER, edit);
  assert.deepEqual(await store.mutate(USER, edit), changed);
  assert.equal(changed.state.notes?.[0].body, "补充正文");
  assert.equal(changed.state.notes?.[0].important, true);
  assert.equal(changed.state.notes?.[0].projectId, "english");
  const deletion = request(3, "delete-note", [{ type: "note.delete", id: "note-1", at: NOW }]);
  const removed = await store.mutate(USER, deletion);
  assert.deepEqual(await store.mutate(USER, deletion), removed);
  assert.deepEqual(removed.state.notes, []);
  assert.deepEqual(removed.state.tasks, legacy.tasks);
  assert.equal(repository.writes, 3);
});

test("a failed note command rolls back note creation and editing earlier in the batch", async () => {
  const { repository, store } = fixture();
  const initial = await store.read(USER);
  await assert.rejects(store.mutate(USER, request(0, "atomic-note-batch", [
    { type: "note.add", id: "note-1", projectId: "course", title: "复习笔记", body: "初始正文", at: NOW },
    { type: "note.update", id: "note-1", body: "不应提交", important: true, at: NOW },
    { type: "note.update", id: "note-1", projectId: "missing", at: NOW },
  ])), /所属项目不存在/);
  assert.deepEqual(await store.read(USER), initial);
  assert.equal(repository.writes, 0);
});

test("concurrent note deletion cannot erase a newer edit and the conflict includes its full contents", async () => {
  const { repository, store } = fixture();
  await store.mutate(USER, request(0, "create-note", [{ type: "note.add", id: "note-1", projectId: "course", title: "复习笔记", at: NOW }]));
  repository.reads.length = 0;
  const deletion = request(1, "delete-stale-note", [{ type: "note.delete", id: "note-1", at: NOW }]);
  const results = await Promise.allSettled([
    store.mutate(USER, request(1, "edit-new-note", [{ type: "note.update", id: "note-1", body: "另一台设备的新内容", important: true, at: NOW }])),
    store.mutate(USER, deletion),
  ]);
  assert.deepEqual(repository.reads.slice(0, 2).map(entry => entry.revision), [1, 1]);
  assert.equal(results[0].status, "fulfilled");
  assert.ok(results[1].status === "rejected" && results[1].reason instanceof WorkspaceConflict);
  const saved = await store.read(USER);
  assert.equal(saved.state.notes?.[0].body, "另一台设备的新内容");
  assert.equal(saved.state.notes?.[0].important, true);
  assert.deepEqual(results[1].reason.snapshot, saved);
  await assert.rejects(store.mutate(USER, deletion), WorkspaceConflict);
  assert.equal(repository.writes, 2);
});

test("a project containing only independent notes keeps its notes until transfer is explicitly provided", async () => {
  const { repository, store } = fixture();
  const original = await store.mutate(USER, request(0, "create-note", [{ type: "note.add", id: "note-1", projectId: "english", title: "英语笔记", body: "待复习", at: NOW }]));
  await assert.rejects(store.mutate(USER, request(1, "delete-project-unconfirmed", [{ type: "project.delete", id: "english", at: NOW }])), /请选择一个项目/);
  assert.deepEqual(await store.read(USER), original);
  const transfer = request(1, "transfer-notes", [{ type: "project.delete", id: "english", targetProjectId: "course", at: NOW }]);
  const moved = await store.mutate(USER, transfer);
  assert.equal(moved.state.notes?.[0].projectId, "course");
  assert.equal(moved.state.notes?.[0].body, "待复习");
  assert.equal(moved.state.projects.some(project => project.id === "english"), false);
  assert.deepEqual(await store.mutate(USER, transfer), moved);
  assert.equal(repository.writes, 2);
});

test("older unlinked notes can attach and survive task movement and idempotent task deletion", async () => {
  const { repository, store } = fixture();
  let legacy = study.applyCommand(study.initialWorkspace(), add());
  legacy = study.applyCommand(legacy, { type: "note.add", id: "note-1", projectId: "course", title: "既有笔记", body: "保留内容", at: NOW });
  assert.equal(Object.hasOwn(legacy.notes![0], "taskId"), false);
  repository.rows.set(USER, { userId: USER, stateJson: JSON.stringify(legacy), revision: 1, lastMutationId: "legacy", updatedAt: NOW });
  const attach = request(1, "attach-note", [{ type: "note.update", id: "note-1", taskId: "task-1", at: NOW }]);
  const linked = await store.mutate(USER, attach);
  assert.deepEqual(await store.mutate(USER, attach), linked);
  assert.equal(linked.state.notes?.[0].taskId, "task-1");
  const moved = await store.mutate(USER, request(2, "move-task", [{ type: "task.update", id: "task-1", projectId: "english", at: NOW }]));
  assert.equal(moved.state.notes?.[0].projectId, "english");
  assert.equal(moved.state.notes?.[0].taskId, "task-1");
  const deletion = request(3, "delete-task-keep-note", [{ type: "task.delete", id: "task-1", at: NOW }]);
  const removed = await store.mutate(USER, deletion);
  assert.deepEqual(await store.mutate(USER, deletion), removed);
  assert.equal(removed.state.tasks.length, 0);
  assert.equal(removed.state.notes?.length, 1);
  assert.equal(removed.state.notes?.[0].body, "保留内容");
  assert.equal(removed.state.notes?.[0].projectId, "english");
  assert.equal(Object.hasOwn(removed.state.notes![0], "taskId"), false);
  assert.equal(repository.writes, 3);
});

test("an invalid task association rolls back task and note project moves in the same batch", async () => {
  const { repository, store } = fixture();
  const original = await store.mutate(USER, request(0, "task-with-linked-notes", [
    add(),
    { type: "note.add", id: "note-1", projectId: "course", taskId: "task-1", title: "关联笔记", body: "原内容", at: NOW },
  ]));
  await assert.rejects(store.mutate(USER, request(1, "invalid-association-batch", [
    { type: "task.update", id: "task-1", projectId: "english", at: NOW },
    { type: "note.update", id: "note-1", body: "不应保留", projectId: "course", taskId: "task-1", at: NOW },
  ])), /同一项目/);
  assert.deepEqual(await store.read(USER), original);
  assert.equal(repository.writes, 1);
});

test("a concurrent task move conflicts with a stale note association and protects all project references", async () => {
  const { repository, store } = fixture();
  await store.mutate(USER, request(0, "create-association-fixture", [
    add(),
    { type: "note.add", id: "linked-note", projectId: "course", taskId: "task-1", title: "跟随任务", at: NOW },
    { type: "note.add", id: "unlinked-note", projectId: "course", title: "待关联", at: NOW },
  ]));
  repository.reads.length = 0;
  const association = request(1, "associate-stale-note", [{ type: "note.update", id: "unlinked-note", taskId: "task-1", at: NOW }]);
  const results = await Promise.allSettled([
    store.mutate(USER, request(1, "move-task-first", [{ type: "task.update", id: "task-1", projectId: "english", at: NOW }])),
    store.mutate(USER, association),
  ]);
  assert.deepEqual(repository.reads.slice(0, 2).map(entry => entry.revision), [1, 1]);
  assert.equal(results[0].status, "fulfilled");
  assert.ok(results[1].status === "rejected" && results[1].reason instanceof WorkspaceConflict);
  const saved = await store.read(USER);
  assert.equal(saved.state.tasks[0].projectId, "english");
  assert.equal(saved.state.notes?.[0].projectId, "english");
  assert.equal(saved.state.notes?.[0].taskId, "task-1");
  assert.equal(saved.state.notes?.[1].projectId, "course");
  assert.equal(Object.hasOwn(saved.state.notes![1], "taskId"), false);
  assert.deepEqual(results[1].reason.snapshot, saved);
  await assert.rejects(store.mutate(USER, association), WorkspaceConflict);
  await assert.rejects(store.mutate(USER, request(2, "associate-wrong-project", [{ type: "note.update", id: "unlinked-note", taskId: "task-1", at: NOW }])), /同一项目/);
  assert.equal(repository.writes, 2);
  const attached = await store.mutate(USER, request(2, "associate-final-project", [{ type: "note.update", id: "unlinked-note", taskId: "task-1", projectId: "english", at: NOW }]));
  assert.equal(attached.state.notes?.[1].taskId, "task-1");
  assert.equal(attached.state.notes?.[1].projectId, "english");
  assert.equal(repository.writes, 3);
});

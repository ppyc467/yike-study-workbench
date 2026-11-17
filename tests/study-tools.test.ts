import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import type { Command } from "../lib/study";
import type { WorkspaceRepository, WorkspaceRow, WorkspaceValues } from "../lib/workspace-store";

const study = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
function loadModule<T>(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} as T };
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, TextEncoder, JSON, crypto: webcrypto,
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return loaded.exports;
}
const storeModule = loadModule<typeof import("../lib/workspace-store")>("../lib/workspace-store.ts", { "./study": study });
const statistics = loadModule<typeof import("../lib/statistics")>("../lib/statistics.ts", { "./study": study });
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-24T00:10:00+08:00");
const USER = "tool-user-one";

class MemoryRepository implements WorkspaceRepository {
  rows = new Map<string, WorkspaceRow>();
  reads = 0;
  writes = 0;
  async read(userId: string) {
    this.reads++;
    const row = this.rows.get(userId);
    return row ? structuredClone(row) : undefined;
  }
  async insert(userId: string, values: WorkspaceValues) {
    if (this.rows.has(userId)) return undefined;
    const row = { userId, ...structuredClone(values) };
    this.rows.set(userId, row);
    this.writes++;
    return structuredClone(row);
  }
  async update(userId: string, revision: number, values: WorkspaceValues) {
    if (this.rows.get(userId)?.revision !== revision) return undefined;
    const row = { userId, ...structuredClone(values) };
    this.rows.set(userId, row);
    this.writes++;
    return structuredClone(row);
  }
}

function fixture() {
  let now = NOW;
  const repository = new MemoryRepository();
  const store = storeModule.createWorkspaceStore({ repository, now: () => now, storage: "local" });
  const tools = loadModule<typeof import("../lib/study-tools")>("../lib/study-tools.ts", {
    "./study": study, "./statistics": statistics, "./workspace-store": storeModule,
  }, { Date: class extends Date { static now() { return now; } } });
  async function call(name: string, args: unknown = {}, userId = USER) {
    const response = await tools.callStudyTool(name, args, userId, store);
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, "text");
    return { response, data: JSON.parse(response.content[0].text) };
  }
  async function succeed(name: string, args: unknown = {}, userId = USER) {
    const { response, data } = await call(name, args, userId);
    assert.notEqual(response.isError, true, JSON.stringify(data));
    return data;
  }
  async function seed(commands: Command[], userId = USER) {
    return store.mutate(userId, { baseRevision: 0, mutationId: `seed_${userId}`, commands });
  }
  return { repository, store, tools, call, succeed, seed, advance: (ms: number) => { now += ms; } };
}
function add(id: string, title = id, projectId = "course", at = NOW): Command {
  return { type: "task.add", id, title, projectId, at };
}
function createArgs(overrides: Record<string, unknown> = {}) {
  return { expectedRevision: 0, operationId: "create-operation", projectId: "course", title: "完成课程练习", ...overrides };
}

test("six tool schemas expose only scoped capabilities and mark writes accurately", () => {
  const { tools } = fixture();
  const names = tools.STUDY_TOOLS.map((tool) => tool.name);
  assert.equal(names.length, 6);
  assert.equal(new Set(names).size, 6);
  for (const definition of tools.STUDY_TOOLS) {
    const write = ["create_study_task", "update_study_task"].includes(definition.name);
    assert.equal(definition.inputSchema.type, "object");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.annotations.readOnlyHint, !write);
    assert.equal(definition.annotations.openWorldHint, false);
    assert.equal(definition.annotations.destructiveHint, definition.name === "update_study_task");
    for (const forbidden of ["userId", "commands", "at", "sessionId", "minutes"]) {
      assert.equal(Object.hasOwn(definition.inputSchema.properties, forbidden), false);
    }
    for (const required of definition.inputSchema.required) assert.ok(Object.hasOwn(definition.inputSchema.properties, required));
  }
});

test("runtime validation rejects unknown identity/time/commands and malformed inputs before storage access", async () => {
  const f = fixture();
  const examples: Record<string, Record<string, unknown>> = {
    list_study_projects: {}, list_study_tasks: {}, get_study_task: { taskId: "task-1" },
    create_study_task: createArgs(),
    update_study_task: { expectedRevision: 1, operationId: "edit-operation", taskId: "task-1", title: "新名称" },
    get_study_statistics: {},
  };
  for (const [name, args] of Object.entries(examples)) {
    for (const extra of [{ userId: "another-user" }, { at: NOW }, { commands: [] }]) {
      const result = await f.call(name, { ...args, ...extra });
      assert.equal(result.response.isError, true);
      assert.equal(result.data.code, "INVALID_OPERATION");
    }
  }
  const invalid: [string, unknown][] = [
    ["list_study_projects", null], ["list_study_projects", []], ["list_study_tasks", "all"],
    ["missing_tool", {}], ["get_study_task", {}], ["get_study_task", { taskId: "bad/id" }],
    ["list_study_tasks", { limit: 0 }], ["list_study_tasks", { limit: 101 }], ["list_study_tasks", { offset: 5001 }],
    ["list_study_tasks", { archived: true }], ["list_study_tasks", { status: "deleted" }],
    ["get_study_statistics", { rangeDays: 14 }], ["create_study_task", createArgs({ expectedRevision: 1.5 })],
    ["create_study_task", createArgs({ operationId: "" })], ["create_study_task", createArgs({ title: "   " })],
    ["create_study_task", createArgs({ notes: "x".repeat(20_001) })],
    ["update_study_task", { expectedRevision: 1, operationId: "empty-edit", taskId: "task-1" }],
    ["update_study_task", { expectedRevision: 1, operationId: "invalid-edit", taskId: "task-1", pinned: "true" }],
  ];
  for (const [name, args] of invalid) {
    const result = await f.call(name, args);
    assert.equal(result.response.isError, true, name);
    assert.equal(result.data.code, "INVALID_OPERATION");
  }
  for (const userId of ["", "   "]) {
    const result = await f.call("list_study_projects", {}, userId);
    assert.equal(result.response.isError, true);
    assert.equal(result.data.code, "INVALID_OPERATION");
  }
  assert.equal(f.repository.reads, 0);
  assert.equal(f.repository.writes, 0);
});

test("task search paginates, filters archive/status/project, searches notes and keeps full notes in details", async () => {
  const f = fixture();
  const longNotes = "AutoSave 边界笔记" + "学".repeat(19_980);
  await f.seed([
    add("old", "旧任务", "course", NOW - 4000),
    add("pinned", "置顶任务", "course", NOW - 3000),
    { type: "task.update", id: "pinned", pinned: true, status: "doing", at: NOW },
    add("archived", "归档任务", "course", NOW - 2000),
    { type: "task.update", id: "archived", archived: true, status: "done", at: NOW },
    add("english", "英语复习", "english", NOW - 1000),
    add("newest", "最新任务", "course", NOW),
    { type: "task.update", id: "newest", notes: longNotes, at: NOW },
  ]);
  const projects = await f.succeed("list_study_projects");
  assert.equal(projects.revision, 1);
  assert.equal(projects.timeZone, "Asia/Shanghai");
  assert.equal(projects.serverNow, NOW);
  assert.equal(projects.projects.find((project: { id: string }) => project.id === "course").taskCount, 3);
  const first = await f.succeed("list_study_tasks", { limit: 2 });
  assert.deepEqual(first.tasks.map((task: { id: string }) => task.id), ["pinned", "newest"]);
  assert.equal(first.total, 4);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.tasks.some((task: object) => Object.hasOwn(task, "notes")), false);
  const second = await f.succeed("list_study_tasks", { limit: 2, offset: first.nextOffset });
  assert.deepEqual(second.tasks.map((task: { id: string }) => task.id), ["english", "old"]);
  assert.equal(second.nextOffset, null);
  assert.deepEqual((await f.succeed("list_study_tasks", { query: "  AUTOSAVE  " })).tasks.map((task: { id: string }) => task.id), ["newest"]);
  assert.equal((await f.succeed("list_study_tasks", { archived: "all" })).total, 5);
  assert.deepEqual((await f.succeed("list_study_tasks", { archived: "archived", status: "done" })).tasks.map((task: { id: string }) => task.id), ["archived"]);
  assert.deepEqual((await f.succeed("list_study_tasks", { projectId: "english" })).tasks.map((task: { id: string }) => task.id), ["english"]);
  assert.deepEqual((await f.succeed("list_study_tasks", { status: "doing" })).tasks.map((task: { id: string }) => task.id), ["pinned"]);
  const detail = await f.succeed("get_study_task", { taskId: "newest" });
  assert.equal(detail.task.notes, longNotes);
  assert.equal(detail.task.projectTitle, "课程学习");
  assert.equal(detail.task.totalStudyMs, 0);
  assert.equal(detail.task.activeTimer, null);
  assert.equal(f.repository.writes, 1, "all tools in this test are read-only after seeding");
});

test("missing project or task returns a scoped error rather than an empty misleading result", async () => {
  const f = fixture();
  for (const [name, args] of [
    ["list_study_tasks", { projectId: "missing" }],
    ["get_study_statistics", { projectId: "missing" }],
    ["get_study_task", { taskId: "missing" }],
  ] as const) {
    const result = await f.call(name, args);
    assert.equal(result.response.isError, true);
    assert.equal(result.data.code, "INVALID_OPERATION");
  }
  assert.equal(f.repository.writes, 0);
});

test("create persists trimmed title and notes atomically with stable ID and server-owned metadata", async () => {
  const f = fixture();
  const notes = "从第三题继续\n保留空行";
  const args = createArgs({ title: "  完成第 2 章练习  ", notes });
  const created = await f.succeed("create_study_task", args);
  assert.equal(created.revision, 1);
  assert.equal(created.serverNow, NOW);
  assert.equal(created.timeZone, "Asia/Shanghai");
  assert.equal(created.operationId, args.operationId);
  assert.match(created.task.id, /^dot_[a-f0-9]{64}$/);
  assert.equal(created.task.title, "完成第 2 章练习");
  assert.equal(created.task.notes, notes);
  assert.equal(created.task.status, "todo");
  assert.equal(created.task.createdAt, NOW);
  assert.equal(created.task.archived, false);
  assert.equal(f.repository.writes, 1);
  const readBack = await f.succeed("get_study_task", { taskId: created.task.id });
  assert.deepEqual(readBack.task, created.task);
  const persisted = await f.store.read(USER);
  assert.equal(persisted.state.tasks.length, 1);
  assert.equal(persisted.state.tasks[0].notes, notes);
});

test("same request with reordered keys or a later server clock is acknowledged without duplicate work", async () => {
  const f = fixture();
  const args = createArgs({ notes: "网络重试需要保留" });
  const first = await f.succeed("create_study_task", args);
  f.advance(5 * MINUTE);
  const reordered = Object.fromEntries(Object.entries(args).reverse());
  const retried = await f.succeed("create_study_task", reordered);
  assert.equal(retried.serverNow, NOW + 5 * MINUTE);
  assert.equal(retried.revision, first.revision);
  assert.deepEqual(retried.task, first.task);
  assert.equal(f.repository.writes, 1);
  assert.equal((await f.store.read(USER)).state.tasks.length, 1);
});

test("reusing operationId with changed content cannot falsely acknowledge the old success", async () => {
  const f = fixture();
  const args = createArgs();
  const first = await f.succeed("create_study_task", args);
  const changed = await f.call("create_study_task", { ...args, title: "不同的任务" });
  assert.equal(changed.response.isError, true);
  assert.equal(changed.data.code, "REVISION_CONFLICT");
  assert.equal(changed.data.revision, 1);
  assert.equal((await f.store.read(USER)).state.tasks[0].title, first.task.title);
  const update = { expectedRevision: 1, operationId: "update-operation", taskId: first.task.id, notes: "第一次修改" };
  await f.succeed("update_study_task", update);
  const changedUpdate = await f.call("update_study_task", { ...update, notes: "不应悄悄保存" });
  assert.equal(changedUpdate.response.isError, true);
  assert.equal(changedUpdate.data.code, "REVISION_CONFLICT");
  assert.equal(changedUpdate.data.task.notes, "第一次修改");
  assert.equal(f.repository.writes, 2);
});

test("a delayed create retry after a browser edit conflicts without recreating or overwriting the task", async () => {
  const f = fixture();
  const args = createArgs();
  const first = await f.succeed("create_study_task", args);
  await f.store.mutate(USER, {
    baseRevision: 1, mutationId: "browser-edit", commands: [{ type: "task.update", id: first.task.id, title: "网页后来修改的名称", at: NOW }],
  });
  f.advance(MINUTE);
  const retry = await f.call("create_study_task", args);
  assert.equal(retry.response.isError, true);
  assert.equal(retry.data.code, "REVISION_CONFLICT");
  assert.equal(retry.data.revision, 2);
  const state = (await f.store.read(USER)).state;
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].title, "网页后来修改的名称");
  assert.equal(f.repository.writes, 2);
});

test("partial update changes only requested fields while immediate retry preserves revision and history", async () => {
  const f = fixture();
  await f.seed([
    add("task-1", "原名称", "course", NOW - 3 * MINUTE),
    { type: "task.update", id: "task-1", notes: "已有完整笔记", pinned: true, at: NOW },
    { type: "session.start", id: "session-1", taskId: "task-1", mode: "free", targetMs: 0, at: NOW - 2 * MINUTE },
    { type: "session.finish", at: NOW - MINUTE },
  ]);
  const before = await f.store.read(USER);
  const args = { expectedRevision: 1, operationId: "rename-only", taskId: "task-1", title: "新名称" };
  const updated = await f.succeed("update_study_task", args);
  assert.equal(updated.revision, 2);
  assert.equal(updated.task.totalStudyMs, MINUTE);
  const after = await f.store.read(USER);
  assert.deepEqual(after.state.tasks[0], { ...before.state.tasks[0], title: "新名称" });
  assert.deepEqual(after.state.sessions, before.state.sessions);
  assert.deepEqual(after.state.projects, before.state.projects);
  assert.equal(after.state.goalMinutes, before.state.goalMinutes);
  f.advance(MINUTE);
  const retry = await f.succeed("update_study_task", Object.fromEntries(Object.entries(args).reverse()));
  assert.equal(retry.revision, 2);
  assert.deepEqual(retry.task, updated.task);
  assert.equal(f.repository.writes, 2);
});

test("archive and restore preserve completed study records and notes", async () => {
  const f = fixture();
  await f.seed([
    add("task-1", "已学任务", "course", NOW - 4 * MINUTE),
    { type: "task.update", id: "task-1", notes: "复习笔记", at: NOW },
    { type: "session.start", id: "session-1", taskId: "task-1", mode: "free", targetMs: 0, at: NOW - 3 * MINUTE },
    { type: "session.finish", at: NOW - MINUTE },
  ]);
  const history = (await f.store.read(USER)).state.sessions;
  const archived = await f.succeed("update_study_task", { expectedRevision: 1, operationId: "archive", taskId: "task-1", archived: true, status: "done" });
  assert.equal(archived.task.archived, true);
  assert.equal(archived.task.status, "done");
  assert.equal((await f.succeed("list_study_tasks")).total, 0);
  const restored = await f.succeed("update_study_task", { expectedRevision: 2, operationId: "restore", taskId: "task-1", archived: false });
  assert.equal(restored.task.archived, false);
  assert.equal(restored.task.notes, "复习笔记");
  assert.equal(restored.task.totalStudyMs, 2 * MINUTE);
  assert.deepEqual((await f.store.read(USER)).state.sessions, history);
  assert.equal((await f.succeed("list_study_tasks")).total, 1);
});

test("running and paused tasks cannot be completed or archived through tools", async () => {
  for (const paused of [false, true]) {
    const f = fixture();
    const commands: Command[] = [
      add("task-1", "正在学习", "course", NOW - 4 * MINUTE),
      { type: "session.start", id: "session-1", taskId: "task-1", mode: "free", targetMs: 0, at: NOW - 3 * MINUTE },
    ];
    if (paused) commands.push({ type: "session.pause", at: NOW - MINUTE });
    await f.seed(commands);
    const before = await f.store.read(USER);
    const detail = await f.succeed("get_study_task", { taskId: "task-1" });
    assert.deepEqual(detail.task.activeTimer, { mode: "free", paused });
    for (const fields of [{ status: "done" }, { archived: true }]) {
      const blocked = await f.call("update_study_task", { expectedRevision: 1, operationId: "blocked", taskId: "task-1", ...fields });
      assert.equal(blocked.response.isError, true);
      assert.equal(blocked.data.code, "INVALID_OPERATION");
      assert.match(blocked.data.message, /请先结束/);
      assert.deepEqual(await f.store.read(USER), before);
    }
    const notes = await f.succeed("update_study_task", { expectedRevision: 1, operationId: "live-notes", taskId: "task-1", notes: "仍能保存笔记" });
    assert.equal(notes.task.notes, "仍能保存笔记");
    assert.equal((await f.store.read(USER)).state.activeSessionId, "session-1");
  }
});

test("two users can use the same operation/task IDs without reading or modifying each other's data", async () => {
  const f = fixture();
  const args = createArgs({ notes: "用户一的笔记" });
  const first = await f.succeed("create_study_task", args);
  const otherUser = "tool-user-two";
  assert.equal((await f.succeed("list_study_tasks", {}, otherUser)).total, 0);
  const inaccessible = await f.call("get_study_task", { taskId: first.task.id }, otherUser);
  assert.equal(inaccessible.response.isError, true);
  const second = await f.succeed("create_study_task", { ...args, notes: "用户二的笔记" }, otherUser);
  assert.equal(second.task.id, first.task.id, "IDs may repeat across isolated user workspaces");
  await f.succeed("update_study_task", { expectedRevision: 1, operationId: "edit-own", taskId: second.task.id, title: "用户二的新名称" }, otherUser);
  const firstRead = await f.succeed("get_study_task", { taskId: first.task.id });
  const secondRead = await f.succeed("get_study_task", { taskId: second.task.id }, otherUser);
  assert.equal(firstRead.task.notes, "用户一的笔记");
  assert.equal(firstRead.task.title, args.title);
  assert.equal(firstRead.revision, 1);
  assert.equal(secondRead.task.notes, "用户二的笔记");
  assert.equal(secondRead.task.title, "用户二的新名称");
  assert.equal(secondRead.revision, 2);
  assert.equal(f.repository.rows.size, 2);
});

test("statistics use Beijing dates, include live elapsed time and state their duration unit", async () => {
  const f = fixture();
  const start = Date.parse("2026-10-23T23:50:00+08:00");
  await f.seed([
    add("night-task", "跨午夜学习", "english", start),
    { type: "session.start", id: "night-session", taskId: "night-task", mode: "free", targetMs: 0, at: start },
  ]);
  const summary = await f.succeed("get_study_statistics");
  assert.equal(summary.timeZone, "Asia/Shanghai");
  assert.equal(summary.durationUnit, "milliseconds");
  assert.equal(summary.serverNow, NOW);
  assert.equal(summary.startKey, "2026-10-18");
  assert.equal(summary.endKey, "2026-10-24");
  assert.equal(summary.rangeDays, 7);
  assert.equal(summary.totalMs, 20 * MINUTE);
  assert.equal(summary.todayMs, 10 * MINUTE);
  assert.equal(summary.days.find((day: { key: string }) => day.key === "2026-10-23").ms, 10 * MINUTE);
  assert.equal(summary.activeDays, 2);
  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.goalMinutes, 120);
  const month = await f.succeed("get_study_statistics", { rangeDays: 30, projectId: "english" });
  assert.equal(month.days.length, 30);
  assert.equal(month.totalMs, 20 * MINUTE);
  assert.equal(month.dailyAverageMs, 20 * MINUTE / 30);
  assert.equal((await f.succeed("get_study_statistics", { projectId: "course" })).totalMs, 0);
  assert.equal(f.repository.writes, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
import type { ChatClaim, TaskChatStore } from "../lib/task-chat";

const chat = await import(new URL("../lib/task-chat.ts", import.meta.url).href) as typeof import("../lib/task-chat");
const NOW = Date.parse("2026-11-11T14:00:00+08:00");
const compiled = ts.transpileModule(readFileSync(new URL("../db/task-chat.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Execute the production repository's SQL with an isolated, in-memory SQLite database. */
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0000_fearless_molly_hayes.sql", "0001_task_chat.sql"]) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
  }
  let timestamp = NOW;
  let tokenNumber = 0;

  class Statement {
    readonly query: string;
    readonly values: (string | number | null)[];
    constructor(query: string, values: (string | number | null)[] = []) {
      this.query = query;
      this.values = values;
    }
    bind(...values: (string | number | null)[]) { return new Statement(this.query, values); }
    execute() {
      const results = sqlite.prepare(this.query).all(...this.values);
      const changes = sqlite.prepare("SELECT changes() AS count").get() as { count: number };
      return { results, meta: { changes: changes.count }, success: true };
    }
    async first() { return this.execute().results[0] ?? null; }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
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

  const storeModule = { exports: {} as { taskChatStore: TaskChatStore } };
  const factory = (options: Parameters<typeof chat.createTaskChatStore>[0]) => chat.createTaskChatStore({
    ...options, now: () => timestamp, createToken: () => `lease-${++tokenNumber}`,
  });
  vm.runInNewContext(compiled, {
    module: storeModule, exports: storeModule.exports,
    require: (name: string) => {
      if (name === "cloudflare:workers") return { env: { DB: database } };
      assert.equal(name, "../lib/task-chat");
      return { ...chat, createTaskChatStore: factory };
    },
  });
  function workspace(userId = "user-a", tasks = ["task-a", "task-b"]) {
    const state = JSON.stringify({ tasks: tasks.map(id => ({ id })) });
    sqlite.prepare("INSERT INTO study_workspaces (user_id, state_json, updated_at) VALUES (?, ?, ?)")
      .run(userId, state, timestamp);
  }
  workspace();
  workspace("user-b");
  return {
    store: storeModule.exports.taskChatStore, sqlite, workspace,
    advance(milliseconds: number) { timestamp += milliseconds; },
  };
}

async function claim(store: TaskChatStore, operationId = "question-1", message = "什么是接口？", userId = "user-a", taskId = "task-a"): Promise<ChatClaim> {
  const result = await store.begin(userId, taskId, { operationId, message });
  assert.equal(result.status, "claimed");
  if (result.status !== "claimed") throw new Error("Expected a fresh claim");
  return result.claim;
}

test("old tasks open an empty conversation without writing storage", async () => {
  const { store, sqlite } = fixture();
  assert.deepEqual(await store.read("user-a", "task-a"), {
    messages: [], before: null, memory: "", memoryRevision: 0, pending: null,
  });
  assert.equal((sqlite.prepare("SELECT count(*) AS count FROM task_chat_conversations").get() as { count: number }).count, 0);
  sqlite.close();
});

test("answers and learning memories persist with user and task isolation", async () => {
  const { store, sqlite } = fixture();
  const first = await claim(store);
  const snapshot = await store.complete("user-a", "task-a", first, { reply: "接口描述一组方法。", memory: "正在学习 Java 接口。" });
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[0].content, "什么是接口？");
  assert.equal(snapshot.messages[1].content, "接口描述一组方法。");
  assert.equal(snapshot.messages[1].operationId, first.operationId);
  assert.equal(snapshot.memory, "正在学习 Java 接口。");
  assert.equal(snapshot.memoryRevision, 1);
  assert.equal(snapshot.pending, null);
  assert.deepEqual(await store.read("user-a", "task-a"), snapshot);
  assert.equal((await store.read("user-b", "task-a")).messages.length, 0);
  assert.equal((await store.read("user-a", "task-b")).messages.length, 0);
  const exported = await store.exportAll("user-a");
  assert.equal(exported.length, 1);
  assert.deepEqual(exported[0].messages, snapshot.messages);
  assert.deepEqual(await store.exportAll("user-b"), []);
  sqlite.close();
});

test("concurrent duplicate requests acquire one lease and retain the completed answer", async () => {
  const { store, sqlite } = fixture();
  const input = { operationId: "duplicate", message: "解释构造方法" };
  const results = await Promise.all([store.begin("user-a", "task-a", input), store.begin("user-a", "task-a", input)]);
  assert.deepEqual(results.map(result => result.status).sort(), ["claimed", "pending"]);
  const winner = results.find(result => result.status === "claimed");
  assert.ok(winner && winner.status === "claimed");
  await store.complete("user-a", "task-a", winner.claim, { reply: "构造方法用于初始化对象。" });
  const retry = await store.begin("user-a", "task-a", input);
  assert.equal(retry.status, "complete");
  assert.equal((await store.read("user-a", "task-a")).messages.length, 2);
  await assert.rejects(store.begin("user-a", "task-a", { ...input, message: "改过的问题" }), chat.ChatError);
  sqlite.close();
});

test("only one question runs at once in a task while another task can answer", async () => {
  const { store, sqlite } = fixture();
  await claim(store);
  await assert.rejects(store.begin("user-a", "task-a", { operationId: "other", message: "另一个问题" }), chat.ChatConflict);
  const otherTask = await store.begin("user-a", "task-b", { operationId: "other", message: "另一个任务的问题" });
  assert.equal(otherTask.status, "claimed");
  sqlite.close();
});

test("a failed question remains visible and retries reuse its original turn", async () => {
  const { store, sqlite } = fixture();
  const first = await claim(store);
  const failed = await store.fail("user-a", "task-a", first);
  assert.equal(failed.messages[0].status, "failed");
  assert.equal(failed.pending, null);
  const retry = await claim(store);
  assert.notEqual(retry.token, first.token);
  await store.complete("user-a", "task-a", retry, { reply: "这次回答成功。" });
  const result = await store.read("user-a", "task-a");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].status, undefined);
  sqlite.close();
});

test("expired generation can be retried and its late answer cannot overwrite the retry", async () => {
  const { store, sqlite, advance } = fixture();
  const first = await claim(store);
  advance(chat.CHAT_LEASE_MS + 1);
  const expired = await store.read("user-a", "task-a");
  assert.equal(expired.pending, null);
  assert.equal(expired.messages[0].status, "failed");
  const retry = await claim(store);
  await assert.rejects(store.complete("user-a", "task-a", first, { reply: "迟到的旧回答" }), chat.ChatConflict);
  await store.fail("user-a", "task-a", first);
  assert.equal((await store.read("user-a", "task-a")).pending?.operationId, retry.operationId);
  await store.complete("user-a", "task-a", retry, { reply: "新的回答" });
  assert.equal((await store.read("user-a", "task-a")).messages[1].content, "新的回答");
  sqlite.close();
});

test("memory compare-and-swap preserves user edits made during generation", async () => {
  const { store, sqlite } = fixture();
  const first = await claim(store);
  const edited = await store.updateMemory("user-a", "task-a", { memory: "我已经理解接口，请从多态开始。", baseRevision: 0 });
  assert.equal(edited.memoryRevision, 1);
  await assert.rejects(store.updateMemory("user-a", "task-a", { memory: "另一设备旧版本", baseRevision: 0 }), chat.ChatConflict);
  const completed = await store.complete("user-a", "task-a", first, { reply: "下面讲多态。", memory: "模型生成的过期记忆" });
  assert.equal(completed.memory, edited.memory);
  assert.equal(completed.memoryRevision, 1);
  assert.equal(completed.messages.length, 2);
  sqlite.close();
});

test("history pagination retains complete turns in server order even with identical timestamps", async () => {
  const { store, sqlite } = fixture();
  for (let index = 1; index <= 6; index++) {
    const current = await claim(store, `question-${index}`, `问题${index}`);
    await store.complete("user-a", "task-a", current, { reply: `回答${index}` });
  }
  const latest = await store.read("user-a", "task-a", { limit: 2 });
  assert.deepEqual(latest.messages.map(message => message.content), ["问题5", "回答5", "问题6", "回答6"]);
  assert.ok(latest.before);
  const middle = await store.read("user-a", "task-a", { limit: 2, before: latest.before });
  assert.deepEqual(middle.messages.map(message => message.content), ["问题3", "回答3", "问题4", "回答4"]);
  assert.ok(middle.before);
  const oldest = await store.read("user-a", "task-a", { limit: 2, before: middle.before });
  assert.deepEqual(oldest.messages.map(message => message.content), ["问题1", "回答1", "问题2", "回答2"]);
  assert.equal(oldest.before, null);
  sqlite.close();
});

test("old retries and replayed completions include their turn without skipping unloaded pages", async () => {
  const { store, sqlite } = fixture();
  const original = await claim(store, "old-question", "很早的问题");
  await store.fail("user-a", "task-a", original);
  for (let index = 1; index <= 30; index++) {
    const current = await claim(store, `later-${index}`, `后续问题${index}`);
    await store.complete("user-a", "task-a", current, { reply: `后续回答${index}` });
  }
  const latest = await store.read("user-a", "task-a");
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.messages.some(message => message.operationId === "old-question"), false);
  assert.ok(latest.before);

  const firstRetry = await claim(store, "old-question", "很早的问题");
  const pending = await store.read("user-a", "task-a");
  assert.equal(pending.messages.find(message => message.operationId === "old-question")?.status, "pending");
  assert.equal(pending.before, latest.before);
  const failed = await store.fail("user-a", "task-a", firstRetry);
  assert.equal(failed.messages.find(message => message.operationId === "old-question")?.status, "failed");
  assert.equal(failed.before, latest.before);

  const secondRetry = await claim(store, "old-question", "很早的问题");
  const completed = await store.complete("user-a", "task-a", secondRetry, { reply: "很早的问题现在回答成功" });
  assert.equal(completed.messages.length, 52);
  assert.equal(completed.messages.find(message => message.id === "old-question:assistant")?.content, "很早的问题现在回答成功");
  assert.equal(completed.before, latest.before);

  const replayed = await store.begin("user-a", "task-a", { operationId: "old-question", message: "很早的问题" });
  assert.equal(replayed.status, "complete");
  if (replayed.status === "complete") {
    assert.equal(replayed.snapshot.messages.find(message => message.id === "old-question:assistant")?.content, "很早的问题现在回答成功");
    assert.equal(replayed.snapshot.before, latest.before);
  }
  const staleCompletion = await store.complete("user-a", "task-a", original, { reply: "迟到的最早回答" });
  assert.equal(staleCompletion.messages.find(message => message.id === "old-question:assistant")?.content, "很早的问题现在回答成功");
  const older = await store.read("user-a", "task-a", { before: latest.before });
  assert.deepEqual(older.messages.filter(message => message.role === "user").map(message => message.content), ["很早的问题", "后续问题1", "后续问题2", "后续问题3", "后续问题4", "后续问题5"]);
  sqlite.close();
});

test("an expired turn cannot cancel or replace another operation's new lease", async () => {
  const { store, sqlite, advance } = fixture();
  const first = await claim(store);
  advance(chat.CHAT_LEASE_MS + 1);
  const next = await claim(store, "next-question", "新的问题");
  await store.fail("user-a", "task-a", first);
  assert.equal((await store.read("user-a", "task-a")).pending?.operationId, "next-question");
  await assert.rejects(store.complete("user-a", "task-a", first, { reply: "旧操作的迟到回答" }), chat.ChatConflict);
  const snapshot = await store.complete("user-a", "task-a", next, { reply: "新操作正常回答" });
  assert.equal(snapshot.messages.find(message => message.id === "question-1:user")?.status, "failed");
  assert.equal(snapshot.messages.find(message => message.id === "next-question:assistant")?.content, "新操作正常回答");
  sqlite.close();
});

test("task rename and project moves preserve chat while every workspace deletion path clears it atomically", async () => {
  const { store, sqlite } = fixture();
  const first = await claim(store);
  sqlite.prepare("UPDATE study_workspaces SET state_json = ? WHERE user_id = ?")
    .run(JSON.stringify({ tasks: [{ id: "task-a", title: "新标题", projectId: "other" }, { id: "task-b" }] }), "user-a");
  assert.equal((await store.read("user-a", "task-a")).messages.length, 1);
  sqlite.prepare("UPDATE study_workspaces SET state_json = ? WHERE user_id = ?")
    .run(JSON.stringify({ tasks: [{ id: "task-b" }] }), "user-a");
  assert.equal((await store.read("user-a", "task-a")).messages.length, 0);
  await assert.rejects(store.complete("user-a", "task-a", first, { reply: "删除后的迟到回答" }), chat.ChatConflict);
  await assert.rejects(store.begin("user-a", "task-a", { operationId: "after-delete", message: "已删除的任务" }), (error: unknown) => error instanceof chat.ChatError && error.status === 404);
  assert.deepEqual(await store.exportAll("user-a"), []);
  const otherTask = await claim(store, "task-b-question", "问题", "user-a", "task-b");
  await store.complete("user-a", "task-b", otherTask, { reply: "回答" });
  sqlite.prepare("DELETE FROM study_workspaces WHERE user_id = ?").run("user-a");
  assert.deepEqual(await store.exportAll("user-a"), []);
  sqlite.close();
});

test("validates operation ids, message and memory limits, identities and page cursors", async () => {
  const { store, sqlite } = fixture();
  await assert.rejects(store.read("", "task-a"), chat.ChatError);
  await assert.rejects(store.read("user-a", "task-a", { before: "-1" }), chat.ChatError);
  await assert.rejects(store.read("user-a", "task-a", { limit: 51 }), chat.ChatError);
  await assert.rejects(store.begin("user-a", "task-a", { operationId: "invalid/id", message: "问题" }), chat.ChatError);
  await assert.rejects(store.begin("user-a", "task-a", { operationId: "valid", message: " " }), chat.ChatError);
  await assert.rejects(store.begin("user-a", "task-a", { operationId: "valid", message: "长".repeat(chat.MAX_CHAT_MESSAGE_LENGTH + 1) }), chat.ChatError);
  await assert.rejects(store.updateMemory("user-a", "task-a", { memory: "长".repeat(chat.MAX_CHAT_MEMORY_LENGTH + 1), baseRevision: 0 }), chat.ChatError);
  await assert.rejects(store.updateMemory("user-a", "missing-task", { memory: "记忆", baseRevision: 0 }), (error: unknown) => error instanceof chat.ChatError && error.status === 404);
  sqlite.close();
});

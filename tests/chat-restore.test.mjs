import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
import * as chat from "../lib/task-chat.ts";

const ORIGIN = "https://study.example";
const NOW = Date.parse("2026-11-11T16:00:00+08:00");
const PRIVATE_ERROR = "private-database-detail-never-return";
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const inputModule = { exports: {} };
vm.runInNewContext(compile("../lib/chat-request.ts"), {
  module: inputModule, exports: inputModule.exports, URL, TextDecoder, Uint8Array,
  require: () => chat,
});
const routeSource = compile("../app/api/chat-backup/restore/route.ts");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0000_fearless_molly_hayes.sql", "0001_task_chat.sql", "0002_workspace_records.sql"]) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
  }
  let userId = "user-a";
  let failAfterTurnWrites;
  let turnWrites = 0;
  let beforeBatch;
  const batches = [];
  class Statement {
    constructor(query, values = []) { this.query = query; this.values = values; }
    bind(...values) { return new Statement(this.query, values); }
    execute() {
      if (this.query.trimStart().startsWith("INSERT INTO task_chat_turns")) {
        if (failAfterTurnWrites !== undefined && turnWrites >= failAfterTurnWrites) throw new Error(PRIVATE_ERROR);
        turnWrites++;
      }
      const results = sqlite.prepare(this.query).all(...this.values);
      const { count } = sqlite.prepare("SELECT changes() AS count").get();
      return { results, meta: { changes: count }, success: true };
    }
  }
  const database = {
    prepare(query) { return new Statement(query); },
    async batch(statements) {
      batches.push(statements);
      const callback = beforeBatch;
      beforeBatch = undefined;
      callback?.();
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
  const environment = { DB: database };
  const module = { exports: {} };
  vm.runInNewContext(routeSource, {
    module, exports: module.exports, Response, Date: { now: () => NOW },
    require: name => {
      if (name === "cloudflare:workers") return { env: environment };
      if (name.endsWith("chatgpt-auth")) return { getChatGPTUser: async () => userId ? { userId } : null };
      if (name.endsWith("chat-request")) return inputModule.exports;
      assert.ok(name.endsWith("task-chat"));
      return chat;
    },
  });
  function workspace(identity = "user-a", ids = ["task-a"], normalized = false) {
    const state = { tasks: ids.map(id => ({ id })) };
    if (normalized) Object.assign(state, { _recordStorageVersion: 1, _recordCollections: ["tasks"] });
    sqlite.prepare("INSERT INTO study_workspaces (user_id, state_json, updated_at) VALUES (?, ?, ?)")
      .run(identity, JSON.stringify(state), NOW);
  }
  workspace();
  workspace("user-b", ["task-a", "private-b"], true);
  function conversation(identity = "user-a", taskId = "task-a", leaseUntil = 0, memory = "原有学习记忆") {
    sqlite.prepare(`INSERT INTO task_chat_conversations
      (user_id, task_id, memory, memory_revision, active_operation_id, lease_token, lease_until, updated_at)
      VALUES (?, ?, ?, 7, ?, ?, ?, ?)`)
      .run(identity, taskId, memory, leaseUntil ? "active" : null, leaseUntil ? "active-token" : null, leaseUntil, NOW);
  }
  function turn(data, identity = "user-a", taskId = "task-a") {
    sqlite.prepare(`INSERT INTO task_chat_turns
      (user_id, task_id, operation_id, message, reply, status, lease_token, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, 'existing-token', ?, ?)`)
      .run(identity, taskId, data.operationId, data.message, data.reply,
        data.reply === null ? "failed" : "complete", data.createdAt, data.finishedAt);
  }
  return {
    sqlite, batches, environment, workspace, conversation, turn,
    setUser(identity) { userId = identity; },
    failAfterTurnWrites(count) { turnWrites = 0; failAfterTurnWrites = count; },
    beforeBatch(callback) { beforeBatch = callback; },
    count(table, identity = "user-a") {
      return sqlite.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = ?`).get(identity).count;
    },
    send(data = backup(), headers = {}) {
      return module.exports.POST(new Request(`${ORIGIN}/api/chat-backup/restore`, {
        method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
        body: typeof data === "string" ? data : JSON.stringify(data),
      }));
    },
  };
}

function turn(operationId = "restored_0", changes = {}) {
  return { operationId, message: "如何理解接口？", reply: "接口定义对象可以提供的操作。", createdAt: NOW - 20_000, finishedAt: NOW - 19_000, ...changes };
}

function backup(changes = {}) {
  return { taskId: "task-a", memory: "正在学习 Java 接口", turns: [turn()], ...changes };
}

test("restore requires authenticated identity and validates browser request provenance before storage", async () => {
  const f = fixture();
  f.setUser(null);
  assert.equal((await f.send()).status, 401);
  f.setUser("user-a");
  assert.equal((await f.send(backup(), { origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.send(backup(), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await f.send(backup(), { "content-type": "text/plain" })).status, 415);
  assert.equal(f.batches.length, 0);
  assert.equal(f.count("task_chat_conversations"), 0);
  f.sqlite.close();
});

test("restores memory and complete or failed historical turns only into the authenticated account", async () => {
  const f = fixture();
  const response = await f.send(backup({ turns: [turn(), turn("restored_1", { reply: null })] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { restored: true });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const conversation = f.sqlite.prepare("SELECT * FROM task_chat_conversations WHERE user_id = ?").get("user-a");
  assert.equal(conversation.memory, "正在学习 Java 接口");
  assert.equal(conversation.memory_revision, 0);
  assert.equal(conversation.active_operation_id, null);
  const rows = f.sqlite.prepare("SELECT operation_id, status, reply FROM task_chat_turns WHERE user_id = ? ORDER BY id").all("user-a");
  assert.deepEqual(rows.map(row => [row.operation_id, row.status, row.reply]), [
    ["restored_0", "complete", "接口定义对象可以提供的操作。"], ["restored_1", "failed", null],
  ]);
  assert.equal(f.count("task_chat_turns", "user-b"), 0);
  assert.equal(f.count("task_chat_conversations", "user-b"), 0);
  f.sqlite.close();
});

test("body identity injection and another account's private task cannot cross account boundaries", async () => {
  const f = fixture();
  assert.equal((await f.send(backup({ userId: "user-b" }))).status, 422);
  assert.equal((await f.send(backup({ taskId: "private-b" }))).status, 409);
  assert.equal(f.count("task_chat_turns"), 0);
  assert.equal(f.count("task_chat_turns", "user-b"), 0);
  f.setUser("user-b");
  assert.equal((await f.send(backup({ taskId: "private-b" }))).status, 200);
  assert.equal(f.count("task_chat_turns", "user-b"), 1);
  assert.equal(f.count("task_chat_turns"), 0);
  f.sqlite.close();
});

test("identical retries, including concurrent copies, add each turn once and retain existing memory edits", async () => {
  const f = fixture();
  const responses = await Promise.all([f.send(), f.send()]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(f.count("task_chat_turns"), 1);
  assert.equal(f.count("task_chat_conversations"), 1);
  f.sqlite.prepare("UPDATE task_chat_conversations SET memory = ?, memory_revision = 3 WHERE user_id = ?")
    .run("用户刚刚修改的记忆", "user-a");
  assert.equal((await f.send()).status, 200);
  const row = f.sqlite.prepare("SELECT memory, memory_revision FROM task_chat_conversations WHERE user_id = ?").get("user-a");
  assert.equal(row.memory, "用户刚刚修改的记忆");
  assert.equal(row.memory_revision, 3);
  assert.equal(f.count("task_chat_turns"), 1);
  f.sqlite.close();
});

test("deleted tasks and orphaned conversations cannot be revived by restore", async () => {
  const f = fixture();
  f.conversation();
  f.turn(turn());
  f.sqlite.prepare("UPDATE study_workspaces SET state_json = ? WHERE user_id = ?").run(JSON.stringify({ tasks: [] }), "user-a");
  assert.equal(f.count("task_chat_conversations"), 0);
  assert.equal(f.count("task_chat_turns"), 0);
  assert.equal((await f.send()).status, 409);
  assert.equal(f.count("task_chat_conversations"), 0);
  // A damaged historical orphan must not make a missing task look restored.
  f.conversation();
  assert.equal((await f.send()).status, 409);
  assert.equal(f.count("task_chat_turns"), 0);
  f.sqlite.close();
});

test("a task deleted just before the D1 transaction cannot receive any restored conversation", async () => {
  const f = fixture();
  f.beforeBatch(() => f.sqlite.prepare("UPDATE study_workspaces SET state_json = ? WHERE user_id = ?")
    .run(JSON.stringify({ tasks: [] }), "user-a"));
  assert.equal((await f.send()).status, 409);
  assert.equal(f.count("task_chat_conversations"), 0);
  assert.equal(f.count("task_chat_turns"), 0);
  f.sqlite.close();
});

test("an active generation rejects the whole batch without altering memory, lease or messages", async () => {
  const f = fixture();
  f.conversation("user-a", "task-a", NOW + 60_000);
  f.turn(turn("active", { message: "正在回答的问题", reply: null }));
  const original = f.sqlite.prepare("SELECT * FROM task_chat_conversations WHERE user_id = ?").get("user-a");
  const response = await f.send(backup({ turns: [turn("new-one"), turn("new-two")] }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /正在生成回答/);
  assert.equal(f.count("task_chat_turns"), 1);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM task_chat_conversations WHERE user_id = ?").get("user-a"), original);
  f.sqlite.close();
});

test("a generation acquired just before the transaction also blocks restore", async () => {
  const f = fixture();
  f.beforeBatch(() => f.conversation("user-a", "task-a", NOW + 60_000));
  assert.equal((await f.send()).status, 409);
  assert.equal(f.count("task_chat_turns"), 0);
  f.sqlite.close();
});

test("expired generation leases permit new historical turns while keeping the existing memory", async () => {
  const f = fixture();
  f.conversation("user-a", "task-a", NOW - 1, "已有记忆优先保留");
  assert.equal((await f.send()).status, 200);
  assert.equal(f.count("task_chat_turns"), 1);
  assert.equal(f.sqlite.prepare("SELECT memory FROM task_chat_conversations WHERE user_id = ?").get("user-a").memory, "已有记忆优先保留");
  f.sqlite.close();
});

test("an operation ID collision rejects every turn in the request without partial restoration", async () => {
  const f = fixture();
  f.conversation();
  f.turn(turn("collision"));
  const response = await f.send(backup({ turns: [turn("new-one"), turn("collision", { reply: "不同答案" })] }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /同一提问标识已有不同内容/);
  const rows = f.sqlite.prepare("SELECT operation_id, reply FROM task_chat_turns WHERE user_id = ?").all("user-a");
  assert.deepEqual(rows.map(row => [row.operation_id, row.reply]), [["collision", "接口定义对象可以提供的操作。"]]);
  f.sqlite.close();
});

test("a failure after an earlier turn insert rolls back the new conversation and every inserted turn", async () => {
  const f = fixture();
  f.failAfterTurnWrites(1);
  const response = await f.send(backup({ turns: [turn("one"), turn("two")] }));
  assert.equal(response.status, 503);
  const error = (await response.json()).error;
  assert.equal(error.includes(PRIVATE_ERROR), false);
  assert.match(error, /可以重试/);
  assert.equal(f.count("task_chat_conversations"), 0);
  assert.equal(f.count("task_chat_turns"), 0);
  f.sqlite.close();
});

test("memory-only backups restore once and cannot interrupt active generation", async () => {
  const f = fixture();
  assert.equal((await f.send(backup({ turns: [] }))).status, 200);
  assert.equal(f.count("task_chat_conversations"), 1);
  assert.equal(f.count("task_chat_turns"), 0);
  assert.equal((await f.send(backup({ turns: [], memory: "另一个记忆" }))).status, 200);
  assert.equal(f.sqlite.prepare("SELECT memory FROM task_chat_conversations WHERE user_id = ?").get("user-a").memory, "正在学习 Java 接口");
  f.sqlite.prepare("UPDATE task_chat_conversations SET lease_until = ? WHERE user_id = ?").run(NOW + 1, "user-a");
  assert.equal((await f.send(backup({ turns: [] }))).status, 409);
  f.sqlite.close();
});

test("malformed, duplicated and excessive backup messages are rejected before database access", async () => {
  const cases = [
    null, [], {}, backup({ taskId: "bad:id" }), backup({ memory: "x".repeat(12_001) }),
    backup({ turns: Array.from({ length: 21 }, (_, index) => turn(`turn-${index}`)) }),
    backup({ turns: [null] }), backup({ turns: [turn("duplicate"), turn("duplicate")] }),
    backup({ turns: [turn("bad-message", { message: " " })] }),
    backup({ turns: [turn("bad-message", { message: "x".repeat(20_001) })] }),
    backup({ turns: [turn("bad-reply", { reply: "x".repeat(100_001) })] }),
    backup({ turns: [turn("bad-start", { createdAt: -1 })] }),
    backup({ turns: [turn("bad-finish", { finishedAt: NOW - 30_000 })] }),
    backup({ turns: [turn("bad-future", { finishedAt: 8_000_000_000_001 })] }),
  ];
  for (const payload of cases) {
    const f = fixture();
    assert.equal((await f.send(payload)).status, 422, JSON.stringify(payload)?.slice(0, 120));
    assert.equal(f.batches.length, 0);
    f.sqlite.close();
  }
});

test("request size is bounded by actual UTF-8 bytes and database outages expose a retryable error", async () => {
  const f = fixture();
  assert.equal((await f.send("x", { "content-length": "850001" })).status, 413);
  assert.equal((await f.send(`{"memory":"${"学".repeat(285_000)}"}`)).status, 413);
  assert.equal(f.batches.length, 0);
  f.environment.DB = undefined;
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  f.sqlite.close();
});

test("a maximal valid escaped historical turn fits the bounded restore endpoint", async () => {
  const f = fixture();
  const payload = backup({
    memory: "\u0001".repeat(12_000),
    turns: [turn("maximum", { message: "\u0001".repeat(20_000), reply: "\u0001".repeat(100_000) })],
  });
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  assert.ok(bytes > 790_000 && bytes < 850_000);
  assert.equal((await f.send(payload)).status, 200);
  const row = f.sqlite.prepare("SELECT message, reply FROM task_chat_turns WHERE user_id = ?").get("user-a");
  assert.equal(row.message.length, 20_000);
  assert.equal(row.reply.length, 100_000);
  f.sqlite.close();
});

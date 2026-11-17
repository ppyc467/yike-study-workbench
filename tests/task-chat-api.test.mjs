import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as chat from "../lib/task-chat.ts";
import * as stream from "../lib/chat-stream.ts";

const ORIGIN = "https://study.example";
const PRIVATE_ERROR = "private-upstream-detail-never-return-this";
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modelSource = compile("../lib/task-chat-model.ts");
const routeSource = compile("../app/api/tasks/[taskId]/chat/route.ts");
const backupSource = compile("../app/api/chat-backup/route.ts");
const quizSource = compile("../app/api/tasks/[taskId]/quiz/route.ts");
const inputModule = { exports: {} };
vm.runInNewContext(compile("../lib/chat-request.ts"), {
  module: inputModule, exports: inputModule.exports, URL, TextDecoder, Uint8Array,
  require: () => chat,
});
const plain = value => JSON.parse(JSON.stringify(value));

const TASK = { id: "task-a", projectId: "course", title: "Java 接口", status: "todo", notes: "已经写过一个类", createdAt: 1 };
const CLAIM = {
  operationId: "question-a", token: "claim-a", message: "接口中的方法怎么调用？",
  memory: "希望按执行顺序讲解。", memoryRevision: 2,
  history: [
    { id: "older:user", role: "user", content: "什么是类", createdAt: 1 },
    { id: "older:assistant", role: "assistant", content: "类描述对象的结构", createdAt: 2 },
    { id: "failed:user", role: "user", content: "这个失败的问题不应发送", createdAt: 3, status: "failed" },
  ],
};

function completed(reply = "通过实现接口的对象调用。", memory = "正在学习 Java 接口调用。") {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ reply, memory }) }] }] };
}

function modelFixture(fetchHandler = async () => Response.json(completed())) {
  const calls = [];
  const timeouts = [];
  const module = { exports: {} };
  const signal = { mockAbortSignal: true };
  vm.runInNewContext(modelSource, {
    module, exports: module.exports, fetch: async () => { throw new Error("Unexpected live fetch"); },
    AbortSignal: { timeout: milliseconds => { timeouts.push(milliseconds); return signal; } },
    require: name => {
      if (name === "./chat-stream") return stream;
      assert.equal(name, "./task-chat"); return chat;
    },
  });
  const answer = (changes = {}) => module.exports.answerStudyQuestion({
    config: { apiKey: "mock-key-for-isolated-tests", model: "mock-study-model" },
    task: TASK, projectTitle: "Java 课程", claim: CLAIM,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchHandler(url, options); },
    ...changes,
  });
  const quiz = (changes = {}) => module.exports.generateStudyQuiz({
    config: { apiKey: "mock-key-for-isolated-tests", model: "mock-study-model" }, taskTitle: TASK.title, sourceText: TASK.notes,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchHandler(url, options); }, ...changes,
  });
  return { answer, quiz, calls, timeouts, signal };
}

test("model request uses Responses JSON schema with task context, isolated history and server credentials", async () => {
  const app = modelFixture();
  assert.deepEqual(plain(await app.answer()), { reply: "通过实现接口的对象调用。", memory: "正在学习 Java 接口调用。" });
  assert.equal(app.calls.length, 1);
  const { url, options } = app.calls[0];
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer mock-key-for-isolated-tests");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.equal(options.redirect, "manual");
  assert.equal(options.signal, app.signal);
  assert.deepEqual(app.timeouts, [90_000]);
  const body = JSON.parse(options.body);
  assert.equal(body.model, "mock-study-model");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.max_output_tokens, 12_000);
  assert.equal(typeof body.instructions, "string");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.required, ["reply", "memory"]);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(body.input[0].role, "user");
  const context = JSON.parse(body.input[0].content.slice(body.input[0].content.indexOf("{")).trim());
  assert.deepEqual(context, {
    taskTitle: TASK.title, projectTitle: "Java 课程", taskNotes: TASK.notes,
    taskNotesExcerpted: false, learningMemory: CLAIM.memory,
  });
  assert.deepEqual(body.input.slice(1), [
    { role: "user", content: "什么是类" },
    { role: "assistant", content: "类描述对象的结构" },
    { role: "user", content: CLAIM.message },
  ]);
  assert.equal(options.body.includes("claim-a"), false);
  assert.equal(options.body.includes("这个失败的问题不应发送"), false);
});

test("model bounds task notes and recent history and marks a truncated notes excerpt", async () => {
  const app = modelFixture();
  await app.answer({
    task: { ...TASK, notes: "课".repeat(120_001) },
    claim: { ...CLAIM, history: [
      { id: "huge", role: "user", content: "旧".repeat(100_001), createdAt: 1 },
      { id: "recent", role: "assistant", content: "最近的讲解", createdAt: 2 },
      { id: "pending", role: "user", content: "还在生成的问题", createdAt: 3, status: "pending" },
    ] },
  });
  const body = JSON.parse(app.calls[0].options.body);
  const context = JSON.parse(body.input[0].content.slice(body.input[0].content.indexOf("{")));
  assert.equal(context.taskNotes.length, 120_000);
  assert.equal(context.taskNotesExcerpted, true);
  assert.deepEqual(body.input.slice(1), [{ role: "assistant", content: "最近的讲解" }, { role: "user", content: CLAIM.message }]);
});

test("model includes the current task's linked study notes in its bounded context", async () => {
  const app = modelFixture();
  await app.answer({ relatedNotes: [{ title: "接口调用笔记", body: "先构造实现类对象" }] });
  const body = JSON.parse(app.calls[0].options.body);
  const context = JSON.parse(body.input[0].content.slice(body.input[0].content.indexOf("{")));
  assert.match(context.taskNotes, /已经写过一个类/);
  assert.match(context.taskNotes, /接口调用笔记\n先构造实现类对象/);
});

test("model parses split output text while ignoring reasoning and preserves refusal wording", async () => {
  const json = JSON.stringify({ reply: "一小步讲清楚", memory: "继续学习接口" });
  const split = modelFixture(async () => Response.json({ status: "completed", output: [
    { type: "reasoning", content: [{ type: "output_text", text: "internal reasoning placeholder" }] },
    { type: "message", content: [{ type: "output_text", text: json.slice(0, 9) }, { type: "output_text", text: json.slice(9) }] },
  ] }));
  assert.deepEqual(plain(await split.answer()), { reply: "一小步讲清楚", memory: "继续学习接口" });
  const refusal = modelFixture(async () => Response.json({ status: "completed", output: [
    { type: "message", content: [{ type: "refusal", refusal: "这个请求需要换一种方式处理。" }] },
  ] }));
  assert.deepEqual(plain(await refusal.answer()), { reply: "这个请求需要换一种方式处理。" });
});

test("model rejects incomplete, malformed and oversized output using safe business errors", async () => {
  const badBodies = [
    null,
    { status: "incomplete", output: [] },
    { status: "completed", output: [] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "invalid-json" }] }] },
    completed(" ", "记忆"),
    completed("答".repeat(100_001), "记忆"),
    { status: "completed", output: [null] },
    { status: "completed", output: [{ type: "message", content: [null] }] },
  ];
  for (const body of badBodies) {
    const app = modelFixture(async () => Response.json(body));
    await assert.rejects(app.answer(), error => error instanceof chat.ChatError && error.status === 502 && !error.message.includes(PRIVATE_ERROR));
  }
});

test("model maps quota, rate limit, auth, permissions and generic upstream failures without exposing details", async () => {
  const cases = [
    { status: 429, code: "insufficient_quota", expected: 503, text: /额度不足/ },
    { status: 429, code: "billing_hard_limit_reached", expected: 503, text: /额度不足/ },
    { status: 429, code: "rate_limit_exceeded", expected: 503, text: /请求较多/ },
    { status: 401, code: "invalid_api_key", expected: 503, text: /密钥已失效/ },
    { status: 403, code: "model_access_denied", expected: 503, text: /模型权限/ },
    { status: 404, code: "model_not_found", expected: 503, text: /模型权限/ },
    { status: 500, code: "internal_error", expected: 502, text: /暂时无法/ },
  ];
  for (const entry of cases) {
    const app = modelFixture(async () => Response.json({ error: { code: entry.code, message: PRIVATE_ERROR, apiKey: "mock-key-for-isolated-tests" } }, { status: entry.status }));
    await assert.rejects(app.answer(), error => {
      assert.ok(error instanceof chat.ChatError);
      assert.equal(error.status, entry.expected);
      assert.match(error.message, entry.text);
      assert.equal(error.message.includes(PRIVATE_ERROR), false);
      assert.equal(error.message.includes("mock-key-for-isolated-tests"), false);
      return true;
    });
  }
});

test("model timeout and invalid response bodies remain safe and an empty key makes no request", async () => {
  const timedOut = modelFixture(async () => { throw new DOMException(PRIVATE_ERROR, "TimeoutError"); });
  await assert.rejects(timedOut.answer(), error => error instanceof chat.ChatError && error.status === 502 && /超时或中断/.test(error.message) && !error.message.includes(PRIVATE_ERROR));
  const invalidBody = modelFixture(async () => ({ ok: true, status: 200, json: async () => { throw new Error(PRIVATE_ERROR); } }));
  await assert.rejects(invalidBody.answer(), error => error instanceof chat.ChatError && error.status === 502 && !error.message.includes(PRIVATE_ERROR));
  const missingKey = modelFixture();
  await assert.rejects(missingKey.answer({ config: { apiKey: " ", model: "mock-model" } }), error => error instanceof chat.ChatError && error.status === 503);
  assert.equal(missingKey.calls.length, 0);
});

test("valid answers survive an absent or oversized memory update", async () => {
  for (const memory of [undefined, null, "忆".repeat(chat.MAX_CHAT_MEMORY_LENGTH + 1)]) {
    const app = modelFixture(async () => Response.json(completed("有效回答", memory)));
    // completed's default argument produces normal memory for undefined.
    const result = await app.answer();
    if (memory === undefined) assert.equal(typeof result.memory, "string");
    else {
      assert.equal(result.reply, "有效回答");
      assert.equal(result.memory, undefined);
      assert.match(result.memoryWarning, /保留原记忆/);
    }
  }
  const absent = modelFixture(async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"reply":"有效回答"}' }] }] }));
  assert.match((await absent.answer()).memoryWarning, /保留原记忆/);
});

test("streaming JSON decoder handles reversed keys, escapes and fragmented unicode", () => {
  const reply = '引号 "、反斜线 \\、换行\n与😀';
  const json = JSON.stringify({ memory: "隐藏记忆", reply }).replace("引", "\\u5f15");
  const decode = stream.createReplyDecoder();
  assert.equal([...json].map(character => decode(character)).join(""), reply);
});

test("model emits reply deltas before completion and reports safe usage metrics", async () => {
  const encoder = new TextEncoder();
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
  const app = modelFixture(async () => response);
  const deltas = [];
  const metrics = [];
  let finished = false;
  const work = app.answer({ onDelta: text => deltas.push(text), onMetrics: value => metrics.push(value) }).then(value => { finished = true; return value; });
  const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
  const first = encoder.encode(event({ type: "response.output_text.delta", delta: '{"reply":"第一句' }));
  for (let index = 0; index < first.length; index++) controller.enqueue(first.slice(index, index + 1));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deltas, ["第一句"]);
  assert.equal(finished, false);
  controller.enqueue(encoder.encode(event({ type: "response.output_text.delta", delta: '，第二句","memory":"更新记忆"}' })));
  controller.enqueue(encoder.encode(event({ type: "response.completed", response: { ...completed("第一句，第二句", "更新记忆"), usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 50 } } } })));
  controller.close();
  assert.equal((await work).reply, "第一句，第二句");
  assert.equal(deltas.join(""), "第一句，第二句");
  assert.equal(JSON.parse(app.calls[0].options.body).stream, true);
  assert.equal(metrics[0].inputTokens, 100);
  assert.equal(metrics[0].cachedTokens, 50);
  assert.equal(typeof metrics[0].firstTextMs, "number");
  assert.equal(JSON.stringify(metrics).includes(TASK.notes), false);
});

test("explicit excerpts precede selected notes and unselected notes are excluded", async () => {
  const app = modelFixture();
  await app.answer({ relatedNotes: [{ id: "selected", title: "选中", body: "选择的材料" }, { id: "excluded", title: "排除", body: "不应发出" }], selectedNoteIds: ["selected"], excerpt: "重点段落" });
  const body = JSON.parse(app.calls[0].options.body);
  const context = JSON.parse(body.input[0].content.slice(body.input[0].content.indexOf("{")));
  assert.ok(context.taskNotes.startsWith("# 本次引用段落\n重点段落"));
  assert.ok(context.taskNotes.indexOf("重点段落") < context.taskNotes.indexOf("选择的材料"));
  assert.equal(context.taskNotes.includes("不应发出"), false);
});

test("quiz model validates bounded questions and handles invalid or refused output", async () => {
  const body = questions => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ questions }) }] }] });
  const app = modelFixture(async () => Response.json(body([{ question: " 什么是接口？ ", answer: " 方法契约。 " }])));
  assert.deepEqual(plain(await app.quiz()), [{ question: "什么是接口？", answer: "方法契约。" }]);
  assert.equal(JSON.parse(app.calls[0].options.body).store, false);
  for (const questions of [[], [{ question: "问", answer: "答".repeat(6001) }], Array.from({ length: 6 }, () => ({ question: "问", answer: "答" }))]) {
    const bad = modelFixture(async () => Response.json(body(questions)));
    await assert.rejects(bad.quiz(), error => error instanceof chat.ChatError);
  }
});

function snapshot(changes = {}) {
  return { messages: [], before: null, memory: "学习接口", memoryRevision: 2, pending: null, ...changes };
}

function routeFixture(changes = {}) {
  const calls = { auth: 0, workspace: [], read: [], begin: [], complete: [], fail: [], memory: [], answer: [], quiz: [], export: [] };
  const user = changes.user === undefined ? { userId: "user-a" } : changes.user;
  const environment = { OPENAI_API_KEY: "mock-server-key", OPENAI_MODEL: "mock-route-model", ...changes.environment };
  const state = changes.state ?? { tasks: [TASK], projects: [{ id: "course", title: "Java 课程" }] };
  const store = {
    read: async (...args) => { calls.read.push(args); return snapshot(); },
    begin: async (...args) => { calls.begin.push(args); return { status: "claimed", claim: CLAIM }; },
    complete: async (...args) => { calls.complete.push(args); return snapshot({ messages: [{ id: "saved-answer", role: "assistant", content: "保存后的回答", createdAt: 3, operationId: CLAIM.operationId }] }); },
    fail: async (...args) => { calls.fail.push(args); return snapshot({ messages: [{ id: "failed-question", role: "user", content: CLAIM.message, createdAt: 2, status: "failed", operationId: CLAIM.operationId }] }); },
    updateMemory: async (...args) => { calls.memory.push(args); return snapshot({ memory: args[2].memory, memoryRevision: 3 }); },
    exportAll: async (...args) => { calls.export.push(args); return [{ taskId: "task-a", memory: "导出的记忆", memoryRevision: 2, messages: [] }]; },
    ...changes.store,
  };
  const getChatGPTUser = async () => { calls.auth++; return user; };
  const model = {
    DEFAULT_STUDY_MODEL: "default-mock-model",
    answerStudyQuestion: async (...args) => { calls.answer.push(args); return changes.answer ? changes.answer(...args) : { reply: "模型回答", memory: "新记忆" }; },
    generateStudyQuiz: async (...args) => { calls.quiz.push(args); return [{ question: "接口是什么？", answer: "方法契约。" }]; },
  };
  const module = { exports: {} };
  const backupModule = { exports: {} };
  const sandbox = {
    Response, TextDecoder, TextEncoder, URL, Uint8Array, ReadableStream, setInterval, clearInterval,
    require: name => {
      if (name === "cloudflare:workers") return { env: environment, waitUntil: promise => { void promise; } };
      if (name.endsWith("chatgpt-auth")) return { getChatGPTUser };
      if (name.endsWith("db/workspace-store")) return { workspaceStore: { read: async userId => { calls.workspace.push(userId); if (changes.workspaceError) throw changes.workspaceError; return { state }; } } };
      if (name.endsWith("db/task-chat")) return { taskChatStore: store };
      if (name.endsWith("lib/task-chat")) return chat;
      if (name.endsWith("lib/task-chat-model")) return model;
      if (name.endsWith("lib/chat-request")) return inputModule.exports;
      throw new Error(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(routeSource, { ...sandbox, module, exports: module.exports });
  vm.runInNewContext(backupSource, { ...sandbox, module: backupModule, exports: backupModule.exports });
  const quizModule = { exports: {} };
  vm.runInNewContext(quizSource, { ...sandbox, module: quizModule, exports: quizModule.exports });
  const context = taskId => ({ params: Promise.resolve({ taskId }) });
  return {
    calls, environment,
    get: (taskId = "task-a", query = "", headers = {}) => module.exports.GET(new Request(`${ORIGIN}/api/tasks/${encodeURIComponent(taskId)}/chat${query}`, { headers }), context(taskId)),
    post: (request, taskId = "task-a") => module.exports.POST(request, context(taskId)),
    patch: (request, taskId = "task-a") => module.exports.PATCH(request, context(taskId)),
    backup: (headers) => backupModule.exports.GET(headers ? new Request(`${ORIGIN}/api/chat-backup`, { headers }) : undefined),
    quiz: (request, taskId = "task-a") => quizModule.exports.POST(request, context(taskId)),
  };
}

function request(body = { operationId: CLAIM.operationId, message: CLAIM.message }, options = {}) {
  const headers = { origin: ORIGIN, "content-type": "application/json", ...options.headers };
  return new Request(`${ORIGIN}/api/tasks/task-a/chat`, {
    method: options.method ?? "POST", headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("SSE chat forwards deltas, saves once and finishes with the persisted snapshot", async () => {
  const app = routeFixture({ answer: async input => {
    input.onDelta("渐进");
    await Promise.resolve();
    input.onDelta("回答");
    return { reply: "渐进回答", memoryWarning: "保留原记忆" };
  } });
  const response = await app.post(request(undefined, { headers: { accept: "text/event-stream" } }));
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  await stream.readServerEvents(response, event => events.push({ event: event.event, ...JSON.parse(event.data) }));
  assert.deepEqual(events.filter(event => event.event === "delta").map(event => event.text), ["渐进", "回答"]);
  assert.equal(events.at(-1).event, "complete");
  assert.equal(events.at(-1).messages[0].content, "保存后的回答");
  assert.equal(events.at(-1).memoryWarning, "保留原记忆");
  assert.equal(app.calls.complete.length, 1);
});

test("SSE failure returns a recoverable failed snapshot and hides provider details", async () => {
  const app = routeFixture({ answer: async input => { input.onDelta("部分"); throw new Error(PRIVATE_ERROR); } });
  const response = await app.post(request(undefined, { headers: { accept: "text/event-stream" } }));
  const events = [];
  await stream.readServerEvents(response, event => events.push({ event: event.event, ...JSON.parse(event.data) }));
  assert.equal(events.at(-1).event, "error");
  assert.equal(events.at(-1).messages[0].status, "failed");
  assert.equal(JSON.stringify(events).includes(PRIVATE_ERROR), false);
  assert.equal(app.calls.complete.length, 0);
  assert.equal(app.calls.fail.length, 1);
});

test("references are validated before acquiring a generation lease", async () => {
  const app = routeFixture();
  assert.equal((await app.post(request({ operationId: "ref-a", message: "问题", selectedNoteIds: ["other-users-note"] }))).status, 422);
  assert.equal((await app.post(request({ operationId: "ref-a", message: "问题", excerpt: "长".repeat(20_001) }))).status, 422);
  assert.equal(app.calls.begin.length, 0);
});

test("quiz route scopes notes to the task and rejects anonymous, foreign and invalid inputs", async () => {
  const state = { tasks: [TASK], projects: [], notes: [{ id: "note-a", taskId: TASK.id, title: "接口", body: "笔记材料" }, { id: "other", taskId: "task-b", title: "其他", body: "私有材料" }] };
  const app = routeFixture({ state });
  assert.equal((await app.quiz(request({ noteId: "note-a" }))).status, 200);
  assert.match(app.calls.quiz[0][0].sourceText, /笔记材料/);
  assert.equal((await app.quiz(request({ noteId: "other" }))).status, 404);
  assert.equal((await app.quiz(request({ sourceText: "选定段落" }))).status, 200);
  assert.equal((await app.quiz(request({ sourceText: " " }))).status, 422);
  assert.equal((await app.quiz(request({ userId: "spoofed" }))).status, 422);
  assert.equal((await app.quiz(request({ sourceText: "材料" }, { headers: { origin: "https://foreign.example" } }))).status, 403);
  assert.equal((await routeFixture({ user: null }).quiz(request({ sourceText: "材料" }))).status, 401);
  assert.equal((await app.quiz(request({ sourceText: "材料" }), "other-users-task")).status, 404);
  assert.equal(app.calls.begin.length, 0);
});

test("chat routes require authentication before accessing task or conversation records", async () => {
  const app = routeFixture({ user: null });
  for (const response of [await app.get(), await app.post(request()), await app.patch(request({}, { method: "PATCH" })), await app.backup()]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(app.calls.workspace.length, 0);
  assert.equal(app.calls.read.length, 0);
  assert.equal(app.calls.begin.length, 0);
  assert.equal(app.calls.export.length, 0);
});

test("chat and quiz identity hints refuse old-account tabs before reading current-account data", async () => {
  const app = routeFixture({ user: { userId: "new-account" } });
  const headers = { "X-Study-User-Key": "old-account" };
  for (const response of [
    await app.get("task-a", "", headers),
    await app.post(request(undefined, { headers })),
    await app.patch(request({ memory: "旧账号记忆", baseRevision: 0 }, { headers, method: "PATCH" })),
    await app.quiz(request({ sourceText: "旧账号材料" }, { headers })),
  ]) assert.equal(response.status, 401);
  assert.equal(app.calls.workspace.length, 0);
  assert.equal(app.calls.begin.length + app.calls.memory.length + app.calls.quiz.length, 0);
});

test("chat backups reject a stale account hint before reading the new account's conversations", async () => {
  const app = routeFixture({ user: { userId: "new-account" } });
  const stale = await app.backup({ "X-Study-User-Key": "old-account" });
  assert.equal(stale.status, 401);
  assert.equal(stale.headers.get("x-study-user"), "new-account");
  assert.equal(app.calls.export.length, 0);
  const current = await app.backup({ "X-Study-User-Key": "new-account" });
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("x-study-user"), "new-account");
  assert.equal((await app.backup()).status, 200);
});

test("task lookup is scoped to the authenticated user's workspace on every chat route", async () => {
  const app = routeFixture();
  assert.equal((await app.get("other-users-task")).status, 404);
  assert.equal((await app.post(request(), "other-users-task")).status, 404);
  assert.equal((await app.patch(request({}, { method: "PATCH" }), "other-users-task")).status, 404);
  assert.deepEqual(app.calls.workspace, ["user-a", "user-a", "user-a"]);
  assert.equal(app.calls.read.length + app.calls.begin.length + app.calls.memory.length, 0);
});

test("GET remains readable without model credentials and carries pagination and scoped identity", async () => {
  const app = routeFixture({ environment: { OPENAI_API_KEY: "", OPENAI_MODEL: " " } });
  const response = await app.get("task-a", "?before=42");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.providerConfigured, false);
  assert.equal(body.model, "default-mock-model");
  assert.equal(body.memory, "学习接口");
  assert.deepEqual(plain(app.calls.read), [["user-a", "task-a", { before: "42" }]]);
  assert.equal(JSON.stringify(body).includes("mock-server-key"), false);
});

test("POST and PATCH reject foreign or missing browser origins before mutating", async () => {
  const app = routeFixture();
  for (const headers of [{ origin: "https://foreign.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await app.post(request(undefined, { headers }))).status, 403);
    assert.equal((await app.patch(request({ memory: "改动", baseRevision: 2 }, { method: "PATCH", headers }))).status, 403);
  }
  const withoutOrigin = request();
  withoutOrigin.headers.delete("origin");
  assert.equal((await app.post(withoutOrigin)).status, 403);
  assert.equal(app.calls.begin.length + app.calls.memory.length, 0);
});

test("chat inputs require exact JSON media type and reject malformed, unknown and oversized streamed data", async () => {
  const app = routeFixture();
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/jsonp" }]) {
    assert.equal((await app.post(request(undefined, { headers }))).status, 415);
  }
  const invalid = ["{", "null", "[]", { operationId: "q", message: "问题", userId: "other-user" }, { operationId: "q", message: "问题", taskId: "other-task" }];
  for (const body of invalid) assert.equal((await app.post(request(body))).status, 422);
  const missingBody = new Request(`${ORIGIN}/api/tasks/task-a/chat`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" } });
  assert.equal((await app.post(missingBody)).status, 422);
  assert.equal((await app.post(request({ operationId: "big", message: "课".repeat(34_000) }))).status, 413);
  assert.equal(app.calls.begin.length, 0);
  const valid = await app.post(request(undefined, { headers: { "content-type": "Application/JSON; charset=utf-8" } }));
  assert.equal(valid.status, 200);
});

test("unconfigured POST returns 503 without creating a pending question or calling the model", async () => {
  const app = routeFixture({ environment: { OPENAI_API_KEY: " " } });
  const response = await app.post(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚待配置/);
  assert.equal(app.calls.begin.length + app.calls.answer.length, 0);
});

test("PATCH edits only chat memory with its own CAS revision and no model credentials", async () => {
  const app = routeFixture({ environment: { OPENAI_API_KEY: "" } });
  const response = await app.patch(request({ memory: "已经理解接口，接着学习多态。", baseRevision: 2 }, { method: "PATCH" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.memoryRevision, 3);
  assert.equal(body.providerConfigured, false);
  assert.deepEqual(plain(app.calls.memory), [["user-a", "task-a", { memory: "已经理解接口，接着学习多态。", baseRevision: 2 }]]);
  assert.equal(app.calls.answer.length + app.calls.begin.length, 0);
  const conflicted = routeFixture({ store: { updateMemory: async () => { throw new chat.ChatConflict("学习记忆已更新", snapshot({ memory: "远端新记忆", memoryRevision: 9 })); } } });
  const conflictResponse = await conflicted.patch(request({ memory: "旧草稿", baseRevision: 2 }, { method: "PATCH" }));
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).memory, "远端新记忆");
});

test("successful POST forwards the authenticated task context and saves the answer before replying", async () => {
  const app = routeFixture();
  const response = await app.post(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.messages[0].content, "保存后的回答");
  assert.equal(body.providerConfigured, true);
  assert.equal(body.model, "mock-route-model");
  assert.deepEqual(plain(app.calls.begin), [["user-a", "task-a", { operationId: CLAIM.operationId, message: CLAIM.message }]]);
  assert.equal(app.calls.answer[0][0].task, TASK);
  assert.equal(app.calls.answer[0][0].projectTitle, "Java 课程");
  assert.deepEqual(plain(app.calls.answer[0][0].config), { apiKey: "mock-server-key", model: "mock-route-model" });
  assert.deepEqual(plain(app.calls.complete), [["user-a", "task-a", CLAIM, { reply: "模型回答", memory: "新记忆" }]]);
  assert.equal(app.calls.fail.length, 0);
  assert.equal(JSON.stringify(body).includes("mock-server-key"), false);
});

test("POST includes only notes linked to its own task", async () => {
  const linked = { id: "note-a", taskId: TASK.id, title: "当前任务笔记", body: "相关内容" };
  const app = routeFixture({ state: {
    tasks: [TASK], projects: [{ id: "course", title: "Java 课程" }],
    notes: [linked, { id: "note-b", taskId: "task-b", title: "其他任务笔记", body: "其他内容" }, { id: "unlinked", title: "未关联笔记", body: "其他内容" }],
  } });
  assert.equal((await app.post(request())).status, 200);
  assert.deepEqual(plain(app.calls.answer[0][0].relatedNotes), [linked]);
});

test("duplicate pending and completed POSTs return stored snapshots without generating or saving again", async () => {
  for (const [status, httpStatus] of [["pending", 202], ["complete", 200]]) {
    const existing = snapshot({ pending: status === "pending" ? { operationId: CLAIM.operationId, startedAt: 3 } : null });
    const app = routeFixture({ store: { begin: async () => ({ status, snapshot: existing }) } });
    const response = await app.post(request());
    assert.equal(response.status, httpStatus);
    assert.deepEqual((await response.json()).pending, existing.pending);
    assert.equal(app.calls.answer.length + app.calls.complete.length + app.calls.fail.length, 0);
  }
});

test("provider and save failures retain a failed-question snapshot while hiding unexpected internals", async () => {
  const cases = [
    { answer: async () => { throw new chat.ChatError("OpenAI API 额度不足", 503); }, status: 503, expected: /额度不足/ },
    { answer: async () => { throw new Error(PRIVATE_ERROR); }, status: 503, expected: /回答保存未完成/ },
    { store: { complete: async () => { throw new Error(PRIVATE_ERROR); } }, status: 503, expected: /回答保存未完成/ },
  ];
  for (const entry of cases) {
    const app = routeFixture(entry);
    const response = await app.post(request());
    assert.equal(response.status, entry.status);
    const body = await response.json();
    assert.match(body.error, entry.expected);
    assert.equal(body.messages[0].status, "failed");
    assert.equal(body.messages[0].operationId, CLAIM.operationId);
    assert.equal(app.calls.fail.length, 1);
    assert.equal(JSON.stringify(body).includes(PRIVATE_ERROR), false);
  }
});

test("generation conflicts return the current snapshot without failing another owner's lease", async () => {
  const other = snapshot({ pending: { operationId: "newer-question", startedAt: 9 } });
  const app = routeFixture({ store: { complete: async () => { throw new chat.ChatConflict("当前回答的租约已改变", other); } } });
  const response = await app.post(request());
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).pending, other.pending);
  assert.equal(app.calls.fail.length, 0);
});

test("unexpected read and failure-saving errors are sanitized and backups use the authenticated user", async () => {
  const broken = routeFixture({ workspaceError: new Error(PRIVATE_ERROR) });
  const response = await broken.get();
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(PRIVATE_ERROR), false);
  const failureSaving = routeFixture({
    answer: async () => { throw new Error(PRIVATE_ERROR); },
    store: { fail: async () => { throw new Error(PRIVATE_ERROR); } },
  });
  const failedResponse = await failureSaving.post(request());
  assert.equal(failedResponse.status, 503);
  assert.equal((await failedResponse.text()).includes(PRIVATE_ERROR), false);
  const app = routeFixture();
  const backup = await app.backup();
  assert.equal(backup.status, 200);
  assert.equal(backup.headers.get("cache-control"), "private, no-store");
  assert.equal((await backup.json()).conversations[0].taskId, "task-a");
  assert.deepEqual(app.calls.export, [["user-a"]]);
  const failedBackup = routeFixture({ store: { exportAll: async () => { throw new Error(PRIVATE_ERROR); } } });
  const backupError = await failedBackup.backup();
  assert.equal(backupError.status, 503);
  assert.equal((await backupError.text()).includes(PRIVATE_ERROR), false);
});

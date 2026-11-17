import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as chat from "../lib/task-chat.ts";
import * as stream from "../lib/chat-stream.ts";

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const source = compile("../app/task-chat.tsx");
const settle = () => new Promise(resolve => setImmediate(resolve));
const draftKey = (taskId, userKey = "chat-ui-test") => `yike.chat.draft.v1:${encodeURIComponent(userKey)}:${encodeURIComponent(taskId)}`;

function snapshot(messages = [], extra = {}) {
  return { messages, before: null, memory: "", memoryRevision: 0, pending: null, providerConfigured: true, model: "test-model", ...extra };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(payload) };
}

function answer(operation) {
  return snapshot([
    { id: `${operation.operationId}:user`, role: "user", content: operation.message, createdAt: 1, operationId: operation.operationId },
    { id: `${operation.operationId}:assistant`, role: "assistant", content: "A saved answer", createdAt: 2, operationId: operation.operationId },
  ]);
}

class Storage extends Map {
  get length() { return this.size; }
  key(index) { return [...this.keys()][index] ?? null; }
  getItem(key) { return this.get(key) ?? null; }
  setItem(key, value) { this.set(key, String(value)); }
  removeItem(key) { this.delete(key); }
}

function storedDraft(storage, taskId) {
  const prefix = `${draftKey(taskId)}:`;
  const records = [...storage].filter(([key]) => key.startsWith(prefix)).map(([, value]) => JSON.parse(value));
  return records.sort((left, right) => right.savedAt - left.savedAt)[0] ?? null;
}

// Execute the real component's hooks. Replace only React rendering and browser/network boundaries.
function boot({ taskId = "task-a", userKey = "chat-ui-test", storage = new Storage(), session = new Storage(), network = async () => response(snapshot()), disabled = false, relatedNotes = [], onQuizGenerated } = {}) {
  const hooks = [];
  const intervals = new Map();
  const events = new Map();
  const requests = [];
  let hookIndex = 0;
  let scheduled = true;
  let tree;
  let effects = [];
  let timerId = 0;

  const react = {
    useState(initial) {
      const slot = hookIndex++;
      hooks[slot] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks[slot].value, value => {
        const next = typeof value === "function" ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; scheduled = true; }
      }];
    },
    useRef(initial) {
      const slot = hookIndex++;
      return hooks[slot] ??= { current: initial };
    },
    useId() {
      const slot = hookIndex++;
      return hooks[slot] ??= `chat-test-${slot}`;
    },
    useCallback(value, dependencies) {
      const slot = hookIndex++;
      const previous = hooks[slot];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) hooks[slot] = { value, dependencies };
      return hooks[slot].value;
    },
    useEffect(callback, dependencies) {
      const slot = hookIndex++;
      const previous = hooks[slot];
      if (!previous || !dependencies || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[slot] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => key });
      if (name === "../lib/task-chat") return chat;
      if (name === "../lib/chat-stream") return stream;
      if (name === "./markdown-document") return { MarkdownDocument: "MarkdownDocument" };
      if (name.endsWith(".css")) return {};
      throw new Error(`Unexpected component dependency ${name}`);
    },
    crypto: { randomUUID }, localStorage: storage, sessionStorage: session, AbortSignal, Intl, Date, JSON, Map, Set, Error,
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
      return network(url, options);
    },
    requestAnimationFrame: callback => callback(),
    window: {
      setInterval(callback) { const id = ++timerId; intervals.set(id, callback); return id; },
      clearInterval(id) { intervals.delete(id); },
      setTimeout, clearTimeout,
      addEventListener(name, callback) { events.set(name, callback); },
      removeEventListener(name) { events.delete(name); },
    },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });

  function allNodes(node) {
    if (!node || typeof node !== "object") return [];
    const children = node.props?.children;
    const descendants = Array.isArray(children) ? children.flat(Infinity) : [children];
    return [node, ...descendants.flatMap(allNodes)];
  }
  function textOf(node) {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (!node || typeof node !== "object") return "";
    if (typeof node.props?.content === "string") return node.props.content;
    if (node.type === "MarkdownDocument") return node.props.body;
    const children = node.props?.children;
    return (Array.isArray(children) ? children.flat(Infinity) : [children]).map(textOf).join("");
  }
  const find = predicate => allNodes(tree).find(predicate);
  const button = text => find(node => node.type === "button" && textOf(node).includes(text));

  return {
    storage, requests, find, button, textOf,
    composer: () => find(node => node.type === "textarea" && node.props.placeholder?.includes("哪里还没理解")),
    memoryInput: () => find(node => node.type === "textarea" && !node.props.placeholder),
    async flush() {
      for (let step = 0; step < 16; step++) {
        if (scheduled) {
          scheduled = false;
          hookIndex = 0;
          tree = module.exports.default({ task: { id: taskId, title: "Test learning task" }, userKey, disabled, relatedNotes, onQuizGenerated });
          const pendingEffects = effects;
          effects = [];
          pendingEffects.forEach(effect => effect());
        }
        await settle();
      }
      assert.equal(scheduled, false, "component state must settle");
    },
    changeQuestion(value) { this.composer().props.onChange({ target: { value } }); },
    submit() { find(node => node.type === "form" && node.props.className === "chat-composer").props.onSubmit({ preventDefault() {} }); },
    editMemory(value) { this.memoryInput().props.onChange({ target: { value } }); },
    saveMemory() { find(node => node.type === "form" && !node.props.className).props.onSubmit({ preventDefault() {} }); },
    poll() { for (const callback of intervals.values()) callback(); },
    focus() { events.get("focus")?.(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

test("chat drafts persist separately for each task and account", async () => {
  const storage = new Storage();
  const first = boot({ storage });
  await first.flush();
  first.changeQuestion("Unfinished question A");
  await first.flush();
  first.unmount();
  const otherTask = boot({ storage, taskId: "task-b" });
  await otherTask.flush();
  assert.equal(otherTask.composer().props.value, "");
  otherTask.changeQuestion("Unfinished question B");
  await otherTask.flush();
  otherTask.unmount();
  const otherAccount = boot({ storage, userKey: "another-user" });
  await otherAccount.flush();
  assert.equal(otherAccount.composer().props.value, "");
  otherAccount.unmount();
  const reopened = boot({ storage });
  await reopened.flush();
  assert.equal(reopened.composer().props.value, "Unfinished question A");
  assert.equal(storedDraft(storage, "task-b").draft, "Unfinished question B");
  reopened.unmount();
});

test("Ctrl+Enter during IME composition keeps the question editable", async () => {
  const page = boot();
  await page.flush();
  page.changeQuestion("学习问题");
  await page.flush();
  let prevented = false;
  page.composer().props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: { isComposing: true }, preventDefault() { prevented = true; } });
  await page.flush();
  assert.equal(page.requests.filter(request => request.method === "POST").length, 0);
  assert.equal(prevented, false);
  assert.equal(page.composer().props.value, "学习问题");
  page.unmount();
});

test("one tab's answer preserves another tab's question and memory drafts across reload", async () => {
  const storage = new Storage();
  const secondSession = new Storage();
  let finish;
  let saved = snapshot();
  const first = boot({ storage, network: async (_url, options) => {
    if (options.method === "POST") return new Promise(resolve => {
      finish = () => { saved = answer(JSON.parse(options.body)); resolve(response(saved)); };
    });
    return response(saved);
  } });
  const second = boot({ storage, session: secondSession, network: async () => response(saved) });
  await first.flush();
  await second.flush();
  first.changeQuestion("Question from tab A");
  await first.flush();
  first.submit();
  await first.flush();
  second.changeQuestion("Unsent important draft B");
  second.button("编辑记忆").props.onClick();
  await second.flush();
  second.editMemory("Unfinished memory edit B");
  await second.flush();
  finish();
  await first.flush();
  second.unmount();
  const reopened = boot({ storage, session: secondSession, network: async () => response(saved) });
  await reopened.flush();
  assert.equal(first.composer().props.value, "");
  assert.equal(reopened.composer().props.value, "Unsent important draft B");
  assert.equal(reopened.memoryInput().props.value, "Unfinished memory edit B");
  first.unmount();
  reopened.unmount();
});

test("a network failure keeps the question and its retry operation", async () => {
  const page = boot({ network: async (_url, options) => {
    if (options.method === "POST") throw new Error("Offline test");
    return response(snapshot());
  } });
  await page.flush();
  page.changeQuestion("Keep this question");
  await page.flush();
  page.submit();
  await page.flush();
  const saved = storedDraft(page.storage, "task-a");
  assert.equal(page.composer().props.value, "Keep this question");
  assert.equal(saved.operation.message, "Keep this question");
  assert.ok(saved.operation.operationId);
  assert.ok(page.button("重试上一个问题"));
  page.unmount();
});

test("retrying after reload reuses the original operation id", async () => {
  const operation = { operationId: randomUUID(), message: "Retry the original question" };
  const storage = new Storage();
  storage.setItem(draftKey("task-a"), JSON.stringify({ draft: operation.message, operation }));
  const page = boot({ storage, network: async (_url, options) => response(options.method === "POST" ? answer(JSON.parse(options.body)) : snapshot()) });
  await page.flush();
  page.submit();
  await page.flush();
  const request = page.requests.find(request => request.method === "POST");
  assert.deepEqual(request.body, operation);
  page.unmount();
});

test("an acknowledged answer clears the submitted draft and renders Markdown", async () => {
  let saved = snapshot();
  const page = boot({ network: async (_url, options) => {
    if (options.method === "POST") saved = answer(JSON.parse(options.body));
    return response(saved);
  } });
  await page.flush();
  page.changeQuestion("Please explain");
  await page.flush();
  page.submit();
  await page.flush();
  assert.equal(page.composer().props.value, "");
  assert.equal(storedDraft(page.storage, "task-a"), null);
  const markdown = page.find(node => node.type === "MarkdownDocument");
  assert.equal(markdown.props.body, "A saved answer");
  assert.match(markdown.props.headingPrefix, /^chat-.+:assistant$/);
  page.unmount();
});

test("SSE displays partial Markdown before completion and replaces it with the saved answer", async () => {
  let controller;
  let operation;
  let saved = snapshot();
  const encoder = new TextEncoder();
  const page = boot({ network: async (_url, options) => {
    if (options.method === "POST") {
      operation = JSON.parse(options.body);
      return new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
    }
    return response(saved);
  } });
  await page.flush();
  page.changeQuestion("流式问题");
  await page.flush();
  page.submit();
  await page.flush();
  const emit = (event, payload) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
  emit("started", { operationId: operation.operationId });
  emit("delta", { text: "第一段正在显示" });
  await page.flush();
  assert.equal(page.find(node => node.type === "MarkdownDocument").props.body, "第一段正在显示");
  assert.ok(page.find(node => node.props?.className === "chat-streaming" || node.props?.className?.includes("chat-streaming")));
  saved = answer(operation);
  emit("complete", saved);
  controller.close();
  await page.flush();
  assert.equal(page.find(node => node.type === "MarkdownDocument").props.body, "A saved answer");
  assert.equal(page.find(node => node.props?.className?.includes("chat-streaming")), undefined);
  assert.equal(page.composer().props.value, "");
  page.unmount();
});

test("selected references and excerpts survive reload and accompany the question", async () => {
  const storage = new Storage();
  const notes = [{ id: "a", title: "笔记A" }, { id: "b", title: "笔记B" }];
  const first = boot({ storage, relatedNotes: notes });
  await first.flush();
  const checkbox = first.find(node => node.type === "input" && node.props.type === "checkbox");
  checkbox.props.onChange({ target: { checked: false } });
  await first.flush();
  first.find(node => node.type === "textarea" && node.props.placeholder?.includes("粘贴")).props.onChange({ target: { value: "引用段落" } });
  first.changeQuestion("材料里的问题");
  await first.flush();
  first.unmount();
  const reopened = boot({ storage, relatedNotes: notes, network: async (_url, options) => response(options.method === "POST" ? answer(JSON.parse(options.body)) : snapshot()) });
  await reopened.flush();
  assert.equal(reopened.find(node => node.type === "textarea" && node.props.placeholder?.includes("粘贴")).props.value, "引用段落");
  reopened.submit();
  await reopened.flush();
  const request = reopened.requests.find(request => request.method === "POST");
  assert.deepEqual(request.body.selectedNoteIds, ["b"]);
  assert.equal(request.body.excerpt, "引用段落");
  reopened.unmount();
});

test("quiz save retry reuses generated questions without another model request", async () => {
  let allowSave = false;
  let saveCalls = 0;
  const questions = [{ question: "接口是什么？", answer: "方法契约" }];
  const page = boot({ onQuizGenerated: () => { saveCalls++; return allowSave; }, network: async (url) => url.endsWith("/quiz") ? response({ questions }) : response(answer({ operationId: "op", message: "问题" })) });
  await page.flush();
  page.button("生成并保存自测题").props.onClick();
  await page.flush();
  assert.ok(page.button("保存已生成题目"));
  allowSave = true;
  page.button("保存已生成题目").props.onClick();
  await page.flush();
  assert.equal(page.requests.filter(request => request.url.endsWith("/quiz")).length, 1);
  assert.equal(saveCalls, 2);
  page.unmount();
});

test("polling keeps an in-progress memory edit across remote updates", async () => {
  let saved = snapshot();
  const page = boot({ network: async () => response(saved) });
  await page.flush();
  page.button("编辑记忆").props.onClick();
  await page.flush();
  page.editMemory("My unfinished memory edit");
  await page.flush();
  saved = snapshot([], { memory: "Remote memory", memoryRevision: 1 });
  page.poll();
  await page.flush();
  assert.equal(page.memoryInput().props.value, "My unfinished memory edit");
  const draft = storedDraft(page.storage, "task-a").memoryDraft;
  assert.equal(draft.baseRevision, 0);
  page.unmount();
});

test("a stale memory revision requires loading the updated memory", async () => {
  let saved = snapshot();
  const page = boot({ network: async () => response(saved) });
  await page.flush();
  page.button("编辑记忆").props.onClick();
  await page.flush();
  page.editMemory("My memory edit");
  await page.flush();
  saved = snapshot([], { memory: "Updated elsewhere", memoryRevision: 1 });
  page.poll();
  await page.flush();
  assert.equal(page.button("保存记忆").props.disabled, true);
  page.button("载入最新记忆").props.onClick();
  await page.flush();
  assert.equal(page.memoryInput().props.value, "Updated elsewhere");
  assert.equal(page.button("保存记忆").props.disabled, false);
  page.unmount();
});

test("memory save confirmation appears after server acknowledgement", async () => {
  let resolveSave;
  let saved = snapshot();
  const page = boot({ network: async (_url, options) => {
    if (options.method === "PATCH") return new Promise(resolve => { resolveSave = resolve; });
    return response(saved);
  } });
  await page.flush();
  page.button("编辑记忆").props.onClick();
  await page.flush();
  page.editMemory("Saved memory");
  await page.flush();
  page.saveMemory();
  await page.flush();
  assert.equal(page.find(node => node.props?.className === "chat-feedback"), undefined);
  assert.equal(page.button("保存记忆").props.disabled, true);
  saved = snapshot([], { memory: "Saved memory", memoryRevision: 1 });
  resolveSave(response(saved));
  await page.flush();
  assert.ok(page.textOf(page.find(node => node.props?.className === "chat-feedback")).includes("记忆已保存"));
  assert.equal(storedDraft(page.storage, "task-a"), null);
  page.unmount();
});

test("older history and its cursor survive polling the latest messages", async () => {
  const latest = { id: "new", role: "assistant", content: "Latest answer", createdAt: 20 };
  const older = { id: "old", role: "user", content: "Earlier question", createdAt: 10 };
  const page = boot({ network: async url => response(url.includes("?before=") ? snapshot([older], { before: "5" }) : snapshot([latest], { before: "10" })) });
  await page.flush();
  page.button("更早的对话").props.onClick();
  await page.flush();
  page.poll();
  await page.flush();
  const messages = page.textOf(page.find(node => node.props?.className === "chat-messages"));
  assert.ok(messages.includes("Earlier question"));
  assert.ok(messages.includes("Latest answer"));
  page.button("更早的对话").props.onClick();
  await page.flush();
  assert.equal(page.requests.at(-1).url.endsWith("?before=5"), true);
  page.unmount();
});

test("shared Markdown rendering gives each answer distinct heading anchors", () => {
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  vm.runInNewContext(compile("../app/markdown-document.tsx"), {
    module, exports: module.exports,
    require: name => name.endsWith(".css") ? {} : require(name),
  });
  const { MarkdownDocument } = module.exports;
  const body = "## Repeated\n\n[Jump](#repeated)\n\n```cpp\nint main() { return 0; }\n```\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))";
  const first = renderToStaticMarkup(createElement(MarkdownDocument, { body, headingPrefix: "chat-first" }));
  const second = renderToStaticMarkup(createElement(MarkdownDocument, { body, headingPrefix: "chat-second" }));
  const existingNote = renderToStaticMarkup(createElement(MarkdownDocument, { body }));
  assert.ok(first.includes('id="chat-first-repeated"'));
  assert.ok(first.includes('href="#chat-first-repeated"'));
  assert.ok(second.includes('id="chat-second-repeated"'));
  assert.ok(existingNote.includes('id="note-heading-repeated"'));
  assert.ok(first.includes("language-cpp"));
  assert.ok(first.includes("hljs-keyword"));
  assert.doesNotMatch(first, /<script|href="javascript:/i);
});

test("a completed turn keeps its status when a stale historical page arrives", async () => {
  const complete = answer({ operationId: "finished-operation", message: "A retried question" });
  const staleQuestion = { ...complete.messages[0], status: "failed" };
  const page = boot({ network: async url => response(url.includes("?before=") ? snapshot([staleQuestion]) : { ...complete, before: "10" }) });
  await page.flush();
  page.button("更早的对话").props.onClick();
  await page.flush();
  assert.equal(page.button("重新回答"), undefined);
  assert.ok(page.textOf(page.find(node => node.props?.className === "chat-messages")).includes("A saved answer"));
  page.unmount();
});

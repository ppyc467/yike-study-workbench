import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as study from "../lib/study.ts";

// Execute the real hook with browser/network boundaries replaced. No server, browser or new dependency.
const compile = (file) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const hookSource = compile("../lib/use-workspace.ts");
const outboxModule = { exports: {} };
vm.runInNewContext(compile("../lib/outbox.ts"), {
  module: outboxModule, exports: outboxModule.exports, require: () => study, JSON,
});
const { applyDiscardNotices } = outboxModule.exports;
const mergeModule = { exports: {} };
vm.runInNewContext(compile("../lib/sync-merge.ts"), { module: mergeModule, exports: mergeModule.exports, require: () => study, JSON });

class Storage {
  get length() { return Object.keys(this).length; }
  key(i) { return Object.keys(this)[i] ?? null; }
  getItem(key) { return this[key] ?? null; }
  setItem(key, value) { this[key] = String(value); }
  removeItem(key) { delete this[key]; }
}

const USER = "outbox-test";
const PREFIX = `yike.workspace.v1:${USER}:`;
const T = Date.now() - 10_000;
const baseState = study.applyCommand(study.initialWorkspace(), {
  type: "task.add", id: "task1", projectId: "course", title: "Test", at: T,
});
const draftCommand = { type: "task.update", id: "task1", notes: "discarded offline draft", at: T + 1000 };
const base = { state: baseState, revision: 1, serverNow: T };
const snapshot = {
  state: study.applyCommand(study.applyCommand(baseState, { type: "settings.goal", minutes: 60, at: T + 2000 }), { type: "task.update", id: "task1", notes: "Cloud version", at: T + 2000 }),
  revision: 2, serverNow: T + 3000,
};
const response = (method) => ({ status: method === "POST" ? 409 : 200, ok: method !== "POST", json: async () => structuredClone(snapshot) });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function seed(storage) {
  const key = PREFIX + "legacy-closed-tab";
  storage.setItem(key, JSON.stringify({ version: 1, base, pending: [draftCommand], flight: null, closed: true }));
  return key;
}

function boot(storage, network = async (_url, options) => response(options.method), options = {}) {
  let stateIndex = 0;
  let effect;
  let key;
  const values = [];
  const events = new Map();
  const timers = new Map();
  const intervals = new Map();
  const requests = [];
  const downloads = [];
  let timerId = 0;
  let currentTime = options.now;
  class PageDate extends Date {
    static now() { return currentTime ?? Date.now(); }
  }
  const react = {
    useState(value) { const index = stateIndex++; values[index] = value; return [value, (next) => { values[index] = next; }]; },
    useRef(value) { return { current: value }; },
    useCallback(callback) { return callback; },
    useEffect(callback) { effect = callback; },
  };
  const eventTarget = {
    addEventListener(name, handler) { events.set(name, handler); },
    removeEventListener(name) { events.delete(name); },
  };
  const pageDocument = { ...eventTarget, visibilityState: options.visibility ?? "visible", createElement() { return { click() {} }; } };
  const module = { exports: {} };
  vm.runInNewContext(hookSource, {
    module, exports: module.exports,
    require: (name) => name === "react" ? react : name === "./study" ? study : name === "./sync-merge" ? mergeModule.exports : outboxModule.exports,
    Date: PageDate, Math, JSON, Error, Object, Number, Array, TextEncoder, structuredClone, AbortSignal, Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:mock-backup"; }, revokeObjectURL() {} },
    crypto: { randomUUID() { const id = crypto.randomUUID(); key ??= PREFIX + id; return id; } },
    localStorage: storage, navigator: { onLine: true },
    window: { ...eventTarget, confirm: () => true, matchMedia: query => ({ matches: options.standalone === true && query === "(display-mode: standalone)" }) },
    document: pageDocument,
    setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      requests.push({ method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return network(url, options);
    },
  });
  const hook = module.exports.useWorkspace(USER);
  const cleanup = effect();
  return {
    hook, cleanup, requests, downloads,
    get status() { return values[1]; },
    get state() { return values[0]; },
    get message() { return values[2]; },
    get exportMessage() { return values[3]; },
    get now() { return values[4]; },
    get intervalCount() { return intervals.size; },
    get cache() { return JSON.parse(storage.getItem(key)); },
    event(name, event = {}) { events.get(name)?.(event); },
    setVisibility(visibility) { pageDocument.visibilityState = visibility; events.get("visibilitychange")?.(); },
    advance(milliseconds) { currentTime = (currentTime ?? Date.now()) + milliseconds; },
    async runIntervals(delay) {
      for (const interval of intervals.values()) if (interval.delay === delay) interval.callback();
      await settle();
    },
    async runTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
      await settle();
    },
  };
}

test("a hidden installed desktop app keeps its clock and remote timer controls current", async () => {
  const startedAt = Date.now();
  let remote = {
    state: study.applyCommand(baseState, { type: "session.start", id: "desktop-session", taskId: "task1", mode: "free", targetMs: 0, at: startedAt }),
    revision: 2, serverNow: startedAt,
  };
  const page = boot(new Storage(), async () => ({ status: 200, ok: true, json: async () => structuredClone(remote) }), {
    standalone: true, visibility: "hidden", now: startedAt,
  });
  await settle();
  assert.equal(page.state.activeSessionId, "desktop-session");
  page.advance(5000);
  await page.runIntervals(1000);
  assert.equal(page.now, startedAt + 5000);
  assert.equal(study.sessionElapsedMs(page.state.sessions[0], page.now), 5000);

  remote = { state: study.applyCommand(remote.state, { type: "session.pause", at: startedAt + 5000 }), revision: 3, serverNow: page.now };
  await page.runIntervals(5000);
  assert.equal(page.state.sessions[0].segments.at(-1).end, startedAt + 5000);
  page.advance(5000);
  await page.runIntervals(1000);
  assert.equal(study.sessionElapsedMs(page.state.sessions[0], page.now), 5000);

  remote = { state: study.applyCommand(remote.state, { type: "session.resume", at: startedAt + 10000 }), revision: 4, serverNow: page.now };
  await page.runIntervals(5000);
  assert.equal(page.state.sessions[0].segments.at(-1).end, null);
  page.advance(5000);
  await page.runIntervals(1000);
  assert.equal(study.sessionElapsedMs(page.state.sessions[0], page.now), 10000);

  remote = { state: study.applyCommand(remote.state, { type: "session.finish", at: startedAt + 15000 }), revision: 5, serverNow: page.now };
  await page.runIntervals(5000);
  assert.equal(page.state.activeSessionId, null);
  assert.equal(page.state.sessions[0].finishedAt, startedAt + 15000);
  assert.equal(page.requests.length, 4);
  assert.equal(page.intervalCount, 2);
  page.cleanup();
  assert.equal(page.intervalCount, 0);
  await page.runIntervals(5000);
  assert.equal(page.requests.length, 4);
});

test("a hidden browser tab waits until visible and catches its clock up immediately", async () => {
  const openedAt = Date.now();
  const page = boot(new Storage(), async () => ({ status: 200, ok: true, json: async () => ({ ...base, serverNow: openedAt }) }), {
    visibility: "hidden", now: openedAt,
  });
  await settle();
  page.advance(20000);
  await page.runIntervals(1000);
  await page.runIntervals(5000);
  assert.equal(page.now, openedAt);
  assert.equal(page.requests.length, 1);
  page.setVisibility("visible");
  assert.equal(page.now, openedAt + 20000);
  await settle();
  assert.equal(page.requests.length, 2);
  page.cleanup();
  assert.equal(page.intervalCount, 0);
});

test("hidden desktop polling retains authentication and error guards", async () => {
  for (const responseStatus of [401, 422]) {
    const page = boot(new Storage(), async () => ({ status: responseStatus, ok: false, json: async () => ({ error: "unavailable" }) }), {
      standalone: true, visibility: "hidden",
    });
    await settle();
    assert.equal(page.status, responseStatus === 401 ? "auth" : "error");
    await page.runIntervals(5000);
    assert.equal(page.requests.length, 1);
    page.cleanup();
    assert.equal(page.intervalCount, 0);
  }
});

test("complete backups include task conversations, memory and isolated chat drafts", async () => {
  const storage = new Storage();
  storage.setItem(`yike.chat.draft.v1:${USER}:task1`, JSON.stringify({ draft: "未发送的问题" }));
  const conversations = [{ taskId: "task1", memory: "学习进度", messages: [{ role: "user", content: "问题" }] }];
  const page = boot(storage, async (url, options) => url === "/api/chat-backup"
    ? { ok: true, json: async () => ({ conversations }) }
    : response(options.method));
  await settle();
  await page.hook.exportBackup();
  const backup = JSON.parse(await page.downloads[0].text());
  assert.deepEqual(backup.conversations, conversations);
  assert.equal(backup.chatDrafts[0].draft.draft, "未发送的问题");
  assert.equal(backup.chatExportStatus, "complete");
  assert.match(page.exportMessage, /包含学习对话/);
  page.cleanup();
});

test("a failed chat export still downloads local learning data and reports the missing history", async () => {
  const page = boot(new Storage(), async (url, options) => {
    if (url === "/api/chat-backup") throw new Error("offline");
    return response(options.method);
  });
  await settle();
  await page.hook.exportBackup();
  const backup = JSON.parse(await page.downloads[0].text());
  assert.equal(backup.chatExportStatus, "unavailable");
  assert.equal(backup.base.state.tasks[0].id, "task1");
  assert.match(page.exportMessage, /重新导出完整备份/);
  page.cleanup();
});

test("discarding a recovered v1 draft stays resolved after reload", async () => {
  const storage = new Storage();
  seed(storage);
  const page = boot(storage);
  await settle();
  assert.equal(page.status, "conflict");
  page.hook.resolveConflict();
  await settle();
  assert.equal(page.status, "synced");
  page.cleanup();
  const reopened = boot(storage);
  await settle();
  assert.equal(reopened.status, "synced");
  assert.deepEqual(reopened.requests.map((request) => request.method), ["GET"]);
  assert.equal(reopened.cache.base.state.tasks[0].notes, "Cloud version");
  reopened.cleanup();
});

test("a suspended original tab cannot rewrite or resend a discarded copy", async () => {
  const storage = new Storage();
  seed(storage);
  let offline = true;
  const original = boot(storage, async (_url, options) => {
    if (offline) throw new Error("offline");
    return response(options.method);
  });
  await settle();
  assert.equal(original.status, "offline");
  const recovered = boot(storage);
  await settle();
  recovered.hook.resolveConflict();
  await settle();
  original.event("pagehide"); // Late persistence from the old in-memory outbox.
  assert.equal(original.cache.pending.length, 0);
  assert.equal(original.cache.base.state.tasks[0].notes, "Cloud version", "discarded text is absent even before another network response");
  offline = false;
  original.hook.retry();
  await settle();
  assert.equal(original.status, "synced");
  assert.deepEqual(original.requests.map((request) => request.method), ["POST", "GET"]);
  original.cleanup(); recovered.cleanup();
});

test("reopening offline after resolving a conflict displays the confirmed cloud state", async () => {
  const storage = new Storage();
  seed(storage);
  const page = boot(storage);
  await settle();
  page.hook.resolveConflict();
  await settle();
  page.cleanup();
  const offline = boot(storage, async () => { throw new Error("offline"); });
  await settle();
  assert.equal(offline.status, "offline");
  assert.equal(offline.state.tasks[0].notes, "Cloud version");
  assert.equal(offline.state.goalMinutes, 60);
  assert.deepEqual(offline.requests.map((request) => request.method), ["GET"]);
  offline.cleanup();
});

test("blocked localStorage still allows online loading and editing, with a local-save warning", async () => {
  const storage = new Proxy(new Storage(), {
    ownKeys() { throw new Error("storage blocked"); },
    get(target, property) {
      if (["getItem", "setItem", "removeItem"].includes(property)) return () => { throw new Error("storage blocked"); };
      return Reflect.get(target, property);
    },
  });
  let saved = structuredClone(snapshot);
  const page = boot(storage, async (_url, options) => {
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      assert.equal(flight.baseRevision, saved.revision);
      saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  });
  await settle();
  assert.equal(page.status, "synced");
  assert.match(page.message, /无法暂存离线修改/);
  assert.equal(page.hook.dispatch({ type: "task.update", id: "task1", notes: "Saved online", at: T }), true);
  await page.runTimers(400);
  assert.equal(page.status, "synced");
  assert.equal(saved.state.tasks[0].notes, "Saved online");
  assert.match(page.message, /无法暂存离线修改/);
  page.cleanup();
});

test("original tab's later edits and unrelated drafts survive, with the old revision guard", async () => {
  const storage = new Storage();
  seed(storage);
  let offline = true;
  const original = boot(storage, async (_url, options) => {
    if (offline) throw new Error("offline");
    return response(options.method);
  });
  await settle();
  const recovered = boot(storage);
  await settle();
  assert.equal(original.hook.dispatch({ type: "settings.goal", minutes: 180, at: T }), true);
  const unrelatedKey = PREFIX + "independent-tab";
  const unrelated = { version: 1, base, pending: [{ type: "task.update", id: "task1", title: "Independent", at: T + 4000 }], flight: null };
  storage.setItem(unrelatedKey, JSON.stringify(unrelated));
  recovered.hook.resolveConflict();
  await settle();
  original.event("pagehide");
  assert.equal(original.cache.pending.length, 1);
  assert.equal(original.cache.pending[0].minutes, 180);
  assert.equal(original.cache.base.revision, 1, "do not silently rebase the original tab's later edits");
  assert.deepEqual(JSON.parse(storage.getItem(unrelatedKey)), unrelated);
  offline = false;
  original.hook.retry();
  await settle();
  assert.equal(original.status, "conflict", "the distinct later edit requires its own conflict decision");
  const sent = original.requests.at(-1).body;
  assert.equal(sent.baseRevision, 1);
  assert.equal(sent.commands.length, 1);
  assert.equal(sent.commands[0].type, "settings.goal");
  original.cleanup(); recovered.cleanup();
});

test("a response arriving after a discard cannot reinstate the old conflict", async () => {
  const storage = new Storage();
  seed(storage);
  let finishOldRequest;
  const original = boot(storage, async (_url, options) => options.method === "POST"
    ? new Promise((resolve) => { finishOldRequest = resolve; })
    : response(options.method));
  const recovered = boot(storage);
  await settle();
  recovered.hook.resolveConflict();
  await settle();
  original.event("pagehide");
  finishOldRequest(response("POST"));
  await settle();
  await original.runTimers(0);
  assert.equal(original.status, "synced");
  assert.equal(original.cache.pending.length, 0);
  original.cleanup(); recovered.cleanup();
});

test("discard notices preserve dependent later commands and independently changed text", () => {
  const add = { type: "task.add", id: "new-task", projectId: "course", title: "New", at: T };
  const note = { type: "task.update", id: "new-task", notes: "A later thought", at: T + 1 };
  const cache = { version: 1, lineage: "origin", base: { ...base, state: study.initialWorkspace() }, pending: [add, note], flight: null };
  const notice = { id: "discard-1", lineage: "origin", baseRevision: 1, commands: [add] };
  assert.equal(applyDiscardNotices(cache, [notice]), true);
  assert.deepEqual(cache.pending, [note]);
  assert.equal(study.applyCommand(cache.base.state, cache.pending[0]).tasks[0].notes, "A later thought");
  assert.equal(cache.base.revision, 1);
  assert.equal(applyDiscardNotices(cache, [notice]), false, "notice is idempotent");
  const changed = { version: 1, lineage: "origin", base, pending: [{ ...draftCommand, notes: "Changed in original tab" }], flight: null };
  assert.equal(applyDiscardNotices(changed, [{ ...notice, commands: [draftCommand] }]), false);
  assert.equal(changed.pending[0].notes, "Changed in original tab");
});

test("adjacent note edits coalesce while task edits and different notes retain their own commands", async () => {
  const storage = new Storage();
  let saved = { ...base, state: study.applyCommand(baseState, { type: "note.add", id: "task1", projectId: "course", title: "独立笔记", at: T }) };
  const page = boot(storage, async (_url, options) => {
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      assert.equal(flight.baseRevision, saved.revision);
      saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  });
  await settle();
  assert.equal(page.hook.dispatch({ type: "note.update", id: "task1", body: "新正文", at: T }), true);
  assert.equal(page.hook.dispatch({ type: "note.update", id: "task1", important: true, at: T }), true);
  assert.equal(page.cache.pending.length, 1);
  assert.equal(page.cache.pending[0].body, "新正文");
  assert.equal(page.cache.pending[0].important, true);
  assert.equal(page.hook.dispatch({ type: "task.update", id: "task1", title: "任务改名", at: T }), true);
  assert.equal(page.hook.dispatch({ type: "note.update", id: "task1", projectId: "english", at: T }), true);
  assert.equal(page.cache.pending.length, 3, "sharing an id cannot combine task and note commands");
  assert.equal(page.hook.dispatch({ type: "note.add", id: "note2", projectId: "course", title: "第二篇", at: T }), true);
  assert.equal(page.hook.dispatch({ type: "note.update", id: "note2", body: "第二篇正文", at: T }), true);
  assert.equal(page.hook.dispatch({ type: "note.update", id: "task1", title: "第一篇改名", at: T }), true);
  assert.equal(page.cache.pending.length, 6);
  await page.runTimers(400);
  assert.equal(page.status, "synced");
  assert.equal(saved.state.notes.length, 2);
  assert.equal(saved.state.notes[0].title, "第一篇改名");
  assert.equal(saved.state.notes[0].body, "新正文");
  assert.equal(saved.state.notes[0].important, true);
  assert.equal(saved.state.notes[0].projectId, "english");
  assert.equal(saved.state.tasks[0].title, "任务改名");
  page.cleanup();
});

test("a note edit made during a save remains outside its immutable in-flight batch", async () => {
  const storage = new Storage();
  let saved = { ...base, state: study.applyCommand(baseState, { type: "note.add", id: "note1", projectId: "course", title: "独立笔记", at: T }) };
  let finishFirstSave;
  const page = boot(storage, async (_url, options) => {
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      const save = () => {
        assert.equal(flight.baseRevision, saved.revision);
        saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
        return { status: 200, ok: true, json: async () => structuredClone(saved) };
      };
      if (!finishFirstSave) return new Promise(resolve => { finishFirstSave = () => resolve(save()); });
      return save();
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  });
  await settle();
  page.hook.dispatch({ type: "note.update", id: "note1", body: "第一份正文", at: T });
  await page.runTimers(400);
  assert.equal(page.cache.flight.commands.length, 1);
  page.hook.dispatch({ type: "note.update", id: "note1", body: "继续补充", at: T });
  page.hook.dispatch({ type: "note.update", id: "note1", important: true, at: T });
  assert.equal(page.cache.pending.length, 2);
  assert.equal(page.cache.flight.commands[0].body, "第一份正文");
  assert.equal(page.cache.pending[1].body, "继续补充");
  assert.equal(page.cache.pending[1].important, true);
  finishFirstSave();
  await settle();
  await page.runTimers(100);
  assert.equal(page.status, "synced");
  assert.equal(saved.state.notes[0].body, "继续补充");
  assert.equal(saved.state.notes[0].important, true);
  assert.equal(saved.revision, base.revision + 2);
  page.cleanup();
});

test("offline independent note creation and editing survive closing, reopening and exact retry", async () => {
  const storage = new Storage();
  let saved = structuredClone(base);
  let offline = false;
  const network = async (_url, options) => {
    if (offline) throw new Error("offline");
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      assert.equal(flight.baseRevision, saved.revision);
      saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  };
  const page = boot(storage, network);
  await settle();
  offline = true;
  page.hook.dispatch({ type: "note.add", id: "offline-note", projectId: "course", title: "离线笔记", at: T });
  page.hook.dispatch({ type: "note.update", id: "offline-note", body: "关闭页面前写下的想法", at: T });
  page.hook.dispatch({ type: "note.update", id: "offline-note", important: true, at: T });
  await page.runTimers(400);
  const firstFlight = page.requests.at(-1).body;
  assert.equal(page.status, "offline");
  page.cleanup();
  const reopened = boot(storage, network);
  await settle();
  assert.equal(reopened.status, "offline");
  assert.equal(reopened.state.notes[0].body, "关闭页面前写下的想法");
  assert.equal(reopened.state.notes[0].important, true);
  assert.deepEqual(reopened.requests[0].body, firstFlight, "the recovered save retains its original operation id and payload");
  offline = false;
  reopened.hook.retry();
  await settle();
  assert.equal(reopened.status, "synced");
  assert.equal(saved.state.notes.length, 1);
  assert.equal(saved.state.notes[0].body, "关闭页面前写下的想法");
  assert.equal(saved.state.notes[0].important, true);
  assert.equal(saved.revision, base.revision + 1);
  assert.equal(reopened.cache.pending.length, 0);
  reopened.cleanup();
});

test("maximum-length multilingual and JSON-escaped note bodies synchronize in bounded nonempty batches", async () => {
  const storage = new Storage();
  let saved = structuredClone(base);
  for (const id of ["note1", "note2", "note3"]) {
    saved.state = study.applyCommand(saved.state, { type: "note.add", id, projectId: "course", title: id, at: T });
  }
  const page = boot(storage, async (_url, options) => {
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      assert.ok(new TextEncoder().encode(options.body).byteLength < 320_000);
      assert.ok(flight.commands.length > 0, "large valid notes must never create an empty sync batch");
      assert.equal(flight.baseRevision, saved.revision);
      saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  });
  await settle();
  const bodies = ["学".repeat(50_000), "\u0000".repeat(50_000), "😀".repeat(25_000)];
  for (const [index, body] of bodies.entries()) {
    assert.equal(page.hook.dispatch({ type: "note.update", id: `note${index + 1}`, body, at: T }), true);
  }
  await page.runTimers(400);
  await page.runTimers(100);
  await page.runTimers(100);
  assert.equal(page.status, "synced");
  assert.deepEqual(saved.state.notes.map(note => note.body), bodies);
  assert.equal(page.cache.pending.length, 0);
  const posts = page.requests.filter(request => request.method === "POST");
  assert.ok(posts.some(request => new TextEncoder().encode(JSON.stringify(request.body)).byteLength > 256_000), "escaped controls exercise the single-command size boundary");
  page.cleanup();
});

test("coalesced note project edits preserve automatic detachment and explicit reassociation", async () => {
  const cases = [
    { taskId: "task1", edits: [{ projectId: "english" }, { projectId: "course" }], finalProject: "course", finalTask: undefined },
    { taskId: null, edits: [{ taskId: "task1" }, { projectId: "english" }], finalProject: "english", finalTask: undefined },
    { taskId: "task1", edits: [{ projectId: "english" }, { projectId: "course", taskId: "task1" }], finalProject: "course", finalTask: "task1" },
  ];
  for (const scenario of cases) {
    const storage = new Storage();
    let saved = { ...base, state: study.applyCommand(baseState, { type: "note.add", id: "note1", projectId: "course", taskId: scenario.taskId, title: "关联笔记", at: T }) };
    const page = boot(storage, async (_url, options) => {
      if (options.method === "POST") {
        const flight = JSON.parse(options.body);
        assert.equal(flight.baseRevision, saved.revision);
        saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
      }
      return { status: 200, ok: true, json: async () => structuredClone(saved) };
    });
    await settle();
    for (const edit of scenario.edits) assert.equal(page.hook.dispatch({ type: "note.update", id: "note1", ...edit, at: T }), true);
    assert.equal(page.cache.pending.length, 1);
    assert.equal(page.state.notes[0].projectId, scenario.finalProject);
    assert.equal(page.state.notes[0].taskId, scenario.finalTask);
    assert.equal(page.cache.pending[0].taskId, scenario.finalTask ?? null);
    const optimistic = structuredClone(page.state);
    await page.runTimers(400);
    assert.equal(page.status, "synced");
    assert.deepEqual(saved.state, optimistic, "coalescing must preserve the sequence's derived association state");
    assert.equal(Object.hasOwn(saved.state.notes[0], "taskId"), scenario.finalTask !== undefined);
    page.cleanup();
  }
});

test("automatic detachment during an in-flight association save leaves that flight immutable", async () => {
  const storage = new Storage();
  let saved = { ...base, state: study.applyCommand(baseState, { type: "note.add", id: "note1", projectId: "course", title: "关联笔记", at: T }) };
  let finishFirstSave;
  const page = boot(storage, async (_url, options) => {
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      const save = () => {
        assert.equal(flight.baseRevision, saved.revision);
        saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
        return { status: 200, ok: true, json: async () => structuredClone(saved) };
      };
      if (!finishFirstSave) return new Promise(resolve => { finishFirstSave = () => resolve(save()); });
      return save();
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  });
  await settle();
  page.hook.dispatch({ type: "note.update", id: "note1", taskId: "task1", at: T });
  await page.runTimers(400);
  page.hook.dispatch({ type: "note.update", id: "note1", projectId: "english", at: T });
  assert.equal(page.cache.pending.length, 2);
  assert.equal(page.cache.flight.commands[0].taskId, "task1");
  assert.equal(page.cache.flight.commands[0].projectId, undefined);
  assert.equal(page.cache.pending[1].taskId, null);
  assert.equal(page.state.notes[0].taskId, undefined);
  finishFirstSave();
  await settle();
  await page.runTimers(100);
  assert.equal(page.status, "synced");
  assert.equal(saved.state.notes[0].projectId, "english");
  assert.equal(Object.hasOwn(saved.state.notes[0], "taskId"), false);
  assert.equal(saved.revision, base.revision + 2);
  page.cleanup();
});

test("offline task movement and per-task note edits retain their associations across close and replay", async () => {
  const storage = new Storage();
  let saved = { ...base, state: study.applyCommand(baseState, { type: "note.add", id: "note1", projectId: "course", taskId: "task1", title: "第一章", at: T }) };
  let offline = false;
  const network = async (_url, options) => {
    if (offline) throw new Error("offline");
    if (options.method === "POST") {
      const flight = JSON.parse(options.body);
      assert.equal(flight.baseRevision, saved.revision);
      saved = { ...saved, state: flight.commands.reduce(study.applyCommand, saved.state), revision: saved.revision + 1 };
    }
    return { status: 200, ok: true, json: async () => structuredClone(saved) };
  };
  const page = boot(storage, network);
  await settle();
  offline = true;
  page.hook.dispatch({ type: "note.add", id: "note2", projectId: "course", taskId: "task1", title: "第二章", body: "离线新增", at: T });
  page.hook.dispatch({ type: "task.update", id: "task1", projectId: "english", at: T });
  page.hook.dispatch({ type: "note.update", id: "note1", body: "离线补充", important: true, at: T });
  page.hook.dispatch({ type: "note.update", id: "note2", taskId: null, at: T });
  const optimistic = structuredClone(page.state);
  await page.runTimers(400);
  const originalFlight = page.requests.at(-1).body;
  assert.equal(page.status, "offline");
  page.cleanup();
  const reopened = boot(storage, network);
  await settle();
  assert.equal(reopened.status, "offline");
  assert.deepEqual(reopened.state, optimistic);
  assert.deepEqual(reopened.requests[0].body, originalFlight);
  offline = false;
  reopened.hook.retry();
  await settle();
  assert.equal(reopened.status, "synced");
  assert.deepEqual(saved.state, optimistic);
  assert.equal(saved.state.notes[0].taskId, "task1");
  assert.equal(saved.state.notes[0].projectId, "english");
  assert.equal(saved.state.notes[0].body, "离线补充");
  assert.equal(saved.state.notes[1].projectId, "english");
  assert.equal(Object.hasOwn(saved.state.notes[1], "taskId"), false);
  assert.equal(saved.revision, base.revision + 1);
  reopened.cleanup();
});

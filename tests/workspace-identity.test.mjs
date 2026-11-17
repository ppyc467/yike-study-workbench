import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const origin = "https://study.example";
const source = ts.transpileModule(readFileSync(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
class StudyError extends Error {}
class WorkspaceConflict extends Error {
  constructor(snapshot) { super("版本冲突"); this.snapshot = snapshot; }
}

function setup() {
  const session = { userId: "account-a", failure: null };
  const calls = [];
  const records = new Map(["account-a", "account-b"].map(user => [user, { revision: 0, serverNow: 1, state: { projects: [{ id: "course", title: user }] } }]));
  const store = {
    async read(userId) { calls.push({ kind: "read", userId }); if (session.failure) throw session.failure; return structuredClone(records.get(userId)); },
    async readVersion(userId) { calls.push({ kind: "version", userId }); return { revision: records.get(userId).revision }; },
    async mutate(userId, payload) {
      calls.push({ kind: "mutate", userId });
      const previous = records.get(userId);
      if (payload.baseRevision !== previous.revision) throw new WorkspaceConflict(structuredClone(previous));
      if (session.failure) throw session.failure;
      const next = structuredClone(previous);
      next.revision++;
      next.state.projects[0].title = payload.title;
      records.set(userId, next);
      return structuredClone(next);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Response, URL, TextDecoder,
    require(name) {
      if (name.endsWith("chatgpt-auth")) return { getChatGPTUser: async () => session.userId ? { userId: session.userId } : null };
      if (name.endsWith("db/workspace-store")) return { workspaceStore: store };
      if (name.endsWith("lib/study")) return { StudyError };
      if (name.endsWith("lib/workspace-store")) return { WorkspaceConflict };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const request = (method, userKey, payload, extra = {}) => new Request(`${origin}/api/workspace`, {
    method, headers: { origin, "content-type": "application/json", ...(userKey === undefined ? {} : { "X-Study-User-Key": userKey }), ...extra },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { session, calls, records, get: (userKey, extra) => module.exports.GET(request("GET", userKey, undefined, extra)), post: (userKey, payload = { baseRevision: 0, title: "新名称" }) => module.exports.POST(request("POST", userKey, payload)) };
}

test("an old account's concurrent reads and writes are refused after the cookie session changes", async () => {
  const app = setup();
  assert.equal((await app.get("account-a")).headers.get("x-study-user"), "account-a");
  app.calls.length = 0;
  app.session.userId = "account-b";
  const responses = await Promise.all([app.get("account-a"), app.post("account-a"), app.get("account-a", { "if-none-match": '"workspace-0"' })]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-study-user"), "account-b");
  }
  assert.deepEqual(app.calls, []);
  assert.equal(app.records.get("account-b").state.projects[0].title, "account-b");
  assert.equal((await app.post("account-b")).status, 200);
  assert.equal(app.records.get("account-b").state.projects[0].title, "新名称");
  assert.equal(app.records.get("account-a").state.projects[0].title, "account-a");
});

test("conditional reads identify their account even when two accounts have the same revision", async () => {
  const app = setup();
  const response = await app.get("account-a", { "if-none-match": '"workspace-0"' });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("x-study-user"), "account-a");
  assert.deepEqual(app.calls, [{ kind: "version", userId: "account-a" }]);
});

test("authenticated conflict and failure responses retain account identity", async () => {
  const app = setup();
  const conflict = await app.post("account-a", { baseRevision: 12, title: "冲突" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get("x-study-user"), "account-a");
  app.session.failure = new StudyError("输入无效");
  const invalid = await app.post("account-a");
  assert.equal(invalid.status, 422);
  assert.equal(invalid.headers.get("x-study-user"), "account-a");
  const failedRead = await app.get("account-a");
  assert.equal(failedRead.status, 503);
  assert.equal(failedRead.headers.get("x-study-user"), "account-a");
});

test("legacy callers may omit the identity hint while anonymous requests remain denied", async () => {
  const app = setup();
  assert.equal((await app.get()).status, 200);
  assert.equal((await app.post()).status, 200);
  app.session.userId = null;
  app.calls.length = 0;
  for (const response of [await app.get("account-a"), await app.post("account-a")]) assert.equal(response.status, 401);
  assert.deepEqual(app.calls, []);
});

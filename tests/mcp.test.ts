import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { WorkspaceStore } from "../lib/workspace-store";

const compiled = ts.transpileModule(readFileSync(new URL("../lib/mcp.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tools = [{ name: "study_read", inputSchema: { type: "object", properties: {} } }, { name: "study_update", inputSchema: { type: "object", properties: {} } }];
const ORIGIN = "https://study.example";
const parsed = (response: Response) => response.json() as Promise<{
  error: { code: number; message: string };
  result: { tools: typeof tools; protocolVersion: string; isError: boolean };
}>;

function setup(handler: (...args: unknown[]) => Promise<unknown> = async () => ({ content: [{ type: "text", text: "ok" }] })) {
  const calls: unknown[][] = [];
  const databaseCalls: unknown[] = [];
  const store = {
    read: async (userId: string) => { databaseCalls.push(userId); throw new Error("unexpected read"); },
    readVersion: async (userId: string) => { databaseCalls.push(userId); throw new Error("unexpected version read"); },
    mutate: async (userId: string) => { databaseCalls.push(userId); throw new Error("unexpected mutation"); },
  } as WorkspaceStore;
  const mcpModule = { exports: {} as typeof import("../lib/mcp") };
  vm.runInNewContext(compiled, {
    module: mcpModule, exports: mcpModule.exports, Response, TextDecoder, URL,
    require: (name: string) => {
      assert.equal(name, "./study-tools");
      return { STUDY_TOOLS: tools, callStudyTool: async (...args: unknown[]) => { calls.push(args); return handler(...args); } };
    },
  });
  return { calls, databaseCalls, store, send: (request: Request) => mcpModule.exports.handleMcpRequest(request, store) };
}

function request(body: unknown = { jsonrpc: "2.0", id: 1, method: "server/discover" }, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-id": "scoped-user-123", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("MCP requires trusted Sites identity and ignores browser mock cookies", async () => {
  const app = setup();
  const req = request(undefined, { cookie: "__sites_local_auth=1" });
  req.headers.delete("oai-authenticated-user-id");
  const response = await app.send(req);
  assert.equal(response.status, 401);
  assert.equal((await parsed(response)).error.code, -32001);
  assert.equal(app.calls.length, 0);
  assert.equal(app.databaseCalls.length, 0);
});

test("MCP discovery, tool listing, legacy initialization and ping never read workspace data", async () => {
  const app = setup();
  const discovery = await app.send(request());
  assert.deepEqual(await discovery.json(), { jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
  assert.equal(discovery.headers.get("cache-control"), "private, no-store");
  const listed = await app.send(request({ jsonrpc: "2.0", id: "list", method: "tools/list" }));
  assert.deepEqual((await parsed(listed)).result.tools, tools);
  const initialized = await app.send(request({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
  assert.equal((await parsed(initialized)).result.protocolVersion, "2025-11-25");
  const ping = await app.send(request({ jsonrpc: "2.0", id: null, method: "ping" }));
  assert.deepEqual(await ping.json(), { jsonrpc: "2.0", id: null, result: {} });
  assert.equal(app.calls.length, 0);
  assert.equal(app.databaseCalls.length, 0);
});

test("MCP forwards the exact authenticated user, arguments and store to the tool boundary", async () => {
  const app = setup();
  const params = { name: "study_update", arguments: { taskId: "task-1", title: "课程复习", userId: "untrusted-argument" } };
  const response = await app.send(request({ jsonrpc: "2.0", id: "update-1", method: "tools/call", params }));
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: "update-1", result: { content: [{ type: "text", text: "ok" }] } });
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0][0], "study_update");
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0][1])), params.arguments);
  assert.equal(app.calls[0][2], "scoped-user-123");
  assert.equal(app.calls[0][3], app.store);
});

test("MCP accepts authenticated remote calls without Origin and rejects cross-site browser requests", async () => {
  const app = setup();
  const foreignHeaders: Record<string, string>[] = [{ origin: "https://foreign.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }];
  for (const headers of foreignHeaders) {
    const response = await app.send(request(undefined, headers));
    assert.equal(response.status, 403);
  }
  assert.equal((await app.send(request())).status, 200);
  assert.equal((await app.send(request(undefined, { origin: ORIGIN }))).status, 200);
  assert.equal(app.calls.length, 0);
});

test("MCP notifications cannot run tools or mutate data", async () => {
  const app = setup();
  for (const method of ["notifications/initialized", "tools/call", "unknown"]) {
    const response = await app.send(request({ jsonrpc: "2.0", method, params: { name: "study_update", arguments: { title: "must not save" } } }));
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
  assert.equal(app.calls.length, 0);
  assert.equal(app.databaseCalls.length, 0);
});

test("MCP rejects malformed JSON-RPC, batches and invalid tool arguments without dispatch", async () => {
  const app = setup();
  const invalid = [null, [], [{ jsonrpc: "2.0", id: 1, method: "tools/call" }], {}, { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: true, method: "ping" }, { jsonrpc: "2.0", id: 1, method: "" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: [] },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing" } },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "study_update", arguments: null } },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "study_update", arguments: [] } }];
  for (const body of invalid) {
    const response = await app.send(request(body));
    assert.equal(response.status, 400);
    assert.ok([-32600, -32602].includes((await parsed(response)).error.code));
  }
  const parseError = await app.send(request("{"));
  assert.equal((await parsed(parseError)).error.code, -32700);
  const methodError = await app.send(request({ jsonrpc: "2.0", id: "missing", method: "unknown" }));
  assert.deepEqual(await methodError.json(), { jsonrpc: "2.0", id: "missing", error: { code: -32601, message: "不支持这个 MCP 方法" } });
  assert.equal(app.calls.length, 0);
  assert.equal(app.databaseCalls.length, 0);
});

test("MCP rejects oversized bodies by actual bytes with or without Content-Length", async () => {
  const app = setup();
  const large = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "study_update", arguments: { notes: "课".repeat(43_000) } } };
  assert.equal((await app.send(request(large))).status, 413);
  assert.equal((await app.send(request(undefined, { "content-length": "128001" }))).status, 413);
  const allowed = { ...large, params: { ...large.params, arguments: { notes: "课".repeat(20_000) } } };
  assert.equal((await app.send(request(allowed))).status, 200);
  assert.equal(app.calls.length, 1);
});

test("MCP checks method and JSON media type", async () => {
  const app = setup();
  const get = await app.send(new Request(`${ORIGIN}/mcp`));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await app.send(request(undefined, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await app.send(request(undefined, { "content-type": "application/jsonp" }))).status, 415);
  assert.equal((await app.send(request(undefined, { "content-type": "Application/JSON; charset=utf-8" }))).status, 200);
  assert.equal(app.calls.length, 0);
});

test("MCP preserves tool business errors and hides unexpected exception details", async () => {
  const payload = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "study_update" } };
  const business = setup(async () => ({ isError: true, content: [{ type: "text", text: "任务正在计时，请先结束计时" }] }));
  const response = await business.send(request(payload));
  assert.equal(response.status, 200);
  assert.equal((await parsed(response)).result.isError, true);
  const failing = setup(async () => { throw new Error("database password and private data"); });
  const failedResponse = await failing.send(request(payload));
  assert.equal(failedResponse.status, 500);
  const body = await parsed(failedResponse);
  assert.equal(body.error.code, -32603);
  assert.equal(JSON.stringify(body).includes("password"), false);
});

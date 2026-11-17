import assert from "node:assert/strict";

// Run only against the built Worker with a NEW --local --persist-to QA directory.
// Every request uses synthetic identities; never use a real Site token or cookie.
const base = process.env.STUDY_MCP_QA_URL || "http://127.0.0.1:8788";
assert.equal(new URL(base).hostname, "127.0.0.1");
const user = `qa_dot_${Date.now()}`;
const headers = (identity = user) => ({ "content-type": "application/json", ...(identity ? { "oai-authenticated-user-id": identity, "oai-authenticated-user-email": `${identity}@example.invalid` } : {}) });
let sequence = 0;
let localProxyRetries = 0;
async function localFetch(url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    const text = await response.text();
    // Windows Wrangler's development proxy can restart after early rejections.
    // Retry ONLY that exact proxy response with the exact same request, never an
    // application error or revision conflict. Mutation IDs and payloads stay fixed.
    if (attempt < 2 && response.status === 503 && response.headers.get("retry-after") === "0" && text.startsWith("Your worker restarted mid-request.")) {
      localProxyRetries++;
      continue;
    }
    return new Response(text, { status: response.status, headers: response.headers });
  }
}
async function rpc(method, params, identity = user, extra = {}) {
  const response = await localFetch(`${base}/mcp`, { method: "POST", headers: { ...headers(identity), ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, ...(params ? { params } : {}) }) });
  return { status: response.status, body: await response.json() };
}
async function call(name, args = {}, identity = user) {
  const response = await rpc("tools/call", { name, arguments: args }, identity);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.result, JSON.stringify(response.body));
  return { error: response.body.result.isError === true, ...JSON.parse(response.body.result.content[0].text) };
}
async function browserGet(identity = user) {
  const response = await localFetch(`${base}/api/workspace`, { headers: headers(identity) });
  return { status: response.status, body: await response.json() };
}
async function browserPost(baseRevision, commands) {
  const response = await localFetch(`${base}/api/workspace`, { method: "POST", headers: { ...headers(), origin: base }, body: JSON.stringify({ baseRevision, mutationId: crypto.randomUUID(), commands }) });
  return { status: response.status, body: await response.json() };
}
const passed = [];
function pass(label) { passed.push(label); }

assert.equal((await rpc("server/discover", undefined, "")).status, 401);
assert.equal((await rpc("tools/list", undefined, user, { origin: "https://foreign.invalid" })).status, 403);
assert.equal((await browserGet("")).status, 401);
pass("unauthenticated requests and foreign browser origins rejected");
assert.deepEqual((await rpc("server/discover")).body.result.supportedVersions, ["2026-07-28"]);
assert.equal((await rpc("tools/list")).body.result.tools.length, 6);
pass("built Worker advertises six MCP tools");

const empty = await call("list_study_projects");
assert.equal(empty.revision, 0);
assert.equal(empty.projects.length, 3);
const create = { expectedRevision: 0, operationId: crypto.randomUUID(), projectId: "english", title: "隔离 QA 六级阅读", notes: "仅用于测试" };
const first = await call("create_study_task", create);
assert.equal(first.error, false, JSON.stringify(first));
assert.equal(first.revision, 1);
const retry = await call("create_study_task", create);
assert.equal(retry.revision, 1);
assert.equal(retry.task.id, first.task.id);
assert.equal((await browserGet()).body.state.tasks[0].notes, "仅用于测试");
pass("MCP creates in D1, exact retry deduplicates, browser reads same task");

const browserEdit = await browserPost(1, [{ type: "task.update", id: first.task.id, title: "网页更新后的名称", at: Date.now() }]);
assert.equal(browserEdit.status, 200);
const stale = await call("update_study_task", { expectedRevision: 1, operationId: crypto.randomUUID(), taskId: first.task.id, title: "旧版本修改" });
assert.equal(stale.code, "REVISION_CONFLICT");
assert.equal(stale.error, true);
assert.equal(stale.task.title, "网页更新后的名称");
const delayed = await call("create_study_task", create);
assert.equal(delayed.code, "REVISION_CONFLICT");
assert.equal((await call("list_study_tasks")).total, 1);
pass("browser edits are visible to MCP; stale writes and delayed retries do not overwrite or duplicate");

const changed = await call("update_study_task", { expectedRevision: 2, operationId: crypto.randomUUID(), taskId: first.task.id, status: "done", pinned: true });
assert.equal(changed.error, false);
assert.equal(changed.task.title, "网页更新后的名称");
assert.equal(changed.task.notes, "仅用于测试");
assert.equal((await browserGet()).body.state.tasks[0].status, "done");
const archived = await call("update_study_task", { expectedRevision: 3, operationId: crypto.randomUUID(), taskId: first.task.id, archived: true });
assert.equal(archived.error, false);
assert.equal((await call("list_study_tasks")).total, 0);
assert.equal((await call("list_study_tasks", { archived: "archived" })).total, 1);
const restored = await call("update_study_task", { expectedRevision: 4, operationId: crypto.randomUUID(), taskId: first.task.id, archived: false, status: "todo" });
assert.equal(restored.error, false);
pass("partial edits, completion, archive and restore preserve task content");

const competing = await Promise.all([
  call("update_study_task", { expectedRevision: 5, operationId: crypto.randomUUID(), taskId: first.task.id, title: "MCP 并发写入" }),
  browserPost(5, [{ type: "task.update", id: first.task.id, title: "网页并发写入", at: Date.now() }]),
]);
assert.equal(Number(!competing[0].error) + Number(competing[1].status === 200), 1);
const latest = (await browserGet()).body;
assert.equal(latest.revision, 6);
pass("simultaneous MCP and browser writes have exactly one winner in actual local D1");

const start = await browserPost(6, [{ type: "session.start", id: "qa_session", taskId: first.task.id, mode: "free", targetMs: 0, at: Date.now() }]);
assert.equal(start.status, 200);
const blocked = await call("update_study_task", { expectedRevision: 7, operationId: crypto.randomUUID(), taskId: first.task.id, archived: true });
assert.equal(blocked.error, true);
assert.equal(blocked.code, "INVALID_OPERATION");
assert.equal((await browserGet()).body.revision, 7);
const stats = await call("get_study_statistics", { rangeDays: 7 });
assert.equal(stats.timeZone, "Asia/Shanghai");
assert.equal(stats.durationUnit, "milliseconds");
assert.equal(stats.days.length, 7);
pass("running timer protected and statistics retain timezone and units");

const other = await call("list_study_tasks", {}, `${user}_other`);
assert.equal(other.total, 0);
assert.equal(other.revision, 0);
const foreign = await call("get_study_task", { taskId: first.task.id }, `${user}_other`);
assert.equal(foreign.error, true);
const injection = await call("list_study_tasks", { userId: user }, `${user}_other`);
assert.equal(injection.error, true);
pass("account isolation and rejection of caller-supplied identity");

console.log(JSON.stringify({ passed: passed.length, checks: passed, localProxyRetries, scope: "isolated local built Worker and D1; synthetic accounts only" }, null, 2));

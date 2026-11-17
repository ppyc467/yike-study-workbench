import assert from "node:assert/strict";

// Local integration exercise only. This never deletes or resets the database.
const base = process.env.STUDY_QA_URL || "http://127.0.0.1:5173";
assert.equal(new URL(base).hostname, "127.0.0.1", "API smoke is restricted to the local preview");
const cookie = "__sites_local_auth=1";
const run = `qa_${Date.now()}`;
const taskId = `${run}_task`;
const sessionIds = [`${run}_session_a`, `${run}_session_b`];
const created = { taskId, sessionIds: [] };

async function get(authenticated = true) {
  const response = await fetch(`${base}/api/workspace`, { headers: authenticated ? { Cookie: cookie } : {} });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function post(body, { authenticated = true, origin = base, raw = false } = {}) {
  const response = await fetch(`${base}/api/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { error: text }; }
  return { status: response.status, body: result };
}

function log(message) { console.log(`PASS ${message}`); }

let snapshot;
try {
  assert.equal((await get(false)).status, 401);
  assert.equal((await post({}, { authenticated: false })).status, 401);
  log("anonymous GET and POST return 401");

  const empty = await get();
  assert.equal(empty.status, 200);
  assert.equal(empty.body.revision, 0, "Requires an untouched local QA workspace");
  assert.equal(empty.body.storage, "local");
  assert.deepEqual(empty.body.state.tasks, []);
  assert.deepEqual(empty.body.state.sessions, []);
  assert.match(empty.headers.get("cache-control"), /no-store/);
  snapshot = empty.body;
  log("authenticated GET returns revision 0, empty study data, no-store");

  assert.equal((await post({}, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await post({}, { origin: null })).status, 403);
  log("foreign and missing origins return 403");

  assert.equal((await post("{broken", { raw: true })).status, 422);
  assert.equal((await post({ baseRevision: 0, mutationId: `${run}_invalid`, commands: [{ type: "settings.goal", at: Date.now(), minutes: 60, unknown: true }] })).status, 422);
  assert.equal((await post({ baseRevision: 0, mutationId: `${run}_future`, commands: [{ type: "settings.goal", at: Date.now() + 120_000, minutes: 60 }] })).status, 422);
  assert.equal((await post("x".repeat(384_001), { raw: true })).status, 422);
  assert.equal((await get()).body.revision, 0);
  log("malformed, unknown-field, future-time, oversized requests leave the database unchanged");

  const add = await post({ baseRevision: 0, mutationId: `${run}_add`, commands: [{ type: "task.add", at: Date.now(), id: taskId, title: "QA 临时计时验证", projectId: "course" }] });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.revision, 1);
  assert.equal(add.body.state.tasks[0].id, taskId);
  snapshot = add.body;
  log("normal task save persists at revision 1");

  const at = Date.now();
  const flights = sessionIds.map((id, index) => ({
    baseRevision: 1,
    mutationId: `${run}_start_${index}`,
    commands: [{ type: "session.start", at, id, taskId, mode: "free", targetMs: 0 }],
  }));
  const results = await Promise.all(flights.map((flight) => post(flight)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409], JSON.stringify(results));
  const winnerIndex = results.findIndex((result) => result.status === 200);
  const winner = results[winnerIndex];
  const conflict = results.find((result) => result.status === 409);
  snapshot = winner.body;
  created.sessionIds.push(sessionIds[winnerIndex]);
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.state.sessions.length, 1);
  assert.equal(snapshot.state.activeSessionId, sessionIds[winnerIndex]);
  assert.equal(conflict.body.revision, 2);
  assert.deepEqual(conflict.body.state, snapshot.state);
  log("two simultaneous starts at the same revision yield one 200 and one 409; exactly one active session");

  const duplicate = await post(flights[winnerIndex]);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.revision, 2);
  assert.deepEqual(duplicate.body.state, snapshot.state);
  log("retrying the successful mutation is idempotent without incrementing revision");

  const finishFlight = { baseRevision: 2, mutationId: `${run}_finish`, commands: [{ type: "session.finish", at: Date.now() }] };
  const finished = await post(finishFlight);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  snapshot = finished.body;
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.state.activeSessionId, null);
  assert.equal(typeof snapshot.state.sessions[0].finishedAt, "number");
  const reloaded = await get();
  assert.deepEqual(reloaded.body.state, snapshot.state);
  assert.equal(reloaded.body.revision, 3);
  log("finish persists at revision 3 and reload restores the stopped session");
  console.log(JSON.stringify({ finalRevision: snapshot.revision, activeSessionId: snapshot.state.activeSessionId, ...created }));
} catch (error) {
  // Preserve useful evidence and leave a running QA timer stopped when possible.
  try {
    const latest = await get();
    if (sessionIds.includes(latest.body.state?.activeSessionId)) {
      await post({ baseRevision: latest.body.revision, mutationId: `${run}_cleanup`, commands: [{ type: "session.finish", at: Date.now() }] });
    }
    console.error("QA data retained for inspection:", JSON.stringify({ ...created, snapshot: (await get()).body }));
  } catch { /* Original failure remains visible if the server is unavailable. */ }
  throw error;
}

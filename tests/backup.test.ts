import test from "node:test";
import assert from "node:assert/strict";
import type { Command, Workspace } from "../lib/study";

const study = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
const { parseBackup, prepareRestore } = await import(new URL("../lib/backup.ts", import.meta.url).href) as typeof import("../lib/backup");
const T = Date.parse("2026-11-10T10:00:00+08:00");
function ready(): Workspace {
  return study.applyCommand(study.initialWorkspace(), { type: "task.add", id: "task-a", projectId: "course", title: "练习", at: T });
}
const run = (state: Workspace, commands: Command[]) => commands.reduce(study.applyCommand, state);

test("old backup format replays queued edits without mutating its source", () => {
  const state = ready();
  const pending: Command[] = [{ type: "task.update", id: "task-a", notes: "离线笔记", at: T + 1 }];
  const parsed = parseBackup({ base: { state, serverNow: T }, pending, exportedAt: new Date(T + 2).toISOString() });
  assert.equal(parsed.state.tasks[0].notes, "离线笔记");
  assert.equal(state.tasks[0].notes, "");
  assert.equal(parsed.exportedAt, T + 2);
});

test("restore remaps linked notes, review cards, conversations and reference drafts", () => {
  let source = ready();
  source = study.applyCommand(source, { type: "note.add", id: "note-a", projectId: "course", taskId: "task-a", title: "材料", body: "接口", at: T + 1 });
  source = study.applyCommand(source, { type: "review.add", cards: [{ id: "card-a", taskId: "task-a", sourceNoteId: "note-a", question: "问", answer: "答" }], at: T + 2 });
  const backup = parseBackup({ state: source, conversations: [{ taskId: "task-a", memory: "进度", messages: [] }], chatDrafts: [{ taskId: "task-a", draft: { taskId: "task-a", draft: "待提问", excerpt: "重点", selectedNoteIds: ["note-a"], operation: { operationId: "old-operation", message: "问题", selectedNoteIds: ["note-a"] } } }] });
  let next = 0;
  const plan = prepareRestore(ready(), backup, ["task-a"], false, () => `fresh-${++next}`);
  const restored = run(ready(), plan.commands);
  assert.equal(restored.tasks.length, 2);
  assert.equal(restored.tasks[0].title, "练习");
  const taskId = plan.taskIds.get("task-a")!;
  const note = restored.notes!.find(note => note.taskId === taskId)!;
  assert.equal(restored.reviews![0].taskId, taskId);
  assert.equal(restored.reviews![0].sourceNoteId, note.id);
  assert.equal((plan.conversations[0] as { taskId: string }).taskId, taskId);
  assert.deepEqual(plan.chatDrafts[0].draft.selectedNoteIds, [note.id]);
  assert.equal(plan.chatDrafts[0].draft.excerpt, "重点");
  assert.deepEqual((plan.chatDrafts[0].draft.operation as { selectedNoteIds: string[] }).selectedNoteIds, [note.id]);
  assert.deepEqual(run(restored, plan.commands), restored);
});

test("restore closes an exported unfinished session while preserving the live timer", () => {
  const source = study.applyCommand(ready(), { type: "session.start", id: "old-session", taskId: "task-a", mode: "free", targetMs: 0, at: T });
  const current = study.applyCommand(ready(), { type: "session.start", id: "live-session", taskId: "task-a", mode: "free", targetMs: 0, at: T + 120000 });
  let next = 0;
  const plan = prepareRestore(current, parseBackup({ state: source, exportedAt: new Date(T + 60000).toISOString() }), ["task-a"], false, () => `fresh-${++next}`);
  const restored = run(current, plan.commands);
  assert.equal(restored.activeSessionId, "live-session");
  assert.deepEqual(restored.sessions.find(session => session.id === "live-session"), current.sessions[0]);
  const historical = restored.sessions.find(session => session.id !== "live-session")!;
  assert.equal(historical.finishedAt, T + 60000);
  assert.equal(historical.segments[0].end, T + 60000);
});

test("large valid notes restore through bounded replayable command portions", () => {
  let source = ready();
  for (let index = 0; index < 4; index++) source = study.applyCommand(source, { type: "note.add", id: `note-${index}`, projectId: "course", taskId: "task-a", title: "长笔记", body: "学".repeat(50000), at: T + index });
  let next = 0;
  const current = study.initialWorkspace();
  const plan = prepareRestore(current, parseBackup({ state: source }), ["task-a"], false, () => `fresh-${++next}`);
  assert.ok(plan.commands.length > 1);
  for (const command of plan.commands) assert.ok(new TextEncoder().encode(JSON.stringify(command)).length < 320000);
  assert.equal(run(current, plan.commands).notes!.length, 4);
});

test("invalid backup references and malformed segments fail before constructing a restore", () => {
  const dangling = ready();
  dangling.tasks[0].projectId = "missing-project";
  assert.throws(() => parseBackup({ state: dangling }));
  const invalid = ready();
  invalid.sessions.push({ id: "bad-session", taskId: "task-a", mode: "free", targetMs: 0, segments: [{ start: T + 1, end: T }], finishedAt: T });
  assert.throws(() => parseBackup({ state: invalid }));
  assert.throws(() => prepareRestore(ready(), parseBackup({ state: ready() }), [], false));
});

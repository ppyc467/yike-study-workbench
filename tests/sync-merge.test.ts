import test from "node:test";
import assert from "node:assert/strict";
import type { Command, Workspace } from "../lib/study";

const study = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
const { rebaseCommands } = await import(new URL("../lib/sync-merge.ts", import.meta.url).href) as typeof import("../lib/sync-merge");
const T = Date.parse("2026-11-10T10:00:00+08:00");
function ready(): Workspace {
  return study.applyCommand(study.initialWorkspace(), { type: "task.add", id: "task-a", projectId: "course", title: "原名称", at: T });
}
const run = (state: Workspace, commands: Command[]) => commands.reduce(study.applyCommand, state);

test("independent edits merge while preserving both devices' fields", () => {
  const base = ready();
  const remote = study.applyCommand(base, { type: "task.update", id: "task-a", title: "远端名称", at: T + 1 });
  const local: Command[] = [{ type: "task.update", id: "task-a", notes: "本机笔记", at: T + 2 }];
  const result = rebaseCommands(base, remote, local);
  assert.deepEqual(result.differences, []);
  const task = run(remote, result.commands).tasks[0];
  assert.equal(task.title, "远端名称");
  assert.equal(task.notes, "本机笔记");
});

test("competing field edits require a choice and preferLocal retains only the requested local field", () => {
  const base = ready();
  const remote = study.applyCommand(base, { type: "task.update", id: "task-a", title: "远端名称", notes: "远端笔记", at: T + 1 });
  const local: Command[] = [{ type: "task.update", id: "task-a", title: "本机名称", at: T + 2 }];
  const conflict = rebaseCommands(base, remote, local);
  assert.equal(conflict.differences.length, 1);
  assert.equal(conflict.commands.length, 0);
  const chosen = rebaseCommands(base, remote, local, true);
  const task = run(remote, chosen.commands).tasks[0];
  assert.equal(task.title, "本机名称");
  assert.equal(task.notes, "远端笔记");
});

test("undefined update fields follow applyCommand's unchanged-field behavior", () => {
  const base = ready();
  const remote = study.applyCommand(base, { type: "task.update", id: "task-a", title: "远端名称", at: T + 1 });
  const result = rebaseCommands(base, remote, [{ type: "task.update", id: "task-a", title: undefined, notes: "本机笔记", at: T + 2 }]);
  assert.deepEqual(result.differences, []);
  assert.equal(result.commands.length, 1);
});

test("deleting a task detects review answers added on another device", () => {
  let base = ready();
  base = study.applyCommand(base, { type: "review.add", cards: [{ id: "card-a", taskId: "task-a", question: "问", answer: "答" }], at: T + 1 });
  const remote = study.applyCommand(base, { type: "review.rate", id: "card-a", attemptId: "attempt-a", expectedDueAt: T + 1, rating: "good", response: "已作答", at: T + 2 });
  const result = rebaseCommands(base, remote, [{ type: "task.delete", id: "task-a", at: T + 3 }]);
  assert.ok(result.differences.length > 0);
  assert.equal(result.commands.length, 0);
});

test("already-applied additions and deletions do not repeat their effects", () => {
  const base = ready();
  const add: Command = { type: "note.add", id: "note-a", projectId: "course", taskId: "task-a", title: "笔记", at: T + 1 };
  const remote = study.applyCommand(base, add);
  const added = rebaseCommands(base, remote, [add]);
  assert.deepEqual(added.commands, []);
  assert.deepEqual(added.differences, []);
  const deletion: Command = { type: "note.delete", id: "note-a", at: T + 2 };
  const deleted = rebaseCommands(remote, study.applyCommand(remote, deletion), [deletion]);
  assert.deepEqual(deleted.commands, []);
  assert.deepEqual(deleted.differences, []);
});

test("a second device's active timer prevents an automatic timer rebase", () => {
  const base = ready();
  const remote = study.applyCommand(base, { type: "session.start", id: "remote-session", taskId: "task-a", mode: "free", targetMs: 0, at: T + 1 });
  const result = rebaseCommands(base, remote, [{ type: "session.start", id: "local-session", taskId: "task-a", mode: "free", targetMs: 0, at: T + 2 }]);
  assert.ok(result.differences.length > 0);
  assert.equal(result.commands.length, 0);
});

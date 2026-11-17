import test from "node:test";
import assert from "node:assert/strict";
import type { Command, Workspace } from "../lib/study";

// Dynamic URL keeps native Node TypeScript execution and the app's bundler happy.
const { initialWorkspace, applyCommand, sessionElapsedMs, effectiveSessionSegments, totalsByDay, dayKey, validateCommand } = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
const MINUTE = 60_000;
const T = Date.parse("2026-10-23T10:00:00+08:00");

function ready(): Workspace {
  return applyCommand(initialWorkspace(), { type: "task.add", id: "task-1", projectId: "course", title: "完成练习", at: T });
}
function start(state = ready(), mode: "free" | "pomodoro" = "free", at = T): Workspace {
  return applyCommand(state, { type: "session.start", id: "session-1", taskId: "task-1", mode, targetMs: mode === "free" ? 0 : 25 * MINUTE, at });
}
function act(state: Workspace, type: "session.pause" | "session.resume" | "session.finish", minutes: number): Workspace {
  return applyCommand(state, { type, at: T + minutes * MINUTE });
}

test("initial workspace contains no invented tasks or study time", () => {
  const state = initialWorkspace();
  assert.equal(state.tasks.length, 0);
  assert.deepEqual(state.notes, []);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.activeSessionId, null);
  assert.deepEqual(totalsByDay(state, T), {});
});

test("wall-clock continuation survives serialization and pause time is excluded", () => {
  let state = start();
  const original = structuredClone(state);
  state = act(state, "session.pause", 10);
  assert.deepEqual(original.sessions[0].segments, [{ start: T, end: null }], "applyCommand must not mutate its source");
  assert.equal(sessionElapsedMs(state.sessions[0], T + 30 * MINUTE), 10 * MINUTE);
  state = act(state, "session.resume", 30);
  const reopened = JSON.parse(JSON.stringify(state)) as Workspace;
  assert.equal(sessionElapsedMs(reopened.sessions[0], T + 45 * MINUTE), 25 * MINUTE);
  state = act(reopened, "session.finish", 45);
  assert.equal(state.activeSessionId, null);
  assert.equal(sessionElapsedMs(state.sessions[0], T + 120 * MINUTE), 25 * MINUTE);
});

test("pomodoro caps cumulative study segments and stores the exact auto-finish instant", () => {
  let state = start(ready(), "pomodoro");
  state = act(state, "session.pause", 10);
  state = act(state, "session.resume", 30);
  assert.equal(sessionElapsedMs(state.sessions[0], T + 200 * MINUTE), 25 * MINUTE);
  assert.deepEqual(effectiveSessionSegments(state.sessions[0], T + 200 * MINUTE), [
    { start: T, end: T + 10 * MINUTE },
    { start: T + 30 * MINUTE, end: T + 45 * MINUTE },
  ]);
  state = act(state, "session.finish", 200);
  assert.equal(state.sessions[0].finishedAt, T + 45 * MINUTE);
  assert.equal(state.activeSessionId, null);
});

test("starting another session finalizes an expired pomodoro without double counting", () => {
  let state = start(ready(), "pomodoro");
  state = applyCommand(state, { type: "session.start", id: "session-2", taskId: "task-1", mode: "free", targetMs: 0, at: T + 60 * MINUTE });
  assert.equal(state.activeSessionId, "session-2");
  assert.equal(state.sessions[0].finishedAt, T + 25 * MINUTE);
  assert.equal(totalsByDay(state, T + 70 * MINUTE)["2026-10-23"], 35 * MINUTE);
});

test("a second active session cannot start while running or paused", () => {
  const state = start();
  const command: Command = { type: "session.start", id: "session-2", taskId: "task-1", mode: "free", targetMs: 0, at: T + 20 * MINUTE };
  assert.throws(() => applyCommand(state, command), /已有计时/);
  assert.throws(() => applyCommand(act(state, "session.pause", 10), command), /已有计时/);
});

test("daily totals split at Shanghai midnight regardless of host timezone", () => {
  const midnightStart = Date.parse("2026-10-23T23:50:00+08:00");
  const state = start(ready(), "free", midnightStart);
  const now = Date.parse("2026-10-24T00:20:00+08:00");
  assert.equal(dayKey(midnightStart), "2026-10-23");
  assert.equal(dayKey(now), "2026-10-24");
  assert.deepEqual(totalsByDay(state, now), { "2026-10-23": 10 * MINUTE, "2026-10-24": 20 * MINUTE });
});

test("pomodoro ending at midnight has no phantom next-day time", () => {
  const t = Date.parse("2026-10-23T23:35:00+08:00");
  const state = start(ready(), "pomodoro", t);
  assert.deepEqual(totalsByDay(state, t + 100 * MINUTE), { "2026-10-23": 25 * MINUTE });
});

test("multi-day free sessions split every day and sum to total elapsed", () => {
  const t = Date.parse("2026-10-23T23:50:00+08:00");
  const state = start(ready(), "free", t);
  const now = t + 2000 * MINUTE;
  const totals = totalsByDay(state, now);
  assert.deepEqual(totals, { "2026-10-23": 10 * MINUTE, "2026-10-24": 1440 * MINUTE, "2026-10-25": 550 * MINUTE });
  assert.equal(Object.values(totals).reduce((a, b) => a + b, 0), sessionElapsedMs(state.sessions[0], now));
});

test("shortening a finished record preserves pause boundaries and removes time from tail", () => {
  let state = start();
  state = act(state, "session.pause", 10);
  state = act(state, "session.resume", 30);
  state = act(state, "session.finish", 50);
  state = applyCommand(state, { type: "session.correct", id: "session-1", minutes: 15, at: T + 60 * MINUTE });
  assert.deepEqual(state.sessions[0].segments, [
    { start: T, end: T + 10 * MINUTE },
    { start: T + 30 * MINUTE, end: T + 35 * MINUTE },
  ]);
  assert.equal(sessionElapsedMs(state.sessions[0], T + 60 * MINUTE), 15 * MINUTE);
});

test("correction can reach zero and increase again without losing original start", () => {
  let state = act(start(), "session.finish", 20);
  state = applyCommand(state, { type: "session.correct", id: "session-1", minutes: 0, at: T + 30 * MINUTE });
  assert.equal(sessionElapsedMs(state.sessions[0], T + 30 * MINUTE), 0);
  state = applyCommand(state, { type: "session.correct", id: "session-1", minutes: 10, at: T + 30 * MINUTE });
  assert.equal(sessionElapsedMs(state.sessions[0], T + 30 * MINUTE), 10 * MINUTE);
  assert.equal(state.sessions[0].segments[0].start, T);
});

test("correction rejects live records, future time, pomodoro overflow and overlap", () => {
  assert.throws(() => applyCommand(start(), { type: "session.correct", id: "session-1", minutes: 5, at: T + 10 * MINUTE }), /已结束/);
  let state = act(start(), "session.finish", 20);
  assert.throws(() => applyCommand(state, { type: "session.correct", id: "session-1", minutes: 40, at: T + 30 * MINUTE }), /当前时间/);
  state = applyCommand(state, { type: "session.start", id: "session-2", taskId: "task-1", mode: "free", targetMs: 0, at: T + 30 * MINUTE });
  assert.throws(() => applyCommand(state, { type: "session.correct", id: "session-1", minutes: 40, at: T + 50 * MINUTE }), /重叠/);
  const pomodoro = act(start(ready(), "pomodoro"), "session.finish", 25);
  assert.throws(() => applyCommand(pomodoro, { type: "session.correct", id: "session-1", minutes: 30, at: T + 50 * MINUTE }), /目标时长/);
});

test("backward clock commands cannot produce inverted or overlapping segments", () => {
  let state = act(start(), "session.pause", 20);
  assert.throws(() => act(state, "session.resume", 10), /时间发生冲突/);
  state = act(state, "session.finish", 30);
  assert.throws(() => applyCommand(state, { type: "session.start", id: "session-2", taskId: "task-1", mode: "free", targetMs: 0, at: T + 10 * MINUTE }), /开始时间早于/);
  assert.throws(() => applyCommand(state, { type: "session.correct", id: "session-1", minutes: 5, at: T + 10 * MINUTE }), /修正时间早于/);
});

test("commands reject invalid fields, invalid numbers and references", () => {
  for (const command of [
    { type: "task.add", id: "a", projectId: "course", title: "   ", at: T },
    { type: "settings.goal", minutes: NaN, at: T },
    { type: "session.finish", at: T, admin: true },
    { type: "task.update", id: "task-1", status: "deleted", at: T },
    { type: "task.update", id: "task-1", notes: "a".repeat(20_001), at: T },
    { type: "settings.goal", minutes: 60, at: Infinity },
  ]) assert.throws(() => validateCommand(command));
  assert.throws(() => applyCommand(ready(), { type: "task.add", id: "task-1", projectId: "course", title: "重复", at: T }), /已存在/);
  assert.throws(() => applyCommand(ready(), { type: "task.update", id: "task-1", projectId: "missing", at: T }), /不存在/);
});

test("offline command replay produces the same result as live sequential actions", () => {
  const commands: Command[] = [
    { type: "task.add", id: "task-1", projectId: "course", title: "练习", at: T },
    { type: "session.start", id: "session-1", taskId: "task-1", mode: "free", targetMs: 0, at: T },
    { type: "session.pause", at: T + 10 * MINUTE },
    { type: "task.update", id: "task-1", notes: "下次从第二题继续", at: T + 12 * MINUTE },
    { type: "session.resume", at: T + 20 * MINUTE },
    { type: "session.finish", at: T + 35 * MINUTE },
    { type: "task.update", id: "task-1", status: "done", at: T + 36 * MINUTE },
  ];
  const final = commands.reduce(applyCommand, initialWorkspace());
  const serialized = JSON.parse(JSON.stringify(commands)) as Command[];
  assert.deepEqual(serialized.reduce(applyCommand, initialWorkspace()), final);
  assert.equal(sessionElapsedMs(final.sessions[0], T + 100 * MINUTE), 25 * MINUTE);
  assert.equal(final.tasks[0].notes, "下次从第二题继续");
  assert.equal(final.tasks[0].status, "done");
});

test("older tasks without optional flags remain usable and flags survive serialization", () => {
  const legacy = ready();
  assert.equal(legacy.tasks[0].pinned, undefined);
  assert.equal(legacy.tasks[0].archived, undefined);
  assert.equal(start(legacy).activeSessionId, "session-1");
  const updated = applyCommand(legacy, { type: "task.update", id: "task-1", pinned: true, archived: false, at: T });
  const restored = JSON.parse(JSON.stringify(updated)) as Workspace;
  assert.equal(restored.tasks[0].pinned, true);
  assert.equal(restored.tasks[0].archived, false);
  assert.equal(legacy.tasks[0].pinned, undefined, "legacy source stays untouched");
  assert.equal(applyCommand(restored, { type: "task.update", id: "task-1", pinned: false, at: T }).tasks[0].pinned, false);
});

test("archiving preserves task notes and history; restoring allows another session", () => {
  let state = act(start(), "session.finish", 20);
  state = applyCommand(state, { type: "task.update", id: "task-1", notes: "保留复习笔记", pinned: true, status: "done", at: T + 21 * MINUTE });
  const history = structuredClone(state.sessions);
  const task = structuredClone(state.tasks[0]);
  state = applyCommand(state, { type: "task.update", id: "task-1", archived: true, at: T + 22 * MINUTE });
  assert.deepEqual(state.tasks[0], { ...task, archived: true });
  assert.deepEqual(state.sessions, history);
  assert.equal(totalsByDay(state, T + 30 * MINUTE)["2026-10-23"], 20 * MINUTE);
  assert.throws(() => applyCommand(state, { type: "session.start", id: "session-2", taskId: "task-1", mode: "free", targetMs: 0, at: T + 30 * MINUTE }), /先恢复/);
  state = applyCommand(state, { type: "task.update", id: "task-1", archived: false, at: T + 30 * MINUTE });
  state = applyCommand(state, { type: "session.start", id: "session-2", taskId: "task-1", mode: "free", targetMs: 0, at: T + 31 * MINUTE });
  assert.equal(state.activeSessionId, "session-2");
  assert.equal(state.tasks[0].notes, task.notes);
  assert.equal(state.tasks[0].pinned, true);
});

test("running and paused tasks cannot be archived or marked done", () => {
  for (const state of [start(), act(start(), "session.pause", 10)]) {
    const original = structuredClone(state);
    assert.throws(() => applyCommand(state, { type: "task.update", id: "task-1", title: "不应写入", archived: true, at: T + 20 * MINUTE }), /先结束/);
    assert.throws(() => applyCommand(state, { type: "task.update", id: "task-1", status: "done", at: T + 20 * MINUTE }), /先结束/);
    assert.deepEqual(state, original);
    assert.equal(applyCommand(state, { type: "task.update", id: "task-1", pinned: true, notes: "仍可写笔记", at: T + 20 * MINUTE }).tasks[0].pinned, true);
  }
});

test("an expired pomodoro is finalized before archiving or marking its task done", () => {
  const state = applyCommand(start(ready(), "pomodoro"), { type: "task.update", id: "task-1", archived: true, status: "done", at: T + 60 * MINUTE });
  assert.equal(state.activeSessionId, null);
  assert.equal(state.sessions[0].finishedAt, T + 25 * MINUTE);
  assert.equal(state.tasks[0].archived, true);
  assert.equal(state.tasks[0].status, "done");
  assert.equal(sessionElapsedMs(state.sessions[0], T + 60 * MINUTE), 25 * MINUTE);
});

test("task flags reject untrusted non-boolean values", () => {
  for (const field of ["pinned", "archived"]) {
    for (const value of ["true", 1, 0, null, [], {}]) {
      assert.throws(() => validateCommand({ type: "task.update", id: "task-1", [field]: value, at: T }), /状态不正确/);
    }
  }
});

test("project updates rename or recolor only the selected project and preserve its references", () => {
  const state = start();
  const original = structuredClone(state);
  const renamed = applyCommand(state, { type: "project.update", id: "course", title: "  专业课程  ", at: T + MINUTE });
  assert.deepEqual(renamed.projects[0], { ...state.projects[0], title: "专业课程" });
  const recolored = applyCommand(renamed, { type: "project.update", id: "course", color: "#12aBcF", at: T + MINUTE });
  assert.deepEqual(recolored.projects[0], { ...renamed.projects[0], color: "#12aBcF" });
  assert.deepEqual(recolored.projects.slice(1), state.projects.slice(1));
  assert.deepEqual(recolored.tasks, state.tasks);
  assert.deepEqual(recolored.sessions, state.sessions);
  assert.equal(recolored.activeSessionId, state.activeSessionId);
  assert.deepEqual(state, original);
  assert.throws(() => applyCommand(state, { type: "project.update", id: "missing", title: "课程", at: T }), /项目不存在/);
  assert.deepEqual(state, original);
});

test("an empty project can be deleted without changing tasks, history, or remaining projects", () => {
  const state = act(start(), "session.finish", 20);
  const original = structuredClone(state);
  for (const targetProjectId of [undefined, "course"]) {
    const result = applyCommand(state, { type: "project.delete", id: "english", targetProjectId, at: T + 21 * MINUTE });
    assert.deepEqual(result.projects, state.projects.filter((project) => project.id !== "english"));
    assert.deepEqual(result.tasks, state.tasks);
    assert.deepEqual(result.sessions, state.sessions);
    assert.equal(result.activeSessionId, state.activeSessionId);
    assert.deepEqual(state, original);
  }
});

test("deleting a populated project transfers every task, including archived history, without data loss", () => {
  let state = act(start(), "session.finish", 20);
  state = applyCommand(state, { type: "task.update", id: "task-1", notes: "归档后仍需保留的笔记", archived: true, pinned: true, status: "done", at: T + 21 * MINUTE });
  state = applyCommand(state, { type: "task.add", id: "task-2", projectId: "course", title: "待完成任务", at: T + 22 * MINUTE });
  state = applyCommand(state, { type: "task.add", id: "task-3", projectId: "personal", title: "其他项目任务", at: T + 22 * MINUTE });
  const original = structuredClone(state);
  const result = applyCommand(state, { type: "project.delete", id: "course", targetProjectId: "english", at: T + 23 * MINUTE });
  assert.deepEqual(result.projects, state.projects.filter((project) => project.id !== "course"));
  assert.deepEqual(result.tasks, state.tasks.map((task) => task.projectId === "course" ? { ...task, projectId: "english" } : task));
  assert.deepEqual(result.sessions, state.sessions);
  assert.deepEqual(totalsByDay(result, T + 30 * MINUTE), totalsByDay(state, T + 30 * MINUTE));
  assert.equal(totalsByDay(result, T + 30 * MINUTE)["2026-10-23"], 20 * MINUTE);
  assert.ok(result.tasks.every((task) => result.projects.some((project) => project.id === task.projectId)), "all tasks retain a valid project");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, "transferred records survive persistence");
  assert.deepEqual(state, original);
});

test("project deletion preserves running and paused timers so they can continue in the destination", () => {
  for (const mode of ["free", "pomodoro"] as const) {
    for (const paused of [false, true]) {
      const state = paused ? act(start(ready(), mode), "session.pause", 5) : start(ready(), mode);
      const original = structuredClone(state);
      const result = applyCommand(state, { type: "project.delete", id: "course", targetProjectId: "personal", at: T + 10 * MINUTE });
      assert.equal(result.activeSessionId, "session-1");
      assert.equal(result.tasks[0].projectId, "personal");
      assert.deepEqual(result.sessions, state.sessions);
      const resumed = paused ? act(result, "session.resume", 10) : result;
      const finished = act(resumed, "session.finish", 15);
      assert.equal(sessionElapsedMs(finished.sessions[0], T + 30 * MINUTE), (paused ? 10 : 15) * MINUTE);
      assert.equal(finished.activeSessionId, null);
      assert.deepEqual(state, original);
    }
  }
});

test("project deletion rejects missing, same, or nonexistent destinations atomically, even for archived-only tasks", () => {
  const archived = applyCommand(ready(), { type: "task.update", id: "task-1", archived: true, status: "done", at: T });
  const commands: [Command, RegExp][] = [
    [{ type: "project.delete", id: "course", at: T + 60 * MINUTE }, /请选择一个项目/],
    [{ type: "project.delete", id: "course", targetProjectId: "course", at: T + 60 * MINUTE }, /不能是正在删除的项目/],
    [{ type: "project.delete", id: "course", targetProjectId: "missing", at: T + 60 * MINUTE }, /接收任务的项目不存在/],
    [{ type: "project.delete", id: "missing", targetProjectId: "english", at: T + 60 * MINUTE }, /项目不存在/],
  ];
  for (const state of [ready(), archived, start(ready(), "pomodoro")]) {
    const original = structuredClone(state);
    for (const [command, message] of commands) {
      assert.throws(() => applyCommand(state, command), message);
      assert.deepEqual(state, original, "failed deletion cannot change tasks or normalize the source timer");
    }
  }
  const empty = initialWorkspace();
  const original = structuredClone(empty);
  for (const targetProjectId of ["course", "missing"]) {
    assert.throws(() => applyCommand(empty, { type: "project.delete", id: "course", targetProjectId, at: T }), /接收任务的项目/);
    assert.deepEqual(empty, original, "explicit destinations must be valid even for an empty project");
  }
});

test("the last project cannot be deleted whether empty or populated", () => {
  for (let state of [initialWorkspace(), ready()]) {
    state = applyCommand(state, { type: "project.delete", id: "english", at: T });
    state = applyCommand(state, { type: "project.delete", id: "personal", at: T });
    const original = structuredClone(state);
    assert.equal(state.projects.length, 1);
    for (const targetProjectId of [undefined, "course", "missing"]) {
      assert.throws(() => applyCommand(state, { type: "project.delete", id: "course", targetProjectId, at: T }), /至少保留一个学习项目/);
      assert.deepEqual(state, original);
    }
  }
});

test("project commands validate optional values, identifiers, and unknown fields before applying", () => {
  const invalid: unknown[] = [
    ...[null, 42, "", "  ", "a".repeat(161)].map((title) => ({ type: "project.update", id: "course", title, at: T })),
    ...[null, 42, "red", "#abc", "#12345g", "#1234567"].map((color) => ({ type: "project.update", id: "course", color, at: T })),
    ...[null, 42, "", "two words", "a".repeat(101)].flatMap((id) => [
      { type: "project.update", id, title: "课程", at: T },
      { type: "project.delete", id, at: T },
      { type: "project.delete", id: "course", targetProjectId: id, at: T },
    ]),
    { type: "project.update", id: "course", title: "课程", tasks: [], at: T },
    { type: "project.delete", id: "course", deleteTasks: true, at: T },
  ];
  const state = ready();
  const original = structuredClone(state);
  for (const command of invalid) {
    assert.throws(() => validateCommand(command));
    assert.throws(() => applyCommand(state, command as Command));
    assert.deepEqual(state, original);
  }
  assert.doesNotThrow(() => validateCommand({ type: "project.update", id: "course", title: "a".repeat(160), color: "#ABCDEF", at: T }));
  assert.doesNotThrow(() => validateCommand({ type: "project.update", id: "course", at: T }));
  assert.doesNotThrow(() => validateCommand({ type: "project.delete", id: "english", at: T }));
});

test("deleting an untouched task, including the final task, preserves unrelated data and the source", () => {
  let state = act(start(), "session.finish", 10);
  state = applyCommand(state, { type: "task.add", id: "task-2", projectId: "english", title: "测试任务", at: T + 11 * MINUTE });
  const original = structuredClone(state);
  for (const deleteHistory of [undefined, false, true]) {
    const result = applyCommand(state, { type: "task.delete", id: "task-2", deleteHistory, at: T + 12 * MINUTE });
    assert.deepEqual(result.tasks, state.tasks.filter((task) => task.id !== "task-2"));
    assert.deepEqual(result.sessions, state.sessions);
    assert.deepEqual(result.projects, state.projects);
    assert.equal(result.activeSessionId, state.activeSessionId);
    assert.equal(result.goalMinutes, state.goalMinutes);
    assert.deepEqual(state, original);
  }
  const last = applyCommand(ready(), { type: "task.delete", id: "task-1", at: T });
  assert.equal(last.tasks.length, 0);
  assert.deepEqual(last, initialWorkspace());
  assert.throws(() => applyCommand(last, { type: "task.delete", id: "task-1", at: T }), /任务不存在/);
});

test("task deletion requires explicit history confirmation, including zero-minute records, and removes only attached sessions", () => {
  for (const minutes of [0, 20]) {
    let state = act(start(), "session.finish", minutes);
    state = applyCommand(state, { type: "task.update", id: "task-1", notes: "需要一并移除的测试笔记", archived: true, status: "done", at: T + 21 * MINUTE });
    state = applyCommand(state, { type: "task.add", id: "task-2", projectId: "english", title: "保留任务", at: T + 22 * MINUTE });
    state = applyCommand(state, { type: "session.start", id: "session-2", taskId: "task-2", mode: "free", targetMs: 0, at: T + 30 * MINUTE });
    state = act(state, "session.finish", 40);
    const original = structuredClone(state);
    for (const deleteHistory of [undefined, false]) {
      assert.throws(() => applyCommand(state, { type: "task.delete", id: "task-1", deleteHistory, at: T + 50 * MINUTE }), /确认同时删除学习记录/);
      assert.deepEqual(state, original, "an unconfirmed deletion cannot remove notes or records");
    }
    const result = applyCommand(state, { type: "task.delete", id: "task-1", deleteHistory: true, at: T + 50 * MINUTE });
    assert.deepEqual(result.tasks, state.tasks.filter((task) => task.id !== "task-1"));
    assert.deepEqual(result.sessions, state.sessions.filter((session) => session.taskId !== "task-1"));
    assert.deepEqual(result.projects, state.projects);
    assert.equal(result.goalMinutes, state.goalMinutes);
    assert.equal(result.activeSessionId, null);
    assert.equal(totalsByDay(result, T + 60 * MINUTE)["2026-10-23"], 10 * MINUTE);
    assert.equal(totalsByDay(state, T + 60 * MINUTE)["2026-10-23"], (10 + minutes) * MINUTE);
    assert.ok(result.sessions.every((session) => result.tasks.some((task) => task.id === session.taskId)));
    assert.deepEqual(state, original);
  }
});

test("running and paused tasks reject deletion even with history confirmation while another task remains deletable", () => {
  for (const mode of ["free", "pomodoro"] as const) {
    for (const paused of [false, true]) {
      let state = paused ? act(start(ready(), mode), "session.pause", 5) : start(ready(), mode);
      state = applyCommand(state, { type: "task.add", id: "task-2", projectId: "english", title: "其他测试任务", at: T + 6 * MINUTE });
      const original = structuredClone(state);
      for (const deleteHistory of [undefined, false, true]) {
        assert.throws(() => applyCommand(state, { type: "task.delete", id: "task-1", deleteHistory, at: T + 10 * MINUTE }), /先结束此任务的计时/);
        assert.deepEqual(state, original);
      }
      const result = applyCommand(state, { type: "task.delete", id: "task-2", at: T + 10 * MINUTE });
      assert.equal(result.activeSessionId, "session-1");
      assert.deepEqual(result.sessions, state.sessions);
      assert.deepEqual(result.tasks, state.tasks.filter((task) => task.id !== "task-2"));
      const resumed = paused ? act(result, "session.resume", 10) : result;
      const finished = act(resumed, "session.finish", 15);
      assert.equal(sessionElapsedMs(finished.sessions[0], T + 20 * MINUTE), (paused ? 10 : 15) * MINUTE);
    }
  }
});

test("an expired pomodoro is finalized before confirmed deletion without leaving a dangling active session", () => {
  const source = start(ready(), "pomodoro");
  const original = structuredClone(source);
  assert.throws(() => applyCommand(source, { type: "task.delete", id: "task-1", at: T + 60 * MINUTE }), /确认同时删除学习记录/);
  assert.deepEqual(source, original);
  const result = applyCommand(source, { type: "task.delete", id: "task-1", deleteHistory: true, at: T + 60 * MINUTE });
  assert.equal(result.activeSessionId, null);
  assert.equal(result.tasks.length, 0);
  assert.equal(result.sessions.length, 0);
  assert.deepEqual(totalsByDay(result, T + 60 * MINUTE), {});
  const other = applyCommand(source, { type: "task.add", id: "task-2", projectId: "english", title: "其他任务", at: T + MINUTE });
  const kept = applyCommand(other, { type: "task.delete", id: "task-2", at: T + 60 * MINUTE });
  assert.equal(kept.activeSessionId, null);
  assert.equal(kept.sessions[0].finishedAt, T + 25 * MINUTE);
  assert.equal(sessionElapsedMs(kept.sessions[0], T + 60 * MINUTE), 25 * MINUTE);
});

test("task deletion validates identifiers, confirmation types, and unknown fields before changing state", () => {
  const invalid: unknown[] = [
    ...[null, 42, "", "two words", "a".repeat(101)].map((id) => ({ type: "task.delete", id, at: T })),
    ...[null, "true", 1, 0, [], {}].map((deleteHistory) => ({ type: "task.delete", id: "task-1", deleteHistory, at: T })),
    { type: "task.delete", id: "task-1", all: true, at: T },
    { type: "task.delete", id: "task-1", taskId: "task-2", at: T },
  ];
  const source = ready();
  const original = structuredClone(source);
  for (const command of invalid) {
    assert.throws(() => validateCommand(command));
    assert.throws(() => applyCommand(source, command as Command));
    assert.deepEqual(source, original);
  }
  assert.throws(() => applyCommand(source, { type: "task.delete", id: "missing", deleteHistory: true, at: T }), /任务不存在/);
});

test("serialized offline edit and deletion replay matches live actions without resurrecting the task", () => {
  const commands: Command[] = [
    { type: "task.add", id: "test-task", projectId: "course", title: "测试", at: T },
    { type: "task.update", id: "test-task", title: "改名测试", notes: "离线笔记", at: T + MINUTE },
    { type: "session.start", id: "test-session", taskId: "test-task", mode: "free", targetMs: 0, at: T + 2 * MINUTE },
    { type: "session.pause", at: T + 3 * MINUTE },
    { type: "session.finish", at: T + 4 * MINUTE },
    { type: "task.delete", id: "test-task", deleteHistory: true, at: T + 5 * MINUTE },
    { type: "task.add", id: "real-task", projectId: "english", title: "继续学习", at: T + 6 * MINUTE },
  ];
  const live = commands.reduce(applyCommand, initialWorkspace());
  const serialized = JSON.parse(JSON.stringify(commands)) as Command[];
  const afterReopen = serialized.reduce(applyCommand, initialWorkspace());
  assert.deepEqual(afterReopen, live);
  assert.deepEqual(live.tasks.map((task) => task.id), ["real-task"]);
  assert.deepEqual(live.sessions, []);
  assert.equal(live.activeSessionId, null);
});

test("independent notes can be created, edited, moved and deleted on an older workspace", () => {
  const legacy = ready();
  delete legacy.notes;
  legacy.tasks[0].notes = "保留已有任务笔记";
  const original = structuredClone(legacy);
  let state = applyCommand(legacy, { type: "note.add", id: "note-1", projectId: "course", title: "  树的遍历  ", at: T });
  assert.deepEqual(state.notes, [{
    id: "note-1", projectId: "course", title: "树的遍历", body: "", important: false, createdAt: T, updatedAt: T,
  }]);
  assert.deepEqual(legacy, original);
  state = applyCommand(state, { type: "note.update", id: "note-1", title: "  层序遍历  ", body: "```cpp\nqueue<Node*> nodes;\n```", important: true, projectId: "personal", at: T + MINUTE });
  assert.deepEqual(state.notes?.[0], {
    id: "note-1", projectId: "personal", title: "层序遍历", body: "```cpp\nqueue<Node*> nodes;\n```", important: true, createdAt: T, updatedAt: T + MINUTE,
  });
  const persisted = JSON.parse(JSON.stringify(state)) as Workspace;
  const cleared = applyCommand(persisted, { type: "note.update", id: "note-1", body: "", important: false, at: T - MINUTE });
  assert.equal(cleared.notes?.[0].updatedAt, T + MINUTE, "a backward clock cannot move the note's update time backward");
  assert.equal(cleared.notes?.[0].body, "");
  assert.equal(cleared.notes?.[0].important, false);
  const removed = applyCommand(cleared, { type: "note.delete", id: "note-1", at: T + 2 * MINUTE });
  assert.deepEqual(removed.notes, []);
  assert.deepEqual(removed.tasks, original.tasks);
  assert.deepEqual(removed.sessions, original.sessions);
  assert.deepEqual(removed.projects, original.projects);
  assert.equal(persisted.notes?.[0].body, "```cpp\nqueue<Node*> nodes;\n```", "editing and deletion preserve their source snapshots");
});

test("note commands validate title, body, flags, identifiers and unknown fields", () => {
  const invalid: unknown[] = [
    ...[null, 42, "", "  ", "a".repeat(161)].flatMap(title => [
      { type: "note.add", id: "note-1", projectId: "course", title, at: T },
      { type: "note.update", id: "note-1", title, at: T },
    ]),
    ...[null, 42, [], {}, "a".repeat(50_001)].flatMap(body => [
      { type: "note.add", id: "note-1", projectId: "course", title: "笔记", body, at: T },
      { type: "note.update", id: "note-1", body, at: T },
    ]),
    ...[null, 42, "", "two words", "a".repeat(101)].flatMap(id => [
      { type: "note.add", id, projectId: "course", title: "笔记", at: T },
      { type: "note.update", id, at: T },
      { type: "note.delete", id, at: T },
      { type: "note.add", id: "note-1", projectId: id, title: "笔记", at: T },
      { type: "note.update", id: "note-1", projectId: id, at: T },
    ]),
    ...[null, "true", 1, [], {}].map(important => ({ type: "note.update", id: "note-1", important, at: T })),
    { type: "note.add", id: "note-1", projectId: "course", title: "笔记", important: true, at: T },
    { type: "note.update", id: "note-1", updatedAt: T, at: T },
    { type: "note.delete", id: "note-1", deleteHistory: true, at: T },
  ];
  for (const command of invalid) assert.throws(() => validateCommand(command));
  assert.doesNotThrow(() => validateCommand({ type: "note.add", id: "note-1", projectId: "course", title: "a".repeat(160), body: "学".repeat(50_000), at: T }));
  assert.doesNotThrow(() => validateCommand({ type: "note.update", id: "note-1", body: "", important: false, at: T }));
});

test("note mutations reject missing references and duplicate identifiers atomically", () => {
  const state = applyCommand(start(), { type: "note.add", id: "note-1", projectId: "course", title: "笔记", body: "保留正文", at: T });
  const original = structuredClone(state);
  const invalid: Command[] = [
    { type: "note.add", id: "note-1", projectId: "course", title: "重复", at: T + MINUTE },
    { type: "note.add", id: "note-2", projectId: "missing", title: "无效项目", at: T + MINUTE },
    { type: "note.update", id: "note-1", title: "不应留下", body: "不应保存", projectId: "missing", at: T + MINUTE },
    { type: "note.update", id: "missing", body: "无效", at: T + MINUTE },
    { type: "note.delete", id: "missing", at: T + MINUTE },
  ];
  for (const command of invalid) {
    assert.throws(() => applyCommand(state, command));
    assert.deepEqual(state, original);
  }
  const legacy = ready();
  delete legacy.notes;
  assert.throws(() => applyCommand(legacy, { type: "note.update", id: "missing", body: "无效", at: T }), /笔记不存在/);
  assert.throws(() => applyCommand(legacy, { type: "note.delete", id: "missing", at: T }), /笔记不存在/);
  assert.equal(legacy.notes, undefined);
});

test("deleting a project with only independent notes requires a valid destination and transfers their contents", () => {
  let state = applyCommand(ready(), { type: "note.add", id: "note-1", projectId: "english", title: "阅读笔记", body: "内容", at: T });
  state = applyCommand(state, { type: "note.update", id: "note-1", important: true, at: T + MINUTE });
  state = applyCommand(state, { type: "note.add", id: "note-2", projectId: "personal", title: "其他笔记", body: "其他内容", at: T });
  const original = structuredClone(state);
  for (const targetProjectId of [undefined, "english", "missing"]) {
    assert.throws(() => applyCommand(state, { type: "project.delete", id: "english", targetProjectId, at: T + 2 * MINUTE }));
    assert.deepEqual(state, original);
  }
  const moved = applyCommand(state, { type: "project.delete", id: "english", targetProjectId: "course", at: T + 2 * MINUTE });
  assert.deepEqual(moved.notes, [
    { ...original.notes![0], projectId: "course", updatedAt: T + 2 * MINUTE },
    original.notes![1],
  ]);
  assert.deepEqual(moved.tasks, original.tasks);
  assert.deepEqual(moved.sessions, original.sessions);
  assert.ok(moved.notes?.every(note => moved.projects.some(project => project.id === note.projectId)));
  assert.deepEqual(state, original);
});

test("independent notes and task notes remain independent during deletion and offline replay", () => {
  const commands: Command[] = [
    { type: "task.add", id: "shared-id", projectId: "course", title: "任务", at: T },
    { type: "task.update", id: "shared-id", notes: "任务笔记", at: T },
    { type: "note.add", id: "shared-id", projectId: "course", title: "独立笔记", body: "初始正文", at: T },
    { type: "note.update", id: "shared-id", body: "新增想法", important: true, at: T + MINUTE },
    { type: "task.delete", id: "shared-id", at: T + 2 * MINUTE },
  ];
  const legacy = initialWorkspace();
  delete legacy.notes;
  const live = commands.reduce(applyCommand, legacy);
  const replay = (JSON.parse(JSON.stringify(commands)) as Command[]).reduce(applyCommand, legacy);
  assert.deepEqual(replay, live);
  assert.equal(live.tasks.length, 0);
  assert.equal(live.notes?.[0].body, "新增想法");
  assert.equal(live.notes?.[0].important, true);
  const deleted = applyCommand(live, { type: "note.delete", id: "shared-id", at: T + 3 * MINUTE });
  assert.deepEqual(deleted.notes, []);
  assert.equal(live.notes?.length, 1);
});

test("an older workspace supports several notes per task while unlinked notes retain their original shape", () => {
  const legacy = ready();
  delete legacy.notes;
  const commands: Command[] = [
    { type: "note.add", id: "linked-1", projectId: "course", taskId: "task-1", title: "遍历", body: "先序", at: T },
    { type: "note.add", id: "linked-2", projectId: "course", taskId: "task-1", title: "二叉树", body: "树高", at: T + MINUTE },
    { type: "note.add", id: "unlinked", projectId: "course", taskId: null, title: "待整理", at: T },
  ];
  const state = commands.reduce(applyCommand, legacy);
  assert.equal(state.notes?.filter(note => note.taskId === "task-1").length, 2);
  assert.equal(Object.hasOwn(state.notes![2], "taskId"), false);
  assert.equal(legacy.notes, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.deepEqual(state.tasks, legacy.tasks);
});

test("notes can attach to a task, change tasks and explicitly detach without changing existing contents", () => {
  let state = applyCommand(ready(), { type: "task.add", id: "task-2", projectId: "course", title: "同项目任务", at: T });
  state = applyCommand(state, { type: "note.add", id: "note-1", projectId: "course", title: "旧版独立笔记", body: "原始内容", at: T });
  assert.equal(Object.hasOwn(state.notes![0], "taskId"), false);
  state = applyCommand(state, { type: "note.update", id: "note-1", taskId: "task-1", at: T + MINUTE });
  assert.equal(state.notes?.[0].taskId, "task-1");
  state = applyCommand(state, { type: "note.update", id: "note-1", body: "补充内容", important: true, at: T + 2 * MINUTE });
  assert.equal(state.notes?.[0].taskId, "task-1", "omitting taskId preserves the association");
  state = applyCommand(state, { type: "note.update", id: "note-1", taskId: "task-2", at: T + 3 * MINUTE });
  assert.equal(state.notes?.[0].taskId, "task-2");
  const attached = structuredClone(state);
  state = applyCommand(state, { type: "note.update", id: "note-1", taskId: null, at: T + 2 * MINUTE });
  assert.deepEqual(state.notes?.[0], {
    id: "note-1", projectId: "course", title: "旧版独立笔记", body: "补充内容", important: true, createdAt: T, updatedAt: T + 3 * MINUTE,
  });
  assert.equal(Object.hasOwn(state.notes![0], "taskId"), false);
  assert.equal(attached.notes?.[0].taskId, "task-2", "detaching leaves its source snapshot untouched");
});

test("note associations validate identifiers, task existence and the final project atomically", () => {
  const state = applyCommand(ready(), { type: "note.add", id: "note-1", projectId: "course", title: "笔记", body: "保留内容", at: T });
  const original = structuredClone(state);
  for (const taskId of [false, 42, "", "two words", "a".repeat(101), [], {}]) {
    for (const command of [
      { type: "note.add", id: "note-2", projectId: "course", title: "无效", taskId, at: T },
      { type: "note.update", id: "note-1", taskId, at: T },
    ]) assert.throws(() => validateCommand(command), /关联任务标识/);
  }
  assert.throws(() => validateCommand({ type: "note.delete", id: "note-1", taskId: null, at: T }), /未知字段/);
  const commands: Command[] = [
    { type: "note.add", id: "note-2", projectId: "course", title: "无效", taskId: "missing", at: T },
    { type: "note.add", id: "note-2", projectId: "english", title: "跨项目", taskId: "task-1", at: T },
    { type: "note.update", id: "note-1", title: "不应保留", taskId: "missing", at: T },
    { type: "note.update", id: "note-1", body: "不应写入", projectId: "english", taskId: "task-1", at: T },
  ];
  for (const command of commands) {
    assert.throws(() => applyCommand(state, command), /关联任务不存在|同一项目/);
    assert.deepEqual(state, original);
  }
  for (const taskId of [undefined, null, "task-1"]) {
    assert.doesNotThrow(() => validateCommand({ type: "note.add", id: "note-2", projectId: "course", title: "有效", taskId, at: T }));
    assert.doesNotThrow(() => validateCommand({ type: "note.update", id: "note-1", taskId, at: T }));
  }
});

test("moving a note alone detaches a mismatched task and explicit reassociation uses the final project", () => {
  let state = applyCommand(ready(), { type: "task.add", id: "english-task", projectId: "english", title: "英语任务", at: T });
  state = applyCommand(state, { type: "note.add", id: "note-1", projectId: "course", taskId: "task-1", title: "关联笔记", body: "完整正文", at: T });
  const sameProject = applyCommand(state, { type: "note.update", id: "note-1", projectId: "course", at: T + MINUTE });
  assert.equal(sameProject.notes?.[0].taskId, "task-1");
  const moved = applyCommand(state, { type: "note.update", id: "note-1", projectId: "english", at: T + MINUTE });
  assert.equal(Object.hasOwn(moved.notes![0], "taskId"), false);
  assert.equal(moved.notes?.[0].projectId, "english");
  assert.equal(moved.notes?.[0].body, "完整正文");
  const relinked = applyCommand(state, { type: "note.update", id: "note-1", projectId: "english", taskId: "english-task", at: T + MINUTE });
  assert.equal(relinked.notes?.[0].taskId, "english-task");
  const detached = applyCommand(state, { type: "note.update", id: "note-1", projectId: "english", taskId: null, at: T + MINUTE });
  assert.equal(Object.hasOwn(detached.notes![0], "taskId"), false);
  assert.equal(state.notes?.[0].taskId, "task-1");
  assert.equal(state.tasks[0].projectId, "course");
});

test("moving a task carries all associated notes and preserves timer, contents and monotonic update times", () => {
  let state = start();
  state = applyCommand(state, { type: "note.add", id: "linked-1", projectId: "course", taskId: "task-1", title: "章节一", body: "内容一", at: T });
  state = applyCommand(state, { type: "note.add", id: "linked-2", projectId: "course", taskId: "task-1", title: "章节二", body: "内容二", at: T + 2 * MINUTE });
  state = applyCommand(state, { type: "note.add", id: "unlinked", projectId: "course", title: "其他笔记", at: T });
  const original = structuredClone(state);
  const moved = applyCommand(state, { type: "task.update", id: "task-1", projectId: "english", at: T + MINUTE });
  assert.equal(moved.tasks[0].projectId, "english");
  assert.deepEqual(moved.notes, original.notes?.map(note => note.taskId === "task-1" ? { ...note, projectId: "english", updatedAt: Math.max(note.updatedAt, T + MINUTE) } : note));
  assert.deepEqual(moved.sessions, original.sessions);
  assert.equal(moved.activeSessionId, "session-1");
  assert.deepEqual(state, original);
});

test("deleting a task detaches and preserves its independent notes while keeping existing history confirmation rules", () => {
  for (const withHistory of [false, true]) {
    let state = withHistory ? act(start(), "session.finish", 10) : ready();
    state = applyCommand(state, { type: "task.update", id: "task-1", notes: "旧任务正文", at: T + 11 * MINUTE });
    state = applyCommand(state, { type: "note.add", id: "note-1", projectId: "course", taskId: "task-1", title: "独立章节", body: "需要保留的内容", at: T + 11 * MINUTE });
    const original = structuredClone(state);
    if (withHistory) {
      assert.throws(() => applyCommand(state, { type: "task.delete", id: "task-1", at: T + 12 * MINUTE }), /确认同时删除学习记录/);
      assert.deepEqual(state, original);
    }
    const removed = applyCommand(state, { type: "task.delete", id: "task-1", deleteHistory: withHistory, at: T + 12 * MINUTE });
    assert.equal(removed.tasks.length, 0);
    assert.equal(removed.sessions.length, 0);
    assert.deepEqual(removed.notes?.[0], {
      id: "note-1", projectId: "course", title: "独立章节", body: "需要保留的内容", important: false, createdAt: T + 11 * MINUTE, updatedAt: T + 12 * MINUTE,
    });
    assert.deepEqual(state, original);
  }
});

test("completion, archiving and whole-project transfer keep linked notes editable and consistently associated", () => {
  let state = applyCommand(ready(), { type: "note.add", id: "note-1", projectId: "course", taskId: "task-1", title: "章节", at: T });
  state = applyCommand(state, { type: "task.update", id: "task-1", status: "done", archived: true, at: T + MINUTE });
  state = applyCommand(state, { type: "note.update", id: "note-1", body: "归档后补充", important: true, at: T + 2 * MINUTE });
  const original = structuredClone(state);
  const moved = applyCommand(state, { type: "project.delete", id: "course", targetProjectId: "english", at: T + 3 * MINUTE });
  assert.equal(moved.tasks[0].projectId, "english");
  assert.equal(moved.tasks[0].archived, true);
  assert.equal(moved.notes?.[0].projectId, "english");
  assert.equal(moved.notes?.[0].taskId, "task-1");
  assert.equal(moved.notes?.[0].body, "归档后补充");
  assert.equal(moved.notes?.[0].important, true);
  const edited = applyCommand(moved, { type: "note.update", id: "note-1", body: "迁移后继续复习", at: T + 4 * MINUTE });
  assert.equal(edited.notes?.[0].body, "迁移后继续复习");
  assert.equal(edited.notes?.[0].taskId, "task-1");
  assert.deepEqual(state, original);
});

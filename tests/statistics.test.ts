import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { Session, Workspace } from "../lib/study";

const study = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
// Use the same dependency boundary as the hook tests; the app keeps bundler-style imports.
const compiled = ts.transpileModule(readFileSync(new URL("../lib/statistics.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const statisticsModule = { exports: {} as typeof import("../lib/statistics") };
vm.runInNewContext(compiled, {
  module: statisticsModule, exports: statisticsModule.exports,
  require: (name: string) => { assert.equal(name, "./study"); return study; },
});
const { summarizeStudy } = statisticsModule.exports;
const MINUTE = 60_000;
const at = (value: string) => Date.parse(`${value}+08:00`);
const NOW = at("2026-10-23T12:00:00");
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function workspace(): Workspace {
  return {
    ...study.initialWorkspace(),
    tasks: [
      { id: "course-task", projectId: "course", title: "课程练习", status: "doing", notes: "", createdAt: at("2026-09-01T00:00:00") },
      { id: "english-task", projectId: "english", title: "已归档的听力练习", status: "done", notes: "笔记保留", createdAt: at("2026-09-01T00:00:00"), archived: true },
    ],
  };
}

function session(id: string, start: string, end: string | null, taskId = "course-task"): Session {
  return { id, taskId, mode: "free", targetMs: 0, segments: [{ start: at(start), end: end ? at(end) : null }], finishedAt: end ? at(end) : null };
}

test("empty statistics include every zero day and divide by the entire selected window", () => {
  const summary = summarizeStudy(workspace(), NOW);
  assert.equal(summary.startKey, "2026-10-17");
  assert.equal(summary.endKey, "2026-10-23");
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days.every((day) => day.ms === 0), true);
  assert.equal(summary.totalMs, 0);
  assert.equal(summary.dailyAverageMs, 0);
  assert.equal(summary.activeDays, 0);
  assert.equal(summary.sessionCount, 0);
  assert.deepEqual(plain(summary.projectTotals), []);
  assert.deepEqual(plain(summary.taskTotals), []);
});

test("seven-day statistics clip the first day, split midnight and stop running time at now", () => {
  const state = workspace();
  state.sessions = [
    session("old", "2026-10-16T10:00:00", "2026-10-16T10:15:00"),
    session("edge", "2026-10-16T23:50:00", "2026-10-17T00:10:00"),
    session("midnight", "2026-10-22T23:50:00", "2026-10-23T00:20:00"),
    session("running", "2026-10-23T10:00:00", null),
    session("zero", "2026-10-23T09:00:00", "2026-10-23T09:00:00"),
    session("future", "2026-10-23T13:00:00", "2026-10-23T14:00:00"),
  ];
  const original = structuredClone(state);
  const summary = summarizeStudy(state, NOW, 7);
  assert.equal(summary.totalMs, 160 * MINUTE);
  assert.equal(summary.dailyAverageMs, 160 * MINUTE / 7);
  assert.equal(summary.activeDays, 3);
  assert.equal(summary.sessionCount, 3);
  assert.deepEqual(plain(summary.days.map((day) => day.ms / MINUTE)), [10, 0, 0, 0, 0, 10, 140]);
  assert.equal(summary.days.reduce((sum, day) => sum + day.ms, 0), summary.totalMs);
  assert.deepEqual(state, original, "summaries do not mutate persisted state");
});

test("thirty-day statistics include only the selected Beijing calendar dates", () => {
  const state = workspace();
  state.sessions = [
    session("edge", "2026-09-23T23:50:00", "2026-09-24T00:15:00"),
    session("month", "2026-10-01T10:00:00", "2026-10-01T10:30:00"),
    session("today", "2026-10-23T10:00:00", "2026-10-23T10:45:00"),
  ];
  const summary = summarizeStudy(state, NOW, 30);
  assert.equal(summary.startKey, "2026-09-24");
  assert.equal(summary.endKey, "2026-10-23");
  assert.equal(summary.days.length, 30);
  assert.equal(summary.days[0].ms, 15 * MINUTE);
  assert.equal(summary.totalMs, 90 * MINUTE);
  assert.equal(summary.dailyAverageMs, 3 * MINUTE);
  assert.equal(summary.sessionCount, 3);
  assert.equal(summarizeStudy(state, NOW, 7).totalMs, 45 * MINUTE);
});

test("project filtering includes archived history, ranks totals and follows a moved task", () => {
  const state = workspace();
  state.sessions = [
    session("course", "2026-10-22T10:00:00", "2026-10-22T10:20:00"),
    session("english", "2026-10-23T10:00:00", "2026-10-23T10:40:00", "english-task"),
  ];
  const summary = summarizeStudy(state, NOW, 7);
  assert.equal(summary.totalMs, 60 * MINUTE);
  assert.deepEqual(plain(summary.projectTotals.map((project) => [project.projectId, project.ms / MINUTE])), [["english", 40], ["course", 20]]);
  assert.equal(summary.taskTotals[0].taskId, "english-task");
  assert.equal(summary.taskTotals[0].archived, true);
  assert.equal(summary.taskTotals[1].archived, false, "missing legacy flag means false");
  const filtered = summarizeStudy(state, NOW, 7, "english");
  assert.equal(filtered.totalMs, 40 * MINUTE);
  assert.equal(filtered.dailyAverageMs, 40 * MINUTE / 7);
  assert.equal(filtered.sessionCount, 1);
  assert.equal(filtered.activeDays, 1);
  assert.equal(filtered.projectTotals.length, 1);
  assert.equal(summarizeStudy(state, NOW, 7, "missing").totalMs, 0);
  state.tasks[1].projectId = "personal";
  assert.equal(summarizeStudy(state, NOW, 7, "english").totalMs, 0);
  assert.equal(summarizeStudy(state, NOW, 7, "personal").totalMs, 40 * MINUTE);
});

test("pauses are excluded and pomodoro caps cumulative segments across midnight", () => {
  const state = workspace();
  state.sessions = [{
    id: "pomodoro", taskId: "course-task", mode: "pomodoro", targetMs: 25 * MINUTE, finishedAt: null,
    segments: [
      { start: at("2026-10-22T23:50:00"), end: at("2026-10-22T23:55:00") },
      { start: at("2026-10-23T00:05:00"), end: null },
    ],
  }, {
    id: "paused", taskId: "english-task", mode: "free", targetMs: 0, finishedAt: null,
    segments: [{ start: at("2026-10-23T09:00:00"), end: at("2026-10-23T09:10:00") }],
  }];
  const summary = summarizeStudy(state, NOW, 7);
  assert.equal(summary.totalMs, 35 * MINUTE);
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.days[5].ms, 5 * MINUTE);
  assert.equal(summary.days[6].ms, 30 * MINUTE);
  assert.equal(summary.taskTotals[0].ms, 25 * MINUTE);
});

test("a pause gap alone does not make a session count as studied in the window", () => {
  const state = workspace();
  state.sessions = [{
    id: "old-paused", taskId: "course-task", mode: "free", targetMs: 0, finishedAt: null,
    segments: [{ start: at("2026-10-16T23:40:00"), end: at("2026-10-16T23:50:00") }],
  }, {
    id: "expired-before-window", taskId: "course-task", mode: "pomodoro", targetMs: 25 * MINUTE, finishedAt: null,
    segments: [{ start: at("2026-10-16T23:00:00"), end: null }],
  }];
  const summary = summarizeStudy(state, NOW, 7);
  assert.equal(summary.totalMs, 0);
  assert.equal(summary.sessionCount, 0);
});

test("a session crossing several dates is counted once and has no phantom time at midnight", () => {
  const state = workspace();
  state.sessions = [session("long", "2026-10-21T23:50:00", null)];
  const midnight = at("2026-10-23T00:00:00");
  const summary = summarizeStudy(state, midnight, 7);
  assert.equal(summary.totalMs, 1450 * MINUTE);
  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.activeDays, 2);
  assert.equal(summary.days[4].ms, 10 * MINUTE);
  assert.equal(summary.days[5].ms, 1440 * MINUTE);
  assert.equal(summary.days[6].ms, 0);
});

test("sub-minute study remains visible in aggregates and activity counts", () => {
  const state = workspace();
  state.sessions = [session("short", "2026-10-23T11:59:45", null)];
  const summary = summarizeStudy(state, NOW, 7);
  assert.equal(summary.totalMs, 15_000);
  assert.equal(summary.activeDays, 1);
  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.projectTotals[0].ms, 15_000);
});

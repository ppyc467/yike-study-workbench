import test from "node:test";
import assert from "node:assert/strict";
import type { Workspace } from "../lib/study";

const { applyCommand, initialWorkspace, validateCommand, validStudyDate } = await import(new URL("../lib/study.ts", import.meta.url).href) as typeof import("../lib/study");
const { reviewSummary, nextReviewDelay } = await import(new URL("../lib/reviews.ts", import.meta.url).href) as typeof import("../lib/reviews");
const NOW = Date.parse("2026-11-11T10:00:00+08:00");
const DAY = 86_400_000;

function ready(): Workspace {
  const legacy = initialWorkspace();
  delete legacy.reviews;
  return applyCommand(legacy, { type: "task.add", id: "task", projectId: "course", title: "树的遍历", at: NOW });
}
function cards(state = ready()) {
  return applyCommand(state, { type: "review.add", at: NOW, cards: [
    { id: "card1", taskId: "task", question: "先序遍历的顺序？", answer: "根、左、右" },
    { id: "card2", taskId: "task", question: "层序遍历用什么结构？", answer: "队列" },
  ] });
}

test("calendar dates and next steps work with legacy tasks and can be cleared", () => {
  let state = ready();
  state = applyCommand(state, { type: "task.update", id: "task", plannedDate: "2026-11-11", dueDate: "2026-11-15", nextStep: "从队列循环开始", at: NOW });
  assert.equal(state.tasks[0].plannedDate, "2026-11-11");
  assert.equal(JSON.parse(JSON.stringify(state)).tasks[0].nextStep, "从队列循环开始");
  state = applyCommand(state, { type: "task.update", id: "task", plannedDate: null, dueDate: null, nextStep: "", at: NOW });
  assert.equal(state.tasks[0].plannedDate, undefined);
  assert.equal(state.tasks[0].dueDate, undefined);
  assert.equal(state.tasks[0].nextStep, "");
  assert.ok(validStudyDate("2028-02-29"));
  for (const date of ["2026-02-29", "2026-02-30", "2026-13-01", "11/11/2026", "", "2026-1-1"]) {
    assert.equal(validStudyDate(date), false);
    assert.throws(() => validateCommand({ type: "task.update", id: "task", dueDate: date, at: NOW }));
  }
  assert.throws(() => validateCommand({ type: "task.update", id: "task", nextStep: "x".repeat(2001), at: NOW }));
});

test("task creation saves optional dates atomically without changing existing callers", () => {
  const state = applyCommand(initialWorkspace(), { type: "task.add", id: "task", projectId: "course", title: "作业", plannedDate: "2026-11-11", dueDate: "2026-11-13", at: NOW });
  assert.equal(state.tasks[0].dueDate, "2026-11-13");
  assert.throws(() => applyCommand(initialWorkspace(), { type: "task.add", id: "task", projectId: "course", title: "作业", dueDate: "2026-02-30", at: NOW }));
});

test("review batches initialize legacy workspaces, survive serialization and fail atomically", () => {
  const source = ready();
  const result = cards(source);
  assert.equal(source.reviews, undefined);
  assert.equal(result.reviews?.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).reviews[0].attempts, []);
  assert.equal(result.reviews?.[0].dueAt, NOW);
  assert.throws(() => applyCommand(source, { type: "review.add", at: NOW, cards: [
    { id: "ok", taskId: "task", question: "题目", answer: "答案" },
    { id: "bad", taskId: "missing", question: "题目", answer: "答案" },
  ] }));
  assert.equal(source.reviews, undefined);
  assert.throws(() => applyCommand(result, { type: "review.add", at: NOW, cards: [{ id: "card1", taskId: "task", question: "重复", answer: "重复" }] }));
});

test("responses and ratings schedule reviews and preserve all previous attempts", () => {
  let state = cards();
  state = applyCommand(state, { type: "review.rate", id: "card1", attemptId: "attempt1", expectedDueAt: NOW, rating: "again", response: "暂时想不起来", at: NOW + 1000 });
  assert.equal(state.reviews?.[0].dueAt, NOW + 1000 + 10 * 60_000);
  let expectedDueAt = state.reviews![0].dueAt;
  state = applyCommand(state, { type: "review.rate", id: "card1", attemptId: "attempt2", expectedDueAt, rating: "hard", response: "先根节点，左右还不确定", at: expectedDueAt });
  assert.equal(state.reviews?.[0].intervalDays, 1);
  assert.equal(state.reviews?.[0].dueAt, expectedDueAt + DAY);
  expectedDueAt = state.reviews![0].dueAt;
  state = applyCommand(state, { type: "review.rate", id: "card1", attemptId: "attempt3", expectedDueAt, rating: "good", response: "根、左、右", at: expectedDueAt });
  assert.equal(state.reviews?.[0].dueAt, expectedDueAt + 3 * DAY);
  assert.equal(state.reviews?.[0].attempts.length, 3);
  assert.equal(state.reviews?.[0].attempts[0].response, "暂时想不起来");
  assert.equal(nextReviewDelay({ intervalDays: 60 }, "good"), 60 * DAY);
});

test("rating retries are idempotent and another device's stale review is rejected", () => {
  const state = cards();
  const command = { type: "review.rate" as const, id: "card1", attemptId: "attempt1", expectedDueAt: NOW, rating: "good" as const, response: "根、左、右", at: NOW + 1000 };
  const saved = applyCommand(state, command);
  assert.deepEqual(applyCommand(saved, command), saved);
  assert.throws(() => applyCommand(saved, { ...command, attemptId: "other-device" }), /其他设备/);
  assert.equal(saved.reviews?.[0].attempts.length, 1);
  assert.throws(() => applyCommand(state, { ...command, response: " " }));
});

test("deleting source notes keeps review questions while deleting a task removes its reviews", () => {
  let state = applyCommand(ready(), { type: "note.add", id: "note", projectId: "course", taskId: "task", title: "笔记", body: "内容", at: NOW });
  state = applyCommand(state, { type: "review.add", at: NOW, cards: [{ id: "card", taskId: "task", sourceNoteId: "note", question: "题目", answer: "答案" }] });
  state = applyCommand(state, { type: "note.delete", id: "note", at: NOW });
  assert.equal(state.reviews?.length, 1);
  assert.equal(state.reviews?.[0].sourceNoteId, undefined);
  state = applyCommand(state, { type: "task.delete", id: "task", at: NOW });
  assert.deepEqual(state.reviews, []);
});

test("review statistics distinguish recent self-ratings and outstanding practice", () => {
  let state = cards();
  assert.deepEqual(reviewSummary(state.reviews!, NOW), { due: 2, attempts: 0, good: 0, needsPractice: 0 });
  state = applyCommand(state, { type: "review.rate", id: "card1", attemptId: "attempt1", expectedDueAt: NOW, rating: "hard", response: "有一点印象", at: NOW });
  state = applyCommand(state, { type: "review.rate", id: "card2", attemptId: "attempt2", expectedDueAt: NOW, rating: "good", response: "队列", at: NOW });
  assert.deepEqual(reviewSummary(state.reviews!, NOW), { due: 0, attempts: 2, good: 1, needsPractice: 1 });
  assert.equal(reviewSummary(state.reviews!, NOW + 8 * DAY).attempts, 0);
});

test("untrusted review commands reject excessive text, unknown fields and duplicate batch IDs", () => {
  const base = { id: "card", taskId: "task", question: "题目", answer: "答案" };
  assert.throws(() => validateCommand({ type: "review.add", cards: [{ ...base, question: "x".repeat(2001) }], at: NOW }));
  assert.throws(() => validateCommand({ type: "review.add", cards: [{ ...base, unexpected: true }], at: NOW }));
  assert.throws(() => validateCommand({ type: "review.add", cards: [], at: NOW }));
  assert.throws(() => applyCommand(ready(), { type: "review.add", cards: [base, base], at: NOW }));
  assert.throws(() => applyCommand(ready(), { type: "review.add", cards: [{ ...base, sourceNoteId: "missing" }], at: NOW }));
});

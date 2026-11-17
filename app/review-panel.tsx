"use client";

import { useId, useRef, useState } from "react";
import { Brain, LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { Command, NewReviewCard, ReviewCard, ReviewRating, Task, Workspace } from "../lib/study";
import { nextReviewDelay, reviewSummary } from "../lib/reviews";
import { MarkdownDocument } from "./markdown-document";
import "./reviews.css";

type Action = Command extends infer T ? T extends { at: number } ? Omit<T, "at"> : never : never;
type Sender = (action: Action) => boolean;
type QuestionDraft = { id: string; question: string; answer: string };

const reviewTime = (at: number) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
}).format(at);

export function QuizComposer({ tasks, initialTaskId, sourceNoteId, sourceText, send, blocked, online = true, onNotice }: {
  tasks: Task[];
  initialTaskId?: string;
  sourceNoteId?: string;
  sourceText?: string;
  send: Sender;
  blocked: boolean;
  online?: boolean;
  onNotice: (text: string) => void;
}) {
  const id = useId();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draftTaskId, setDraftTaskId] = useState<string | null>(null);
  const candidateTaskId = draftTaskId ?? selectedTaskId ?? initialTaskId ?? "";
  const taskId = tasks.some(task => task.id === candidateTaskId) ? candidateTaskId : "";
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [generating, setGenerating] = useState(false);
  const generationLock = useRef(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  function addManual() {
    if (blocked || generating || !taskId || questions.length >= 5) return;
    setDraftTaskId(taskId);
    setQuestions(previous => [...previous, { id: crypto.randomUUID(), question: "", answer: "" }]);
    setError("");
  }

  async function generate() {
    if (!taskId || !online || blocked || generationLock.current || questions.length > 0) return;
    generationLock.current = true;
    setDraftTaskId(taskId);
    setGenerating(true);
    setError("");
    try {
      const body = sourceNoteId && initialTaskId === taskId
        ? { noteId: sourceNoteId }
        : sourceText !== undefined ? { sourceText } : {};
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/quiz`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(100_000),
      });
      const payload = await response.json() as { error?: string; questions?: { question: string; answer: string }[] };
      if (!response.ok) throw new Error(payload.error || "暂时无法生成题目，请稍后重试");
      if (!Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 5
        || payload.questions.some(question => typeof question.question !== "string" || !question.question.trim() || question.question.length > 2000
          || typeof question.answer !== "string" || !question.answer.trim() || question.answer.length > 6000)) {
        throw new Error("返回的题目格式不完整，请重试");
      }
      setQuestions(payload.questions.map(question => ({ ...question, id: crypto.randomUUID() })));
    } catch (reason) {
      setDraftTaskId(null);
      setError(reason instanceof Error ? reason.message : "连接失败，请重试，或手动写题");
    } finally {
      generationLock.current = false;
      setGenerating(false);
    }
  }

  function save() {
    if (!taskId || blocked || !questions.length || questions.some(question => !question.question.trim() || !question.answer.trim())) return;
    const cards: NewReviewCard[] = questions.map(question => ({
      ...question, taskId,
      ...(sourceNoteId && initialTaskId === taskId ? { sourceNoteId } : {}),
    }));
    if (send({ type: "review.add", cards })) {
      setQuestions([]);
      setDraftTaskId(null);
      setOpen(false);
      setError("");
      onNotice(`已保存 ${cards.length} 道自测题，可在工作台「主动回忆」作答`);
    } else setError("题目尚未保存，请检查同步状态。当前内容仍保留在这里。");
  }

  return <details className="quiz-composer" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Brain size={15} aria-hidden="true" /> 用这些材料考考自己</summary>
    <label htmlFor={`${id}-task`}>关联学习任务<select id={`${id}-task`} value={taskId} disabled={blocked || generating || questions.length > 0} onChange={event => setSelectedTaskId(event.target.value)}>
      <option value="">请选择任务</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}{task.archived ? "（归档）" : ""}</option>)}
    </select></label>
    {!tasks.length && <p className="review-summary">先在工作台创建一个学习任务，再为它整理复习题。</p>}
    <div className="quiz-actions">
      <button type="button" className="secondary-button" disabled={blocked || !online || !taskId || generating || questions.length > 0} onClick={() => void generate()}>{generating ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Brain size={15} aria-hidden="true" />}生成自测题</button>
      <button type="button" className="quiet-button" disabled={blocked || generating || questions.length >= 5 || !taskId} onClick={addManual}><Plus size={15} aria-hidden="true" />手动写题</button>
    </div>
    {!online && <p className="review-summary">联网并同步完成后可以生成题目，手动写题可离线保存。</p>}
    {sourceText !== undefined && sourceText.length > 20_000 && <p className="review-summary">材料较长，请缩短至 20000 字以内后生成，或手动整理题目。</p>}
    {questions.map((question, index) => <fieldset key={question.id} disabled={blocked || generating}>
      <legend>第 {index + 1} 题</legend>
      <label htmlFor={`${id}-question-${index}`}>题目<textarea id={`${id}-question-${index}`} maxLength={2000} value={question.question} onChange={event => setQuestions(previous => previous.map(item => item.id === question.id ? { ...item, question: event.target.value } : item))} /></label>
      <label htmlFor={`${id}-answer-${index}`}>参考答案<textarea id={`${id}-answer-${index}`} maxLength={6000} value={question.answer} onChange={event => setQuestions(previous => previous.map(item => item.id === question.id ? { ...item, answer: event.target.value } : item))} /></label>
      <button type="button" className="quiet-button" onClick={() => {
        setQuestions(previous => previous.filter(item => item.id !== question.id));
        if (questions.length === 1) setDraftTaskId(null);
      }}>移除此题</button>
    </fieldset>)}
    {questions.length > 0 && <div className="quiz-actions"><button type="button" className="small-primary" disabled={blocked || generating || !taskId || questions.some(question => !question.question.trim() || !question.answer.trim())} onClick={save}>保存为复习卡</button></div>}
    {error && <p className="review-error" role="alert">{error}</p>}
    {questions.length > 0 && <p className="review-summary">核对题目和参考答案后保存，复习时会先隐藏答案。自动生成的内容可在这里修改。</p>}
  </details>;
}

export default function ReviewPanel({ state, now, selectedTaskId, send, blocked, online, onNotice, hidden = false }: {
  state: Workspace;
  now: number;
  selectedTaskId?: string;
  send: Sender;
  blocked: boolean;
  online: boolean;
  onNotice: (text: string) => void;
  hidden?: boolean;
}) {
  const [filterTaskId, setFilterTaskId] = useState("");
  const [dueOnly, setDueOnly] = useState(true);
  const [visibleCount, setVisibleCount] = useState(8);
  const activeFilter = state.tasks.some(task => task.id === filterTaskId) ? filterTaskId : "";
  const cards = (state.reviews ?? []).filter(card => !activeFilter || card.taskId === activeFilter);
  const summary = reviewSummary(cards, now);
  const visible = cards.filter(card => !dueOnly || card.dueAt <= now).slice().sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  return <section className="card review-panel" aria-labelledby="review-heading" hidden={hidden}>
    <div className="card-topline"><h2 id="review-heading"><Brain size={18} aria-hidden="true" /> 主动回忆</h2><span className="review-summary">到期 {summary.due} 题</span></div>
    <div className="review-filters">
      <label>学习任务<select aria-label="筛选复习任务" value={activeFilter} onChange={event => { setFilterTaskId(event.target.value); setVisibleCount(8); }}><option value="">全部任务</option>{state.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <button className="quiet-button" aria-pressed={dueOnly} onClick={() => { setDueOnly(!dueOnly); setVisibleCount(8); }}>{dueOnly ? "显示全部题目" : "只看到期题目"}</button>
    </div>
    <p className="review-summary">最近 7 天复测 {summary.attempts} 次 · 自评「会了」{summary.good} 次 · 仍需巩固 {summary.needsPractice} 题</p>
    {visible.length ? <div className="review-list">{visible.slice(0, visibleCount).map(card => <ReviewQuestion key={card.id} card={card} task={state.tasks.find(task => task.id === card.taskId)} blocked={blocked} send={send} />)}</div>
      : <p className="review-summary">{cards.length ? "当前没有到期题目，可以查看全部题目提前复习。" : "从学习笔记或任务对话生成题目，也可以手动写一道题。"}</p>}
    {visible.length > visibleCount && <button className="quiet-button" onClick={() => setVisibleCount(visibleCount + 8)}>查看更多题目</button>}
    <QuizComposer tasks={state.tasks} initialTaskId={selectedTaskId} send={send} blocked={blocked} online={online} onNotice={onNotice} />
  </section>;
}

function ReviewQuestion({ card, task, blocked, send }: { card: ReviewCard; task?: Task; blocked: boolean; send: Sender }) {
  const id = useId();
  const [response, setResponse] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [version, setVersion] = useState(card.dueAt);
  const [graded, setGraded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const changed = !graded && version !== card.dueAt;
  const latest = card.attempts.at(-1);
  function rate(rating: ReviewRating) {
    if (blocked || changed || !revealed || !response.trim()) return;
    if (send({ type: "review.rate", id: card.id, attemptId: crypto.randomUUID(), expectedDueAt: version, rating, response })) {
      setGraded(true);
      setRevealed(false);
      setResponse("");
      setError("");
    } else setError("这次自评尚未保存，请检查同步状态后重试。");
  }
  function restart() {
    setResponse("");
    setRevealed(false);
    setVersion(card.dueAt);
    setGraded(false);
    setError("");
  }
  return <article className="review-card" data-review-id={card.id}>
    <div className="review-meta"><span>{task?.title ?? "学习任务"}</span><span>下次 {reviewTime(card.dueAt)}</span></div>
    <h3>{card.question}</h3>
    {changed && <p className="review-error" role="status">其他设备已复习这道题。你的当前回答仍在这里。<button className="text-button" onClick={restart}>载入最新结果并重新作答</button></p>}
    {graded ? <div role="status"><p className="review-summary">本次作答已记录，下次复习 {reviewTime(card.dueAt)}。</p><button className="quiet-button" onClick={restart}>再次练习</button></div> : <>
      <label htmlFor={`${id}-response`}>先写下你的回答<textarea id={`${id}-response`} value={response} maxLength={6000} disabled={blocked || revealed || changed} placeholder="试着回忆或写出解题步骤，暂时想不起来也可以如实记录。" onChange={event => setResponse(event.target.value)} /></label>
      {!revealed ? <button className="secondary-button" disabled={blocked || changed} onClick={() => {
        if (!response.trim()) setResponse("暂时想不起来");
        setRevealed(true);
      }}>{response.trim() ? "查看参考答案" : "想不起来，查看答案"}</button> : <div className="review-answer">
        <MarkdownDocument body={card.answer} headingPrefix={`review-${card.id}`} />
        <p className="review-summary">对照你的回答，记录这次自评。</p>
        <div className="review-ratings">{([
          ["again", "不会", "10 分钟后"], ["hard", "模糊", "1 天后"], ["good", "会了", `${Math.round(nextReviewDelay(card, "good") / 86_400_000)} 天后`],
        ] as const).map(([rating, label, next]) => <button key={rating} className="secondary-button" disabled={blocked || changed} onClick={() => rate(rating)}>{label}<small>{next}</small></button>)}</div>
      </div>}
    </>}
    {latest && <details><summary className="review-summary">上次作答与自评</summary><p className="review-summary">{reviewTime(latest.at)} · {latest.rating === "good" ? "会了" : latest.rating === "hard" ? "模糊" : "不会"}</p><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{latest.response}</p></details>}
    <div className="review-card-footer"><span className="review-summary">已复测 {card.attempts.length} 次</span><button className="quiet-button" disabled={blocked} onClick={() => setConfirmDelete(true)}><Trash2 size={14} aria-hidden="true" />删除题目</button></div>
    {confirmDelete && <div className="quiz-actions" role="group" aria-label="确认删除复习题"><span className="review-summary">同时删除此题的作答记录？</span><button className="quiet-button" onClick={() => setConfirmDelete(false)}>取消</button><button className="quiet-button" disabled={blocked} onClick={() => send({ type: "review.delete", id: card.id })}>确认删除</button></div>}
    {error && <p className="review-error" role="alert">{error}</p>}
  </article>;
}

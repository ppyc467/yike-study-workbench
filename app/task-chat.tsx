"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Brain, Check, ChevronUp, Copy, LoaderCircle, MessageCircle, RefreshCw, Send } from "lucide-react";
import type { StudyNote, Task } from "../lib/study";
import { readServerEvents } from "../lib/chat-stream";
import { CHAT_LEASE_MS, MAX_CHAT_MEMORY_LENGTH, MAX_CHAT_MESSAGE_LENGTH, type ChatMessage, type ChatSnapshot } from "../lib/task-chat";
import { MarkdownDocument } from "./markdown-document";
import "./task-chat.css";

type Conversation = ChatSnapshot & { providerConfigured: boolean; model: string };
type Operation = { operationId: string; message: string; selectedNoteIds?: string[]; excerpt?: string };
type MemoryDraft = { text: string; baseRevision: number };
type Payload = Partial<Conversation> & { error?: string; snapshot?: Conversation; memoryWarning?: string };
type SavedDraft = { draft?: string; draftId?: string; operation?: Operation; memoryDraft?: MemoryDraft; selectedNoteIds?: string[]; excerpt?: string; savedAt?: number };
const draftPages = new Map<string, { id: string; previousId: string | null }>();

function draftPage(userKey: string) {
  const existing = draftPages.get(userKey);
  if (existing) return existing;
  const identity = { id: crypto.randomUUID(), previousId: null as string | null };
  try {
    const key = `yike.chat.page.v1:${encodeURIComponent(userKey)}`;
    identity.previousId = sessionStorage.getItem(key);
    sessionStorage.setItem(key, identity.id);
  } catch { /* Local copies can still recover when session storage is unavailable. */ }
  draftPages.set(userKey, identity);
  return identity;
}

function snapshotFrom(payload: Payload): Conversation | null {
  const value = payload.snapshot ?? payload;
  if (!Array.isArray(value.messages) || typeof value.memory !== "string" || typeof value.memoryRevision !== "number") return null;
  return value as Conversation;
}

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) {
    const existing = messages.get(message.id);
    if (existing && existing.status === undefined && message.status !== undefined) continue;
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export default function TaskChat({ task, userKey, disabled, relatedNotes = [], onQuizGenerated }: {
  task: Task; userKey: string; disabled: boolean; relatedNotes?: StudyNote[];
  onQuizGenerated?: (questions: { question: string; answer: string }[], sourceText: string) => boolean;
}) {
  const endpoint = `/api/tasks/${encodeURIComponent(task.id)}/chat`;
  const storagePrefix = `yike.chat.draft.v1:${encodeURIComponent(userKey)}:${encodeURIComponent(task.id)}`;
  const storageKey = useRef("");
  const draftId = useRef("");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [memoryError, setMemoryError] = useState("");
  const [memorySaved, setMemorySaved] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [memoryWarning, setMemoryWarning] = useState("");
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>(relatedNotes.slice(0, 20).map(note => note.id));
  const [excerpt, setExcerpt] = useState("");
  const [generatingQuiz, setGeneratingQuiz] = useState<string | null>(null);
  const [quizFeedback, setQuizFeedback] = useState("");
  const [pendingQuiz, setPendingQuiz] = useState<{ messageId: string; sourceText: string; questions: { question: string; answer: string }[] } | null>(null);
  const draftRef = useRef(draft);
  const operationRef = useRef(operation);
  const memoryDraftRef = useRef(memoryDraft);
  const referencesRef = useRef({ selectedNoteIds, excerpt });
  const conversationRef = useRef(conversation);
  const requestInFlight = useRef(false);
  const memoryInFlight = useRef(false);
  const quizInFlight = useRef(false);
  const mounted = useRef(true);
  const mutationVersion = useRef(0);
  const readSequence = useRef(0);
  const historyLoaded = useRef(false);
  const messagesElement = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const messageId = useId();
  const memoryId = useId();
  const feedbackId = useId();

  const persistDraft = useCallback(() => {
    try {
      if (!storageKey.current) return;
      if (!draftRef.current && !operationRef.current && !memoryDraftRef.current && !referencesRef.current.excerpt) localStorage.removeItem(storageKey.current);
      else localStorage.setItem(storageKey.current, JSON.stringify({ taskId: task.id, draft: draftRef.current, draftId: draftId.current, operation: operationRef.current, memoryDraft: memoryDraftRef.current, ...referencesRef.current, savedAt: Date.now() }));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [task.id]);

  const changeDraft = useCallback((text: string) => {
    if (text !== draftRef.current) draftId.current = crypto.randomUUID();
    draftRef.current = text;
    setDraft(text);
    persistDraft();
  }, [persistDraft]);

  const rememberOperation = useCallback((value: Operation | null) => {
    operationRef.current = value;
    setOperation(value);
    persistDraft();
  }, [persistDraft]);

  const changeMemoryDraft = useCallback((value: MemoryDraft | null) => {
    memoryDraftRef.current = value;
    setMemoryDraft(value);
    persistDraft();
  }, [persistDraft]);

  function changeReferences(ids: string[], text: string) {
    referencesRef.current = { selectedNoteIds: ids, excerpt: text };
    setSelectedNoteIds(ids);
    setExcerpt(text);
    draftId.current = crypto.randomUUID();
    persistDraft();
  }

  const applySnapshot = useCallback((next: Conversation, older = false) => {
    const previous = conversationRef.current;
    const messages = older ? mergeMessages(next.messages, previous?.messages ?? []) : mergeMessages(previous?.messages ?? [], next.messages);
    const merged = {
      ...next,
      messages,
      before: older || !historyLoaded.current ? next.before : previous?.before ?? null,
    };
    conversationRef.current = merged;
    setConversation(merged);
    const remembered = operationRef.current ?? (draftId.current && draftRef.current.trim() ? { operationId: draftId.current, message: draftRef.current.trim() } : null);
    if (!remembered) return;
    const acknowledged = messages.some(message => message.operationId === remembered.operationId);
    const answered = messages.some(message => message.role === "assistant" && message.operationId === remembered.operationId);
    if (acknowledged && draftRef.current.trim() === remembered.message) changeDraft("");
    if (answered) {
      rememberOperation(null);
      setActionError("");
      setStreamingAnswer("");
    }
  }, [changeDraft, rememberOperation]);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    const version = mutationVersion.current;
    try {
      const response = await fetch(endpoint, { cache: "no-store", headers: { "X-Study-User-Key": userKey } });
      const payload = await response.json() as Payload;
      if (!mounted.current || sequence !== readSequence.current || version !== mutationVersion.current) return;
      setAuthRequired(response.status === 401);
      if (!response.ok) throw new Error(payload.error || "暂时无法读取学习对话，请重新连接。");
      const next = snapshotFrom(payload);
      if (!next) throw new Error("对话数据暂时无法读取，请重新连接。");
      applySnapshot(next);
      setLoadError("");
    } catch (error) {
      if (mounted.current && sequence === readSequence.current && version === mutationVersion.current) setLoadError(error instanceof Error ? error.message : "暂时无法读取学习对话，请重新连接。");
    }
  }, [endpoint, applySnapshot, userKey]);

  useEffect(() => {
    mounted.current = true;
    const page = draftPage(userKey);
    storageKey.current = `${storagePrefix}:${page.id}`;
    try {
      const own = localStorage.getItem(storageKey.current);
      const previous = page.previousId ? localStorage.getItem(`${storagePrefix}:${page.previousId}`) : null;
      let saved = JSON.parse(own || previous || "null") as SavedDraft | null;
      if (!saved && !page.previousId) {
        const choices: SavedDraft[] = [];
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key !== storagePrefix && !key?.startsWith(`${storagePrefix}:`)) continue;
          try {
            const value = JSON.parse(localStorage.getItem(key) || "null") as SavedDraft | null;
            if (value && (value.draft || value.operation || value.memoryDraft)) choices.push(value);
          } catch { /* Keep damaged or unrelated records outside this recovery. */ }
        }
        choices.sort((left, right) => (right.savedAt ?? 0) - (left.savedAt ?? 0));
        saved = choices[0] ?? null;
      }
      draftId.current = saved?.draftId || saved?.operation?.operationId || crypto.randomUUID();
      if (typeof saved?.draft === "string") { draftRef.current = saved.draft; setDraft(saved.draft); }
      if (saved && (Array.isArray(saved.selectedNoteIds) || typeof saved.excerpt === "string")) {
        const ids = Array.isArray(saved.selectedNoteIds) ? saved.selectedNoteIds.filter(id => relatedNotes.some(note => note.id === id)).slice(0, 20) : referencesRef.current.selectedNoteIds;
        const text = typeof saved.excerpt === "string" ? saved.excerpt.slice(0, 20_000) : "";
        referencesRef.current = { selectedNoteIds: ids, excerpt: text };
        setSelectedNoteIds(ids);
        setExcerpt(text);
      }
      if (typeof saved?.operation?.operationId === "string" && typeof saved.operation.message === "string") {
        operationRef.current = saved.operation;
        setOperation(saved.operation);
      }
      if (typeof saved?.memoryDraft?.text === "string" && Number.isInteger(saved.memoryDraft.baseRevision)) {
        memoryDraftRef.current = saved.memoryDraft;
        setMemoryDraft(saved.memoryDraft);
      }
      persistDraft();
    } catch { setStorageError(true); }
    setStorageReady(true);
    return () => { mounted.current = false; };
  }, [storagePrefix, userKey, persistDraft]);

  useEffect(() => {
    if (disabled) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [disabled, refresh]);

  const latestMessage = conversation?.messages.at(-1);
  useEffect(() => {
    if (followBottom.current && messagesElement.current) messagesElement.current.scrollTop = messagesElement.current.scrollHeight;
  }, [latestMessage?.id, latestMessage?.content, sending, streamingAnswer]);

  async function loadEarlier() {
    const before = conversationRef.current?.before;
    if (!before || loadingHistory) return;
    setLoadingHistory(true);
    const element = messagesElement.current;
    const oldHeight = element?.scrollHeight ?? 0;
    const oldTop = element?.scrollTop ?? 0;
    try {
      const response = await fetch(`${endpoint}?before=${encodeURIComponent(before)}`, { cache: "no-store", headers: { "X-Study-User-Key": userKey } });
      const payload = await response.json() as Payload;
      if (!mounted.current) return;
      if (!response.ok) throw new Error(payload.error || "更早的对话加载失败，请重试。");
      const next = snapshotFrom(payload);
      if (!next) throw new Error("更早的对话暂时无法读取。");
      historyLoaded.current = true;
      followBottom.current = false;
      // The historical page changes only messages and the oldest cursor.
      applySnapshot({ ...conversationRef.current!, messages: next.messages, before: next.before }, true);
      setLoadError("");
      requestAnimationFrame(() => {
        if (element && mounted.current) element.scrollTop = oldTop + element.scrollHeight - oldHeight;
      });
    } catch (error) {
      if (mounted.current) setLoadError(error instanceof Error ? error.message : "更早的对话加载失败，请重试。");
    } finally {
      if (mounted.current) setLoadingHistory(false);
    }
  }

  const busy = sending || !!conversation?.pending;
  const cannotSend = disabled || !storageReady || !conversation?.providerConfigured || busy || authRequired;

  async function submitQuestion(request: Operation) {
    if (cannotSend || requestInFlight.current || memoryInFlight.current) return;
    requestInFlight.current = true;
    setSending(true);
    setActionError("");
    setStreamingAnswer("");
    setMemoryWarning("");
    followBottom.current = true;
    rememberOperation(request);
    mutationVersion.current++;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Study-User-Key": userKey },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CHAT_LEASE_MS + 10_000),
      });
      let payload: Payload;
      if (response.ok && response.headers?.get("content-type")?.includes("text/event-stream")) {
        let finished: Payload | null = null;
        await readServerEvents(response, ({ event, data }) => {
          if (!mounted.current) return;
          const value = JSON.parse(data) as Payload & { text?: string };
          if (event === "started" && conversationRef.current) {
            applySnapshot({ ...conversationRef.current, pending: { operationId: request.operationId, startedAt: Date.now() }, messages: [...conversationRef.current.messages, { id: `${request.operationId}:user`, role: "user", content: request.message, createdAt: Date.now(), operationId: request.operationId, status: "pending" }] });
          }
          if (event === "delta" && typeof value.text === "string") setStreamingAnswer(previous => previous + value.text);
          if (event === "complete" || event === "error") finished = value;
        });
        if (!finished) throw new Error("回答连接中断，重新连接后可重试这个问题。");
        payload = finished;
      } else payload = await response.json() as Payload;
      if (!mounted.current) return;
      mutationVersion.current++;
      setAuthRequired(response.status === 401);
      const next = snapshotFrom(payload);
      if (next) applySnapshot(next);
      if (!response.ok || payload.error) throw new Error(payload.error || "这次回答未完成，可以重试同一个问题。");
      if (!next) throw new Error("回答状态暂时无法读取，请重新连接后查看。");
      setMemoryWarning(payload.memoryWarning || "");
      setLoadError("");
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : "网络连接中断，可以重试同一个问题。");
    } finally {
      requestInFlight.current = false;
      if (mounted.current) {
        setSending(false);
        void refresh();
      }
    }
  }

  function sendQuestion(event?: FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if (!message) return;
    const references = { selectedNoteIds: selectedNoteIds.filter(id => relatedNotes.some(note => note.id === id)), excerpt };
    const sameReferences = JSON.stringify(operation?.selectedNoteIds ?? []) === JSON.stringify(references.selectedNoteIds) && (operation?.excerpt ?? "") === excerpt;
    const request = operation?.message === message && sameReferences ? operation : { operationId: draftId.current || crypto.randomUUID(), message, ...references };
    void submitQuestion(request);
  }

  async function generateQuiz(message: ChatMessage) {
    if (quizInFlight.current || !onQuizGenerated) return;
    quizInFlight.current = true;
    setGeneratingQuiz(message.id);
    setQuizFeedback("");
    try {
      let generated = pendingQuiz?.messageId === message.id ? pendingQuiz : null;
      if (!generated) {
        const sourceText = message.content.slice(0, 20_000);
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/quiz`, { method: "POST", headers: { "Content-Type": "application/json", "X-Study-User-Key": userKey }, body: JSON.stringify({ sourceText }), signal: AbortSignal.timeout(100_000) });
        const payload = await response.json() as { questions?: { question: string; answer: string }[]; error?: string };
        if (!response.ok || !payload.questions?.length) throw new Error(payload.error || "自测题暂时无法生成，请重试。");
        generated = { messageId: message.id, questions: payload.questions, sourceText };
        if (mounted.current) setPendingQuiz(generated);
      }
      const saved = onQuizGenerated(generated.questions, generated.sourceText);
      if (mounted.current) {
        if (saved) { setPendingQuiz(null); setQuizFeedback(`已加入${generated.questions.length}道复习题`); }
        else setQuizFeedback("自测题已生成，处理同步状态后可再次保存。");
      }
    } catch (error) {
      if (mounted.current) setQuizFeedback(error instanceof Error ? error.message : "自测题生成失败，请重试。");
    } finally { quizInFlight.current = false; if (mounted.current) setGeneratingQuiz(null); }
  }

  async function saveMemory(event: FormEvent) {
    event.preventDefault();
    if (!memoryDraft || requestInFlight.current || memoryInFlight.current || disabled || busy) return;
    memoryInFlight.current = true;
    setSavingMemory(true);
    setMemoryError("");
    mutationVersion.current++;
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Study-User-Key": userKey },
        body: JSON.stringify({ memory: memoryDraft.text, baseRevision: memoryDraft.baseRevision }),
      });
      const payload = await response.json() as Payload;
      if (!mounted.current) return;
      mutationVersion.current++;
      setAuthRequired(response.status === 401);
      const next = snapshotFrom(payload);
      if (next) applySnapshot(next);
      if (!response.ok) throw new Error(payload.error || "记忆保存未完成，编辑内容已保留。");
      if (!next) throw new Error("记忆保存状态暂时无法确认，请重新连接后查看。");
      changeMemoryDraft(null);
      setMemorySaved(true);
    } catch (error) {
      if (mounted.current) setMemoryError(error instanceof Error ? error.message : "记忆保存未完成，编辑内容已保留。");
    } finally {
      memoryInFlight.current = false;
      if (mounted.current) setSavingMemory(false);
    }
  }

  return <div className="task-chat">
    <div className="chat-task-context"><MessageCircle size={17} aria-hidden="true" /><h3 title={task.title}>{task.title}</h3></div>
    {conversation && <details className="chat-memory" open={memoryDraft ? true : undefined}>
      <summary><Brain size={17} aria-hidden="true" />任务记忆<span>{memoryDraft ? "编辑中" : conversation.memory ? "查看与修改" : "尚未记录"}</span></summary>
      <p className="chat-help">已学内容、当前卡点和讲解偏好会随对话更新。</p>
      {memoryDraft ? <form onSubmit={saveMemory}>
        <label htmlFor={memoryId} className="sr-only">编辑这个任务的学习记忆</label>
        <textarea id={memoryId} value={memoryDraft.text} maxLength={MAX_CHAT_MEMORY_LENGTH} rows={6} disabled={savingMemory} onChange={event => changeMemoryDraft({ ...memoryDraft, text: event.target.value })} />
        {memoryDraft.baseRevision !== conversation.memoryRevision && <p className="chat-error" role="status">任务记忆已有更新。请载入最新记忆后继续编辑。</p>}
        {memoryError && <p className="chat-error" role="alert">{memoryError}</p>}
        <div className="chat-memory-actions">
          {memoryDraft.baseRevision !== conversation.memoryRevision && <button type="button" className="quiet-button" disabled={savingMemory} onClick={() => { changeMemoryDraft({ text: conversation.memory, baseRevision: conversation.memoryRevision }); setMemoryError(""); }}>载入最新记忆</button>}
          <button type="button" className="quiet-button" disabled={savingMemory} onClick={() => { changeMemoryDraft(null); setMemoryError(""); }}>取消编辑</button>
          <button type="submit" className="small-primary" disabled={disabled || savingMemory || busy || memoryDraft.baseRevision !== conversation.memoryRevision}>{savingMemory ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}保存记忆</button>
        </div>
      </form> : <>
        <p className="chat-memory-content">{conversation.memory || "可以先告诉助手你的学习进度和希望怎样讲解。"}</p>
        <button className="quiet-button" onClick={() => { changeMemoryDraft({ text: conversation.memory, baseRevision: conversation.memoryRevision }); setMemorySaved(false); }}>编辑记忆</button>
      </>}
    </details>}
    {memorySaved && <p className="chat-feedback" role="status"><Check size={14} aria-hidden="true" />记忆已保存</p>}
    {conversation && !conversation.providerConfigured && <p className="chat-service-status" role="status">AI 服务尚待配置，配置完成后即可向这个任务的助手提问。</p>}
    {!conversation && !loadError && <p className="chat-loading" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />正在读取学习对话…</p>}
    {loadError && <div className="chat-error-box" role="status"><p>{loadError}</p><button className="quiet-button" onClick={() => { void refresh(); }}><RefreshCw size={15} aria-hidden="true" />重新连接</button></div>}
    {authRequired && <a className="chat-signin" href="/signin-with-chatgpt?return_to=%2F" target="_top">重新登录</a>}
    {conversation && <div ref={messagesElement} className="chat-messages" role="region" aria-label={`${task.title}的学习对话`} tabIndex={0} onScroll={event => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {conversation.before && <button className="chat-history-button" disabled={loadingHistory} onClick={() => { void loadEarlier(); }}>{loadingHistory ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}更早的对话</button>}
      {conversation.messages.length === 0 && <div className="chat-empty"><MessageCircle size={28} strokeWidth={1.5} aria-hidden="true" /><p>从这个任务的问题开始</p><span>贴一段代码，问一个概念，或告诉我卡在了哪一步。</span></div>}
      {conversation.messages.map(message => <article key={message.id} className={`chat-message ${message.role}`} aria-label={message.role === "user" ? "我的问题" : "学习助手的回答"}>
        <div className="chat-message-heading"><span>{message.role === "user" ? "我" : "学习助手"}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(message.createdAt)}</time></div>
        {message.role === "assistant" ? <div className="chat-message-content"><MarkdownDocument body={message.content} headingPrefix={`chat-${message.id}`} /></div> : <MessageContent content={message.content} />}
        {message.role === "assistant" && <CopyAnswer content={message.content} />}
        {message.role === "assistant" && onQuizGenerated && <button type="button" className="quiet-button chat-quiz" disabled={disabled || !!generatingQuiz} onClick={() => { void generateQuiz(message); }}>{generatingQuiz === message.id ? "正在处理自测题…" : pendingQuiz?.messageId === message.id ? "保存已生成题目" : "生成并保存自测题"}</button>}
        {message.status === "failed" && <div className="chat-message-status"><span>回答未完成</span>{message.operationId && <button className="quiet-button" disabled={cannotSend || savingMemory} onClick={() => { void submitQuestion({ operationId: message.operationId!, message: message.content }); }}><RefreshCw size={14} aria-hidden="true" />重新回答</button>}</div>}
      </article>)}
      {streamingAnswer && <article className="chat-message assistant chat-streaming" aria-label="正在生成的回答">
        <div className="chat-message-heading"><span>学习助手</span><span>{sending ? "生成中" : "本次回答未完成"}</span></div>
        <div className="chat-message-content"><MarkdownDocument body={streamingAnswer} headingPrefix="streaming-answer" /></div>
      </article>}
    </div>}
    <div className="chat-answer-state" role="status" aria-live="polite">{busy && <><LoaderCircle size={15} className="spin" aria-hidden="true" />助手正在思考…</>}</div>
    {actionError && <p className="chat-error" role="alert">{actionError}</p>}
    {memoryWarning && <p className="chat-help" role="status">{memoryWarning}</p>}
    {quizFeedback && <p className="chat-help" role="status">{quizFeedback}</p>}
    {operation && !busy && actionError && <button className="quiet-button chat-retry" disabled={cannotSend || savingMemory} onClick={() => { void submitQuestion(operation); }}><RefreshCw size={15} aria-hidden="true" />重试上一个问题</button>}
    <form className="chat-composer" onSubmit={sendQuestion}>
      <details className="chat-references">
        <summary>引用学习材料{selectedNoteIds.length > 0 && <span>已选{selectedNoteIds.length}篇笔记</span>}</summary>
        {relatedNotes.length > 0 && <fieldset disabled={sending}><legend>本次使用的任务笔记</legend>
          {relatedNotes.map(note => <label className="chat-note-choice" key={note.id}><input type="checkbox" checked={selectedNoteIds.includes(note.id)} disabled={selectedNoteIds.length >= 20 && !selectedNoteIds.includes(note.id)} onChange={event => changeReferences(event.target.checked ? [...selectedNoteIds, note.id] : selectedNoteIds.filter(id => id !== note.id), excerpt)} /><span>{note.title || "未命名笔记"}</span></label>)}
        </fieldset>}
        <label htmlFor={`${messageId}-excerpt`}>重点引用段落</label>
        <textarea id={`${messageId}-excerpt`} rows={3} maxLength={20_000} value={excerpt} disabled={sending} placeholder="粘贴本次需要重点解释的材料" onChange={event => changeReferences(selectedNoteIds, event.target.value)} />
        <button type="button" className="quiet-button" disabled={sending} onMouseDown={event => event.preventDefault()} onClick={() => { const selected = window.getSelection()?.toString().trim(); if (selected) changeReferences(selectedNoteIds, selected.slice(0, 20_000)); }}>引用选中文字</button>
        {excerpt && <button type="button" className="quiet-button" disabled={sending} onClick={() => changeReferences(selectedNoteIds, "")}>清除段落</button>}
      </details>
      <label htmlFor={messageId}>向这个任务的助手提问</label>
      <textarea id={messageId} value={draft} rows={4} maxLength={MAX_CHAT_MESSAGE_LENGTH} placeholder="哪里还没理解？可以贴上问题或代码。" aria-describedby={feedbackId} disabled={sending} onChange={event => changeDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); sendQuestion(); } }} />
      <div className="chat-composer-actions"><span id={feedbackId}>{disabled ? "任务同步完成后可以提问" : "Ctrl / ⌘ + Enter 发送"}</span><button type="submit" className="small-primary" disabled={cannotSend || savingMemory || !draft.trim()}>{sending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}发送</button></div>
      {storageError && <p className="chat-error" role="status">本机草稿暂存不可用，离开前请复制正在编辑的内容。</p>}
    </form>
  </div>;
}

function MessageContent({ content }: { content: string }) {
  return <div className="chat-message-content">{content.split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean).map((part, index) => {
    if (!part.startsWith("```")) return <div className="chat-prose" key={index}>{part}</div>;
    const code = part.replace(/^```[^\n]*\n/, "").replace(/^```/, "").replace(/```$/, "");
    return <pre key={index} tabIndex={0} aria-label="代码"><code>{code}</code></pre>;
  })}</div>;
}

function CopyAnswer({ content }: { content: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <button className="quiet-button chat-copy" onClick={async () => {
    try { await navigator.clipboard.writeText(content); setStatus("copied"); }
    catch { setStatus("error"); }
  }}>{status === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}<span role="status">{status === "copied" ? "已复制" : status === "error" ? "复制失败" : "复制回答"}</span></button>;
}

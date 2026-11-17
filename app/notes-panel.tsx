"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, ChevronRight, Code2, Columns2, FileText, Highlighter, Link2, List, Maximize2, Minimize2, PencilLine, Plus, Search, Star, Trash2, X } from "lucide-react";
import type { Command, StudyNote, Workspace } from "../lib/study";
import { MarkdownDocument, markdownHeadings } from "./markdown-document";
import { QuizComposer } from "./review-panel";
import "./notes-panel.css";

type Action = Command extends infer T ? T extends { at: number } ? Omit<T, "at"> : never : never;
type Entry = StudyNote & { legacyTaskId?: string };
type Task = Workspace["tasks"][number];
type Mode = "read" | "edit" | "split";
type Props = {
  state: Workspace;
  projectId: string;
  onProjectChange: (id: string) => void;
  taskFilter: string;
  onTaskChange: (id: string) => void;
  initialEntryId: string | null;
  initialCreate: boolean;
  send: (action: Action) => boolean;
  blocked: boolean;
  online?: boolean;
  saveState: string;
  onNotice: (text: string) => void;
};

const modifiedDate = (at: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(at);
const taskLabel = (task: Task) => `${task.title}${task.archived ? "（已归档）" : task.status === "done" ? "（已完成）" : ""}`;

function matchesTask(note: Entry, filter: string) {
  if (filter === "all") return true;
  if (filter === "unlinked") return !note.taskId && !note.legacyTaskId;
  return note.taskId === filter;
}

export default function NotesPanel({ state, projectId, onProjectChange, taskFilter, onTaskChange, initialEntryId, initialCreate, send, blocked, online = true, saveState, onNotice }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(initialEntryId);
  const [previousScope, setPreviousScope] = useState({ projectId, taskFilter });
  const [query, setQuery] = useState("");
  const [importantOnly, setImportantOnly] = useState(false);
  const [adding, setAdding] = useState(initialCreate);
  const [mode, setMode] = useState<Mode>("read");
  const [focused, setFocused] = useState(false);
  const [mobileArticle, setMobileArticle] = useState(Boolean(initialEntryId));
  const searchRef = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const tasksById = useMemo(() => new Map(state.tasks.map(task => [task.id, task])), [state.tasks]);
  const availableTasks = useMemo(() => state.tasks.filter(task => projectId === "all" || task.projectId === projectId), [state.tasks, projectId]);
  const activeTaskFilter = taskFilter === "all" || taskFilter === "unlinked" || availableTasks.some(task => task.id === taskFilter) ? taskFilter : "all";
  useEffect(() => {
    if (activeTaskFilter !== taskFilter) onTaskChange(activeTaskFilter);
  }, [activeTaskFilter, taskFilter, onTaskChange]);
  const entries = useMemo<Entry[]>(() => [
    ...(state.notes ?? []),
    ...state.tasks.filter(task => task.notes.trim() || selectedId === `task:${task.id}`).map(task => ({
      id: `task:${task.id}`, taskId: task.id, legacyTaskId: task.id, projectId: task.projectId, title: task.title,
      body: task.notes, important: false, createdAt: task.createdAt, updatedAt: task.createdAt,
    })),
  ], [state.notes, state.tasks, selectedId]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => entries.filter(note => (projectId === "all" || note.projectId === projectId)
    && matchesTask(note, activeTaskFilter)
    && (!importantOnly || note.important)
    && (!normalizedQuery || `${note.title}\n${note.body}\n${tasksById.get(note.taskId ?? "")?.title ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), [entries, projectId, activeTaskFilter, importantOnly, normalizedQuery, tasksById]);
  if (projectId !== previousScope.projectId || activeTaskFilter !== previousScope.taskFilter) {
    setPreviousScope({ projectId, taskFilter: activeTaskFilter });
    const current = entries.find(note => note.id === selectedId);
    if (selectedId && (!current || (projectId !== "all" && current.projectId !== projectId) || !matchesTask(current, activeTaskFilter))) {
      setSelectedId(null);
      setMobileArticle(false);
      setMode("read");
      setFocused(false);
    }
  }
  const selected = selectedId ? entries.find(note => note.id === selectedId) : filtered[0];

  function selectNote(note: Entry) {
    setSelectedId(note.id);
    setMode("read");
    setMobileArticle(true);
  }

  function createNote(title: string, destination: string, taskId: string) {
    const id = crypto.randomUUID();
    if (!send({ type: "note.add", id, title, projectId: destination, ...(taskId ? { taskId } : {}) })) return;
    setQuery("");
    setImportantOnly(false);
    onProjectChange(destination);
    onTaskChange(taskId || (activeTaskFilter === "unlinked" ? "unlinked" : "all"));
    setSelectedId(id);
    setAdding(false);
    setMode("edit");
    setMobileArticle(true);
  }

  function resetSelection() {
    setSelectedId(null);
    setMode("read");
    setMobileArticle(false);
    setFocused(false);
  }

  function changeMode(next: Mode) {
    if (selected) setSelectedId(selected.id);
    setMode(next);
  }

  return <section className={`notes-page ${focused ? "notes-focused" : ""} ${mobileArticle ? "notes-show-article" : ""}`} aria-labelledby="notes-heading">
    <div className="notes-heading-row">
      <h1 id="notes-heading">学习笔记</h1>
      <button ref={createTrigger} className="primary-button" disabled={blocked} onClick={() => setAdding(true)}><Plus size={18} aria-hidden="true" /> 新建笔记</button>
    </div>
    {adding && <NewNoteForm projects={state.projects} tasks={state.tasks} projectId={projectId} defaultTaskId={activeTaskFilter} blocked={blocked} onCreate={createNote} onCancel={() => { setAdding(false); requestAnimationFrame(() => createTrigger.current?.focus()); }} />}
    <div className="notebook-layout">
      <aside className="notebook-library" aria-label="笔记列表">
        <div className="notebook-search"><Search size={18} aria-hidden="true" /><label htmlFor="note-search" className="sr-only">搜索笔记标题、正文或任务名</label><input id="note-search" ref={searchRef} type="search" placeholder="搜索标题、正文或任务" value={query} onChange={event => { setQuery(event.target.value); resetSelection(); }} />{query && <button aria-label="清除笔记搜索" onClick={() => { setQuery(""); resetSelection(); searchRef.current?.focus(); }}><X size={16} aria-hidden="true" /></button>}</div>
        <label className="notebook-project" htmlFor="notes-project">课程 / 项目<select id="notes-project" value={projectId} onChange={event => { resetSelection(); onProjectChange(event.target.value); }}><option value="all">全部课程与项目</option>{state.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className="notebook-project notebook-task-filter" htmlFor="notes-task">任务<select id="notes-task" value={activeTaskFilter} onChange={event => { resetSelection(); onTaskChange(event.target.value); }}><option value="all">全部任务</option><option value="unlinked">无关联任务</option>{availableTasks.map(task => <option key={task.id} value={task.id}>{taskLabel(task)}</option>)}</select></label>
        <div className="notebook-filter"><span>{filtered.length} 篇笔记</span><button aria-pressed={importantOnly} onClick={() => { setSelectedId(null); setImportantOnly(!importantOnly); setMode("read"); }}><Star size={15} fill={importantOnly ? "currentColor" : "none"} aria-hidden="true" /> 只看重点</button></div>
        <ul className="notebook-list">
          {filtered.map(note => <li key={note.id}><button className={`notebook-entry ${selected?.id === note.id ? "is-selected" : ""}`} aria-current={selected?.id === note.id ? "true" : undefined} onClick={() => selectNote(note)}>
            <span className="notebook-entry-title"><FileText size={17} aria-hidden="true" /><strong title={note.title}>{note.title}</strong>{note.important && <Star className="notebook-entry-star" size={15} fill="currentColor" aria-label="重点笔记" />}</span>
            <span className="notebook-entry-preview">{note.body.replace(/[#*`>~=[\]]/g, "").replace(/\s+/g, " ").slice(0, 100) || "开始记录代码和重点…"}</span>
            {note.taskId && tasksById.has(note.taskId) && <span className="notebook-entry-task" title={taskLabel(tasksById.get(note.taskId)!)}><Link2 size={13} aria-hidden="true" /><span>{tasksById.get(note.taskId)!.title}</span></span>}
            <span className="notebook-entry-meta"><span>{state.projects.find(project => project.id === note.projectId)?.title}</span><span>{note.legacyTaskId ? "原任务笔记" : modifiedDate(note.updatedAt)}</span></span>
          </button></li>)}
        </ul>
        {!filtered.length && <div className="notebook-list-empty"><FileText size={25} aria-hidden="true" /><p>{query || importantOnly ? "没有符合条件的笔记" : "这里还没有笔记"}</p>{(query || importantOnly) && <button className="text-button" onClick={() => { setQuery(""); setImportantOnly(false); }}>清除筛选</button>}</div>}
      </aside>
      {selected ? <NoteDocument key={selected.id} entry={selected} projects={state.projects} tasks={state.tasks} mode={mode} onModeChange={changeMode} focused={focused} onFocusChange={setFocused} onBack={() => { setMobileArticle(false); setFocused(false); }} send={send} blocked={blocked} online={online} saveState={saveState} onNotice={onNotice} onDelete={() => { resetSelection(); requestAnimationFrame(() => createTrigger.current?.focus()); }} />
        : <div className="notebook-empty"><BookOpen size={36} strokeWidth={1.4} aria-hidden="true" /><h2>{selectedId ? "这篇笔记已被删除" : entries.length ? "选择其他课程或调整筛选" : "把代码与重点，整理成一篇篇笔记"}</h2>{selectedId && <button className="secondary-button" onClick={() => { setSelectedId(null); setMode("read"); setMobileArticle(false); }}>返回笔记列表</button>}{!entries.length && !selectedId && <button className="secondary-button" disabled={blocked} onClick={() => setAdding(true)}><Plus size={17} aria-hidden="true" /> 创建第一篇笔记</button>}</div>}
    </div>
  </section>;
}

function NewNoteForm({ projects, tasks, projectId, defaultTaskId, blocked, onCreate, onCancel }: { projects: Workspace["projects"]; tasks: Task[]; projectId: string; defaultTaskId: string; blocked: boolean; onCreate: (title: string, project: string, taskId: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [destinationId, setDestination] = useState(() => tasks.find(task => task.id === defaultTaskId)?.projectId ?? (projectId === "all" ? projects[0]?.id ?? "" : projectId));
  const [selectedTaskId, setTaskId] = useState(() => tasks.some(task => task.id === defaultTaskId) ? defaultTaskId : "");
  const [previousProjectId, setPreviousProjectId] = useState(projectId);
  const destination = projects.some(project => project.id === destinationId) ? destinationId : projects[0]?.id ?? "";
  const availableTasks = tasks.filter(task => task.projectId === destination);
  const taskId = availableTasks.some(task => task.id === selectedTaskId) ? selectedTaskId : "";
  if (projectId !== previousProjectId) {
    setPreviousProjectId(projectId);
    if (projectId !== "all" && projects.some(project => project.id === projectId)) {
      setDestination(projectId);
      setTaskId("");
    }
  }
  if (selectedTaskId && !taskId) setTaskId("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() && destination && !blocked) onCreate(title.trim(), destination, taskId);
  }
  return <form className="new-note-form" onSubmit={submit} onKeyDown={event => { if (event.key === "Escape") onCancel(); }}>
    <label htmlFor="new-note-title">笔记标题<input autoFocus id="new-note-title" value={title} maxLength={160} required disabled={blocked} placeholder="例如：二叉树遍历与易错点" onChange={event => setTitle(event.target.value)} /></label>
    <label htmlFor="new-note-project">课程 / 项目<select id="new-note-project" value={destination} disabled={blocked} onChange={event => { setDestination(event.target.value); setTaskId(""); }}>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
    <label htmlFor="new-note-task">关联任务<select id="new-note-task" value={taskId} disabled={blocked} onChange={event => setTaskId(event.target.value)}><option value="">无关联任务</option>{availableTasks.map(task => <option key={task.id} value={task.id}>{taskLabel(task)}</option>)}</select></label>
    <div><button type="button" className="quiet-button" onClick={onCancel}>取消</button><button type="submit" className="small-primary" disabled={blocked || !title.trim() || !destination}><Plus size={17} aria-hidden="true" /> 创建笔记</button></div>
  </form>;
}

function NoteDocument({ entry, projects, tasks, mode, onModeChange, focused, onFocusChange, onBack, send, blocked, online, saveState, onNotice, onDelete }: { entry: Entry; projects: Workspace["projects"]; tasks: Task[]; mode: Mode; onModeChange: (mode: Mode) => void; focused: boolean; onFocusChange: (value: boolean) => void; onBack: () => void; send: Props["send"]; blocked: boolean; online: boolean; saveState: string; onNotice: Props["onNotice"]; onDelete: () => void }) {
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editorMessage, setEditorMessage] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const headings = useMemo(() => markdownHeadings(entry.body), [entry.body]);
  const limit = entry.legacyTaskId ? 20_000 : 50_000;
  const project = projects.find(item => item.id === entry.projectId);
  const task = tasks.find(item => item.id === entry.taskId);
  const availableTasks = tasks.filter(item => item.projectId === entry.projectId);

  function updateBody(body: string) {
    if (body.length > limit) { setEditorMessage(`正文最多 ${limit.toLocaleString()} 字，请分成多篇笔记。`); return false; }
    const accepted = entry.legacyTaskId ? send({ type: "task.update", id: entry.legacyTaskId, notes: body }) : send({ type: "note.update", id: entry.id, body });
    if (accepted) setEditorMessage("");
    return accepted;
  }

  function wrapSelection(before: string, after: string, placeholder: string) {
    const input = textarea.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = entry.body.slice(start, end) || placeholder;
    if (!updateBody(entry.body.slice(0, start) + before + text + after + entry.body.slice(end))) return;
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + before.length, start + before.length + text.length); });
  }

  const toc = <ul>{headings.map(heading => <li key={heading.id} style={{ paddingLeft: `${Math.max(0, heading.depth - 1) * 10}px` }}><a href={`#${heading.id}`}>{heading.text || "未命名标题"}</a></li>)}</ul>;
  return <article className={`notebook-document mode-${mode}`} aria-label={`笔记 ${entry.title}`}>
    <div className="notebook-document-bar">
      <button className="notebook-back" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" /> 笔记列表</button>
      <div className="notebook-modes" aria-label="笔记显示方式">{([ ["read", BookOpen, "阅读"], ["edit", PencilLine, "编辑"], ["split", Columns2, "分栏"] ] as const).map(([value, Icon, label]) => <button key={value} aria-pressed={mode === value} onClick={() => onModeChange(value)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}</div>
      <button className="notebook-expand" aria-label={focused ? "收起阅读区域" : "展开阅读区域"} aria-pressed={focused} onClick={() => onFocusChange(!focused)}>{focused ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}</button>
    </div>
    <div className="notebook-document-heading">
      <div className="notebook-breadcrumb"><span style={{ background: project?.color }} aria-hidden="true" />{project?.title}{entry.legacyTaskId && <><ChevronRight size={12} aria-hidden="true" />原任务笔记</>}</div>
      {mode === "read" || entry.legacyTaskId ? <h2>{entry.title}</h2> : <><label className="sr-only" htmlFor="note-title">笔记标题</label><input id="note-title" className="notebook-title-input" value={titleDraft ?? entry.title} maxLength={160} disabled={blocked} aria-invalid={titleDraft !== null && !titleDraft.trim()} onChange={event => { setTitleDraft(event.target.value); if (event.target.value.trim()) send({ type: "note.update", id: entry.id, title: event.target.value.trim() }); }} onBlur={() => { if (titleDraft !== null && !titleDraft.trim()) setEditorMessage("标题不能为空，已保留原标题。"); setTitleDraft(null); }} /></>}
      <div className="notebook-metadata">
        <span>{entry.legacyTaskId ? "与原任务的笔记同步" : `更新于 ${modifiedDate(entry.updatedAt)}`}</span>
        {!entry.legacyTaskId && <button aria-pressed={entry.important} disabled={blocked} onClick={() => send({ type: "note.update", id: entry.id, important: !entry.important })}><Star size={15} fill={entry.important ? "currentColor" : "none"} aria-hidden="true" />{entry.important ? "已标为重点" : "标为重点"}</button>}
        {task && <span className="notebook-linked-task" title={taskLabel(task)}><Link2 size={14} aria-hidden="true" />{task.title}</span>}
      </div>
      {mode !== "read" && !entry.legacyTaskId && <div className="notebook-association">
        <label htmlFor="note-project">课程 / 项目<select id="note-project" aria-label="笔记所属课程或项目" value={entry.projectId} disabled={blocked} onChange={event => send({ type: "note.update", id: entry.id, projectId: event.target.value })}>{projects.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
        <label htmlFor="note-task">关联任务<select id="note-task" value={task && task.projectId === entry.projectId ? task.id : ""} disabled={blocked} onChange={event => send({ type: "note.update", id: entry.id, taskId: event.target.value || null })}><option value="">无关联任务</option>{availableTasks.map(item => <option key={item.id} value={item.id}>{taskLabel(item)}</option>)}</select></label>
      </div>}
      <QuizComposer key={`quiz:${entry.id}:${entry.taskId ?? ""}`} tasks={tasks} initialTaskId={entry.taskId} sourceNoteId={entry.legacyTaskId ? undefined : entry.id} sourceText={entry.body} send={send} blocked={blocked} online={online} onNotice={onNotice} />
    </div>
    {mode !== "edit" && headings.length > 0 && <details className="notebook-mobile-toc"><summary><List size={16} aria-hidden="true" /> 本篇目录</summary>{toc}</details>}
    <div className="notebook-content">
      {mode !== "read" && <div className="notebook-editor">
        <div className="notebook-formatting" aria-label="Markdown 编辑工具"><button disabled={blocked} onClick={() => wrapSelection("## ", "", "小节标题")} title="插入二级标题">标题</button><button disabled={blocked} onClick={() => wrapSelection("**", "**", "重点内容")} title="加粗">加粗</button><button disabled={blocked} onClick={() => wrapSelection("==", "==", "重点内容")}><Highlighter size={15} aria-hidden="true" /> 高亮</button><button disabled={blocked} onClick={() => wrapSelection("\n```cpp\n", "\n```\n", "// 在这里写代码")}><Code2 size={16} aria-hidden="true" /> 代码块</button></div>
        <label className="sr-only" htmlFor="note-body">笔记正文（Markdown）</label><textarea id="note-body" ref={textarea} autoFocus value={entry.body} maxLength={limit} disabled={blocked} spellCheck={false} placeholder={"## 今天的重点\n\n写下思路、代码或粘贴 Markdown…\n\n用 ==重点== 高亮需要复习的内容。"} onChange={event => updateBody(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") { event.preventDefault(); wrapSelection("**", "**", "重点内容"); } }} />
        <p className="notebook-format-help">支持 Markdown · ==重点== 高亮 · 代码块可填写 cpp、python 等语言</p>
      </div>}
      {mode !== "edit" && <div className="notebook-reading">{entry.body.trim() ? <MarkdownDocument body={entry.body} /> : <div className="notebook-empty-body"><PencilLine size={28} aria-hidden="true" /><p>写下这篇笔记的第一个重点</p><button className="secondary-button" onClick={() => onModeChange("edit")}>开始编辑</button></div>}</div>}
      {mode === "read" && headings.length > 0 && <nav className="notebook-toc" aria-label="本篇目录"><h3><List size={16} aria-hidden="true" /> 本篇目录</h3>{toc}</nav>}
    </div>
    <footer className="notebook-document-footer"><span>{saveState} · {entry.body.length.toLocaleString()} 字</span>{mode !== "read" && !entry.legacyTaskId && <button ref={deleteTrigger} className="notebook-delete" disabled={blocked} onClick={() => setConfirmingDelete(true)}><Trash2 size={15} aria-hidden="true" /> 删除笔记</button>}</footer>
    {editorMessage && <p className="notebook-editor-message" role="status">{editorMessage}</p>}
    {confirmingDelete && <div className="notebook-delete-confirm" role="group" aria-label="确认删除笔记" onKeyDown={event => { if (event.key === "Escape") { setConfirmingDelete(false); deleteTrigger.current?.focus(); } }}><p>确认删除《{entry.title}》？删除后无法恢复。</p><div><button autoFocus className="secondary-button" onClick={() => { setConfirmingDelete(false); deleteTrigger.current?.focus(); }}>保留笔记</button><button className="notebook-delete" disabled={blocked} onClick={() => { if (send({ type: "note.delete", id: entry.id })) { onNotice("笔记已删除"); onDelete(); } }}><Trash2 size={16} aria-hidden="true" /> 确认删除</button></div></div>}
  </article>;
}

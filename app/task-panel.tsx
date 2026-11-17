"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, BookOpen, CheckCheck, Circle, CircleCheck, Clock3, CloudCheck, FileText, FolderPlus, Pencil, Pin, PinOff, Play, Plus, Search, Star, Trash2, Undo2, X } from "lucide-react";
import { dayKey, sessionElapsedMs, type Command, type Workspace } from "../lib/study";
import "./tasks.css";

type Action = Command extends infer T ? T extends { at: number } ? Omit<T, "at"> : never : never;
type Task = Workspace["tasks"][number];
type Filter = "today" | "open" | "doing" | "done" | "archived" | "all";
type Sender = (command: Action) => boolean;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "today", label: "今天与逾期" },
  { value: "open", label: "待完成" },
  { value: "doing", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "archived", label: "归档" },
  { value: "all", label: "全部" },
];
const duration = (ms: number) => {
  if (ms > 0 && ms < 60000) return "不足 1 分钟";
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
};
const inStatus = (task: Task, filter: Filter, today: string) => {
  if (filter === "today") return !task.archived && task.status !== "done" && (!!task.plannedDate && task.plannedDate <= today || !!task.dueDate && task.dueDate <= today);
  return filter === "all" || (filter === "archived" ? !!task.archived : !task.archived && (filter === "open" ? task.status !== "done" : task.status === filter));
};

type TaskPanelProps = {
  state: Workspace;
  now: number;
  activeTaskId?: string;
  running: boolean;
  selectedTaskId?: string;
  projectFilter: string;
  onProjectFilter: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onStartTask: (id: string) => void;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  send: Sender;
  blocked: boolean;
  onNotice: (message: string) => void;
  onAddProject: () => void;
};

export function TaskPanel({ state, now, activeTaskId, running, selectedTaskId, projectFilter, onProjectFilter, onSelect, onEdit, onStartTask, adding, onAddingChange, send, blocked, onNotice, onAddProject }: TaskPanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("open");
  const [sort, setSort] = useState<"recent" | "created" | "due">("recent");
  const today = dayKey(now);
  const tomorrow = dayKey(now + 86_400_000);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const metrics = useMemo(() => {
    const result = new Map<string, { ms: number; latest: number }>();
    for (const session of state.sessions) {
      const current = result.get(session.taskId) ?? { ms: 0, latest: 0 };
      current.ms += sessionElapsedMs(session, now);
      for (const segment of session.segments) current.latest = Math.max(current.latest, segment.end ?? segment.start);
      result.set(session.taskId, current);
    }
    return result;
  }, [state.sessions, now]);
  const matchingTasks = state.tasks.filter(task =>
    (projectFilter === "all" || task.projectId === projectFilter) &&
    (!normalizedQuery || `${task.title}\n${task.notes}`.toLocaleLowerCase().includes(normalizedQuery)),
  );
  const filteredTasks = matchingTasks.filter(task => inStatus(task, filter, today)).sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) ||
    (sort === "due" ? (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") : 0) ||
    (sort === "recent" ? (metrics.get(b.id)?.latest ?? 0) - (metrics.get(a.id)?.latest ?? 0) : 0) ||
    b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
  const hasFilters = !!query || projectFilter !== "all" || filter !== "all";
  const clearFilters = () => { setQuery(""); setFilter("all"); onProjectFilter("all"); };
  const emptyCopy = filter === "today" ? ["今天还没有安排", "为任务设置计划日期，今天和已逾期的待完成任务会显示在这里。"]
    : filter === "archived" ? ["归档的任务，会留在这里", "暂时放下的任务可以归档，笔记和学习记录都会保留。"]
    : filter === "done" ? ["完成的任务，会留在这里", "完成后也能随时恢复，接着学习。"]
    : filter === "doing" ? ["还没有进行中的任务", "选择一个待完成任务，开始下一次专注。"]
    : ["待完成清单已经清空", "可以添加下一步，也可以回看已经完成的任务。"];

  function scheduleTask(task: Task, value: string) {
    if (value === "custom") { onEdit(task.id); return; }
    const plannedDate = value === "clear" ? null : value;
    if (send({ type: "task.update", id: task.id, plannedDate })) {
      const message = plannedDate === null ? "已清除计划日期" : plannedDate === today ? "已安排今天学习" : "已安排明天学习";
      const dueToday = task.dueDate && task.dueDate <= today;
      onNotice(dueToday && plannedDate !== today ? `${message}，截止日期已到，仍列在今天与逾期` : message);
    }
  }

  return <section className="card tasks-card task-management" aria-labelledby="task-list-heading">
    <div className="card-topline"><h2 id="task-list-heading" tabIndex={-1}>学习清单 <span className="count-badge">{state.tasks.filter(task => !task.archived).length}</span></h2><button className="text-button" disabled={blocked} aria-expanded={adding} onClick={() => onAddingChange(!adding)}><Plus size={16} aria-hidden="true" /> 添加任务</button></div>
    <div className="task-management-controls">
      <div className="task-search"><Search size={18} aria-hidden="true" /><label htmlFor="task-search" className="sr-only">搜索任务标题或笔记</label><input id="task-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务标题或笔记" />{query && <button className="task-control-icon" aria-label="清除搜索" onClick={() => setQuery("")}><X size={17} aria-hidden="true" /></button>}</div>
      <div className="task-filter-chips" role="group" aria-label="按任务状态筛选">{FILTERS.map(item => <button key={item.value} className={filter === item.value ? "active" : ""} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}<span>{matchingTasks.filter(task => inStatus(task, item.value, today)).length}</span></button>)}</div>
      <div className="task-select-filters"><label>学习项目<select aria-label="筛选项目" value={projectFilter} onChange={event => onProjectFilter(event.target.value)}><option value="all">全部项目</option>{state.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>排序方式<select aria-label="任务排序" value={sort} onChange={event => setSort(event.target.value as "recent" | "created" | "due")}><option value="recent">最近学习</option><option value="created">最近创建</option><option value="due">临近截止</option></select></label></div>
      <div className="task-results-summary"><span role="status">显示 {filteredTasks.length} 项<span className="task-sort-hint"> · 置顶优先</span></span>{hasFilters && state.tasks.length > 0 && <button className="quiet-button" onClick={clearFilters}>清除筛选</button>}</div>
      {activeTaskId && <p className="task-quick-help">开始其他任务前，请先结束当前专注。</p>}
    </div>
    {adding && <NewTaskForm projects={state.projects} projectFilter={projectFilter} disabled={blocked} onCancel={() => onAddingChange(false)} onSave={(title, projectId, plannedDate, dueDate) => {
      const id = crypto.randomUUID();
      if (send({ type: "task.add", id, projectId, title, ...(plannedDate ? { plannedDate } : {}), ...(dueDate ? { dueDate } : {}) })) {
        setQuery(""); setFilter("open"); onProjectFilter(projectId); onAddingChange(false); onSelect(id); onNotice("任务已加入学习清单");
      }
    }} />}
    <div className="task-list">{filteredTasks.length === 0 ? <div className="empty-tasks"><span className="empty-icon"><BookOpen size={27} strokeWidth={1.3} aria-hidden="true" /></span><h3>{state.tasks.length === 0 ? "把想学的，写下来" : normalizedQuery || projectFilter !== "all" ? "没有找到匹配的任务" : emptyCopy[0]}</h3><p>{state.tasks.length === 0 ? "一本书、一节课、一个小项目，都可以成为开始。" : normalizedQuery || projectFilter !== "all" ? "换个关键词，或清除筛选再看看。" : emptyCopy[1]}</p>{state.tasks.length === 0 ? <button className="secondary-button" disabled={blocked} onClick={() => onAddingChange(true)}><Plus size={16} aria-hidden="true" /> 添加第一个任务</button> : <button className="secondary-button" onClick={clearFilters}>{normalizedQuery || projectFilter !== "all" ? "清除筛选" : "查看全部任务"}</button>}</div> : filteredTasks.map(task => {
      const project = state.projects.find(item => item.id === task.projectId);
      const taskMs = metrics.get(task.id)?.ms ?? 0;
      const active = activeTaskId === task.id;
      const startLabel = active ? running ? "回到计时" : "继续专注" : "开始专注";
      return <div key={task.id} className={`task-row ${selectedTaskId === task.id ? "selected" : ""} ${task.status === "done" ? "done" : ""} ${task.archived ? "archived" : ""}`}>
        <button className="task-check" aria-label={task.status === "done" ? `将 ${task.title} 恢复为待完成` : `完成 ${task.title}`} disabled={blocked || active || !!task.archived} title={active ? "请先结束本次专注，再完成任务" : task.archived ? "恢复归档任务后可以更改状态" : undefined} onClick={() => {
          if (send({ type: "task.update", id: task.id, status: task.status === "done" ? "todo" : "done" })) onNotice(task.status === "done" ? "任务已恢复为待完成" : "任务完成了，辛苦了");
        }}>{task.status === "done" ? <CircleCheck size={22} aria-hidden="true" /> : <Circle size={22} strokeWidth={1.5} aria-hidden="true" />}</button>
        <button className="task-main" aria-label={`查看 ${task.title} 的详情`} aria-pressed={selectedTaskId === task.id} onClick={() => onSelect(task.id)}><strong title={task.title}>{task.title}</strong><span className="task-row-meta"><span className="task-project-name" title={project?.title}><i style={{ background: project?.color }} />{project?.title}</span><span className={`task-status ${task.status}`}>{task.archived ? "已归档" : active ? running ? "专注中" : "已暂停" : task.status === "doing" ? "进行中" : task.status === "done" ? "已完成" : "待开始"}</span></span><span className="task-duration">{taskMs > 0 ? `已学习 ${duration(taskMs)}` : "等待第一次专注"}</span></button>
        <button className="task-control-icon task-edit" aria-label={`编辑任务 ${task.title}`} title="编辑任务" onClick={() => onEdit(task.id)}><Pencil size={18} aria-hidden="true" /></button>
        {(task.plannedDate || task.dueDate) && <div className="task-dates">{task.plannedDate && <span>计划 {task.plannedDate}</span>}{task.dueDate && <span className={task.dueDate < today && task.status !== "done" ? "task-overdue" : ""}>截止 {task.dueDate}{task.dueDate < today && task.status !== "done" ? " · 已逾期" : ""}</span>}</div>}
        {task.nextStep && <p className="task-next-step">下一步 · {task.nextStep}</p>}
        {!task.archived && task.status !== "done" && <div className="task-quick-actions">
          <button type="button" className="secondary-button task-start-shortcut" disabled={blocked || !!activeTaskId && !active} aria-label={`${startLabel} · ${task.title}`} onClick={() => onStartTask(task.id)}>{active && running ? <Clock3 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{startLabel}</button>
          <select aria-label={`安排 ${task.title} 的计划学习日期`} value={task.plannedDate ?? ""} disabled={blocked} onChange={event => scheduleTask(task, event.target.value)}>
            <option value="" disabled>安排学习日期</option>
            <option value={today}>安排今天</option>
            <option value={tomorrow}>安排明天</option>
            {task.plannedDate && task.plannedDate !== today && task.plannedDate !== tomorrow && <option value={task.plannedDate}>计划 {task.plannedDate}</option>}
            <option value="custom">选择日期…</option>
            <option value="clear" disabled={!task.plannedDate}>清除计划</option>
          </select>
        </div>}
      </div>;
    })}</div>
    <div className="tasks-footer"><span><CloudCheck size={14} aria-hidden="true" /> 任务与笔记自动保存</span><button className="quiet-button mobile-add-project" onClick={onAddProject}><FolderPlus size={14} aria-hidden="true" /> 新建项目</button></div>
  </section>;
}

function NewTaskForm({ projects, projectFilter, disabled, onSave, onCancel }: { projects: Workspace["projects"]; projectFilter: string; disabled: boolean; onSave: (title: string, projectId: string, plannedDate: string, dueDate: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [selectedProjectId, setProjectId] = useState(projectFilter !== "all" ? projectFilter : projects[0]?.id ?? "");
  const projectId = projects.some(project => project.id === selectedProjectId) ? selectedProjectId : projects[0]?.id ?? "";
  return <form className="new-task-form" onSubmit={event => { event.preventDefault(); if (title.trim() && projectId && !disabled) onSave(title.trim(), projectId, plannedDate, dueDate); }}><label htmlFor="new-task-title">想学习什么？</label><input autoFocus id="new-task-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="给这一步取个名字，例如：完成登录界面" required disabled={disabled} /><div className="task-date-fields"><label>计划学习日期<input type="date" value={plannedDate} disabled={disabled} onChange={event => setPlannedDate(event.target.value)} /></label><label>截止日期<input type="date" value={dueDate} disabled={disabled} onChange={event => setDueDate(event.target.value)} /></label></div><div><label className="new-task-project">所属项目<select value={projectId} onChange={event => setProjectId(event.target.value)} required disabled={disabled}>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><span><button type="button" className="quiet-button" onClick={onCancel}>取消</button><button className="small-primary" type="submit" disabled={disabled}><Plus size={14} aria-hidden="true" /> 添加任务</button></span></div></form>;
}

export function TaskNotes({ task, projects, relatedNotes = [], onOpenNotes, disabled, activeLocked, recordCount, studyMs, send, onNotice, onDeleted }: { task: Task; projects: Workspace["projects"]; relatedNotes?: NonNullable<Workspace["notes"]>; onOpenNotes?: (entryId: string | null, create: boolean) => void; disabled: boolean; activeLocked: boolean; recordCount: number; studyMs: number; send: Sender; onNotice: (message: string) => void; onDeleted: () => void }) {
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [historyConsentFor, setHistoryConsentFor] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteHeadingId = useId();
  const deleteDescriptionId = useId();
  const deleteBlockedId = useId();
  const historyFingerprint = `${recordCount}:${studyMs}`;
  const hasHistory = recordCount > 0;
  const historyConsent = historyConsentFor === historyFingerprint;
  const invalidTitle = titleDraft !== null && !titleDraft.trim();
  useEffect(() => { if (confirmingDelete) cancelDeleteRef.current?.focus(); }, [confirmingDelete]);
  function archiveTask() {
    if (send({ type: "task.update", id: task.id, archived: !task.archived })) onNotice(task.archived ? "任务已恢复，可以继续专注" : "任务已归档，笔记和学习记录仍然保留");
  }
  function cancelDelete() {
    setConfirmingDelete(false);
    setHistoryConsentFor(null);
    deleteTriggerRef.current?.focus();
  }
  function deleteTask() {
    if (disabled || activeLocked || (hasHistory && !historyConsent)) return;
    if (send({ type: "task.delete", id: task.id, ...(hasHistory ? { deleteHistory: true } : {}) })) {
      onNotice(hasHistory ? "任务和对应学习记录已删除，统计已更新" : "任务已删除");
      onDeleted();
    }
  }
  return <div className="task-notes task-detail">
    {task.archived && <div className="task-detail-state"><span><Archive size={16} aria-hidden="true" /> 任务已归档</span><button className="quiet-button" disabled={disabled} onClick={archiveTask}><ArchiveRestore size={16} aria-hidden="true" /> 恢复任务</button></div>}
    {!task.archived && task.status === "done" && <div className="task-detail-state"><span><CircleCheck size={16} aria-hidden="true" /> 已完成</span><button className="quiet-button" disabled={disabled || activeLocked} onClick={() => { if (send({ type: "task.update", id: task.id, status: "todo" })) onNotice("任务已恢复为待完成"); }}><Undo2 size={16} aria-hidden="true" /> 恢复待完成</button></div>}
    <p className="task-edit-hint">直接编辑名称、状态、项目和任务随记，改动会自动保存。</p>
    <label htmlFor="task-title">任务名称</label><input id="task-title" className="note-title-input" maxLength={160} value={titleDraft ?? task.title} disabled={disabled} aria-invalid={invalidTitle} onChange={event => { const value = event.target.value; setTitleDraft(value); if (value.trim()) send({ type: "task.update", id: task.id, title: value.trim() }); }} onBlur={() => setTitleDraft(null)} />
    <div className="task-detail-fields"><label htmlFor="task-status">任务状态<select id="task-status" aria-label="任务状态" value={task.status} disabled={disabled || activeLocked || !!task.archived} onChange={event => send({ type: "task.update", id: task.id, status: event.target.value as Task["status"] })}><option value="todo">待开始</option><option value="doing">进行中</option><option value="done">已完成</option></select></label><label htmlFor="task-project">所属项目<select id="task-project" aria-label="所属项目" value={task.projectId} disabled={disabled} onChange={event => send({ type: "task.update", id: task.id, projectId: event.target.value })}>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label></div>
    <p className="task-project-hint">调整项目后，关联的学习笔记与历史学习时间会一同归入新项目。</p>
    <div className="task-date-fields"><label htmlFor="task-planned-date">计划学习日期<input id="task-planned-date" type="date" value={task.plannedDate ?? ""} disabled={disabled} onChange={event => send({ type: "task.update", id: task.id, plannedDate: event.target.value || null })} /></label><label htmlFor="task-due-date">截止日期<input id="task-due-date" type="date" value={task.dueDate ?? ""} disabled={disabled} onChange={event => send({ type: "task.update", id: task.id, dueDate: event.target.value || null })} /></label></div>
    <label htmlFor="task-next-step">下次第一步<input id="task-next-step" maxLength={2000} value={task.nextStep ?? ""} disabled={disabled} placeholder="例如：从第 3 题的递归边界继续" onChange={event => send({ type: "task.update", id: task.id, nextStep: event.target.value })} /></label>
    {onOpenNotes && <section className="task-linked-notes" aria-label={`${task.title}的学习笔记`}>
      <div className="task-linked-notes-heading"><h3><BookOpen size={16} aria-hidden="true" /> 学习笔记 <span>{relatedNotes.length + (task.notes.trim() ? 1 : 0)}</span></h3><button className="quiet-button" disabled={disabled} onClick={() => onOpenNotes(null, true)}><Plus size={16} aria-hidden="true" /> 新建笔记</button></div>
      <ul>{relatedNotes.slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(note => <li key={note.id}><button onClick={() => onOpenNotes(note.id, false)}><FileText size={16} aria-hidden="true" /><span title={note.title}>{note.title}</span>{note.important && <Star size={14} fill="currentColor" aria-label="重点笔记" />}</button></li>)}{task.notes.trim() && <li><button onClick={() => onOpenNotes(`task:${task.id}`, false)}><FileText size={16} aria-hidden="true" /><span>原任务笔记</span></button></li>}</ul>
      {!relatedNotes.length && !task.notes.trim() && <p>为这个任务记录代码、知识点和易错题。</p>}
      {(relatedNotes.length > 0 || task.notes.trim()) && <button className="text-button" onClick={() => onOpenNotes(null, false)}>查看全部笔记</button>}
    </section>}
    <label htmlFor="task-notes" className="note-label">任务随记 / 下次从哪里继续</label><textarea id="task-notes" maxLength={20000} disabled={disabled} value={task.notes} placeholder={"今天学到了什么…\n\n下次从这里继续…"} onChange={event => send({ type: "task.update", id: task.id, notes: event.target.value })} />
    <div className="note-save-state"><CheckCheck size={13} aria-hidden="true" />{invalidTitle ? "任务名不能为空，暂时保留原名" : "每次输入都会在本机保存，并自动同步"}</div>
    <div className="task-detail-actions"><button className="quiet-button" disabled={disabled} aria-pressed={!!task.pinned} onClick={() => send({ type: "task.update", id: task.id, pinned: !task.pinned })}>{task.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}{task.pinned ? "取消置顶" : "置顶任务"}</button>{!task.archived && <button className="quiet-button" disabled={disabled || activeLocked} onClick={archiveTask}><Archive size={16} aria-hidden="true" /> 归档任务</button>}<button ref={deleteTriggerRef} className="quiet-button task-delete-trigger" disabled={disabled || activeLocked} aria-expanded={confirmingDelete} aria-describedby={disabled || activeLocked ? deleteBlockedId : undefined} onClick={() => { setHistoryConsentFor(null); setConfirmingDelete(true); }}><Trash2 size={16} aria-hidden="true" /> 删除任务</button></div>
    <p className="task-archive-hint">{activeLocked ? "请先结束当前专注，再完成或归档任务。" : task.archived ? "笔记和学习记录都已保留，恢复后可继续计时。" : "归档会收起任务，笔记和学习记录都会保留。"}</p>
    {(disabled || activeLocked) && <p id={deleteBlockedId} className="task-delete-help">{activeLocked ? "请先结束当前专注，再删除任务；暂停时也不能删除。" : "请先处理同步状态，再删除任务。"}</p>}
    {confirmingDelete && <div className="task-delete-confirm" role="group" aria-labelledby={deleteHeadingId} aria-describedby={deleteDescriptionId} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDelete(); } }}>
      <h3 id={deleteHeadingId}>删除“{task.title}”？</h3>
      <p id={deleteDescriptionId}>{hasHistory ? <>将删除这个任务、原任务笔记和对应的 <strong>{recordCount} 条学习记录</strong>（共 {duration(studyMs)}），每日汇总和学习统计也会相应减少。删除后无法恢复。</> : "将删除这个任务和原任务笔记，删除后无法恢复。这个任务没有学习记录。"}</p>
      {relatedNotes.length > 0 && <p>关联的 {relatedNotes.length} 篇独立学习笔记会保存在原项目中，并解除任务关联。</p>}
      <p>此任务的复习题与作答记录也会删除。</p>
      {hasHistory && <label className="task-delete-consent"><input type="checkbox" checked={historyConsent} disabled={disabled || activeLocked} onChange={event => setHistoryConsentFor(event.target.checked ? historyFingerprint : null)} /><span>我同意同时删除这些学习记录，并更新学习统计</span></label>}
      <div className="task-delete-confirm-actions"><button ref={cancelDeleteRef} className="quiet-button" onClick={cancelDelete}>取消</button><button className="task-delete-final" disabled={disabled || activeLocked || (hasHistory && !historyConsent)} onClick={deleteTask}><Trash2 size={16} aria-hidden="true" /> 确认删除</button></div>
    </div>}
  </div>;
}

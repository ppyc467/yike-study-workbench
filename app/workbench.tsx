"use client";

import Link from "next/link";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, ArrowRight, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, CircleCheck, Clock3, CloudCheck, CloudOff, History, LayoutDashboard, Leaf, LoaderCircle, LogOut, MessageCircle, MoreHorizontal, Pause, PencilLine, Play, Plus, Settings2, ShieldCheck, Sparkles, Square, Target, X } from "lucide-react";
import { dayKey, sessionElapsedMs, totalsByDay, effectiveSessionSegments, type Command, type Workspace } from "../lib/study";
import { useWorkspace } from "../lib/use-workspace";
import { TaskPanel, TaskNotes } from "./task-panel";
import TaskChat from "./task-chat";
import StatisticsPanel from "./statistics-panel";
import ProjectManager from "./project-manager";
import NotesPanel from "./notes-panel";
import ReviewPanel from "./review-panel";
import BackupPanel from "./backup-panel";
import SyncConflictPanel from "./sync-conflict-panel";
import OfflineSupport from "./offline-support";
import "./responsive.css";

type User = { userId: string; displayName: string };
type Action = Command extends infer T ? T extends { at: number } ? Omit<T, "at"> : never : never;
type Store = ReturnType<typeof useWorkspace>;
const COLORS = ["#779b7e", "#ba9b70", "#8093b2", "#ac88a0", "#80a8a4", "#c98c75"];
const dateText = (ms: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(ms);
const clockText = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`; };
const duration = (ms: number) => { if (ms > 0 && ms < 60000) return "不足 1 分钟"; const m = Math.floor(Math.max(0, ms) / 60000); return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`; };
const uniqueId = () => crypto.randomUUID();

export default function Workbench({ user }: { user: User }) {
  const store = useWorkspace(user.userId);
  return <><OfflineSupport userKey={user.userId} />{store.state ? <ReadyWorkbench user={user} store={store} state={store.state} /> : <div className="loading-page"><span className="brand-symbol"><Leaf size={26} /></span><h1>一刻</h1><p>{store.status === "auth" ? "请登录后打开你的学习空间。" : store.message || "正在打开你的学习空间…"}</p>{(store.status === "error" || store.status === "offline") ? <button className="primary-button" onClick={store.retry}>重新连接</button> : store.status === "auth" ? <a className="primary-button" href="/signin-with-chatgpt?return_to=%2F" target="_top">重新登录</a> : <LoaderCircle className="spin" size={20} />}</div>}</>;
}

function ReadyWorkbench({ user, store, state }: { user: User; store: Store; state: Workspace }) {
  const { now, status } = store;
  const [view, setView] = useState<"desk" | "notes" | "history" | "settings">("desk");
  const [notesProjectId, setNotesProject] = useState("all");
  const [initialNoteId, setInitialNoteId] = useState<string | null>(null);
  const [notesTaskId, setNotesTask] = useState("all");
  const [createNoteOnOpen, setCreateNoteOnOpen] = useState(false);
  const notesTask = notesTaskId === "unlinked" || state.tasks.some(task => task.id === notesTaskId) ? notesTaskId : "all";
  const notesProject = state.projects.some(project => project.id === notesProjectId) ? notesProjectId : "all";
  const [historyDate, setHistoryDate] = useState(dayKey(now));
  const [historyProjectId, setHistoryProject] = useState<string | undefined>();
  const [projectFilterId, setProjectFilter] = useState("all");
  const historyProject = state.projects.some(project => project.id === historyProjectId) ? historyProjectId : undefined;
  const projectFilter = state.projects.some(project => project.id === projectFilterId) ? projectFilterId : "all";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskTab, setTaskTab] = useState<"chat" | "notes">("chat");
  const [mode, setMode] = useState<"free" | "pomodoro">(() => state.sessions.find(s => s.id === state.activeSessionId)?.mode ?? "free");
  const [pomodoroMinutes, setPomodoroMinutes] = useState(() => { const current = state.sessions.find(s => s.id === state.activeSessionId); return current?.mode === "pomodoro" ? Math.round(current.targetMs / 60000) : 25; });
  const [addTask, setAddTask] = useState(false);
  const [addProject, setAddProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [goalEditing, setGoalEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [resumeTaskId, setResumeTaskId] = useState<string | null>(null);
  const [knownSessionId, setKnownSessionId] = useState(state.activeSessionId);
  const focusCard = useRef<HTMLElement | null>(null);
  const timerControls = useRef<HTMLDivElement | null>(null);
  const notesCard = useRef<HTMLElement | null>(null);
  const completedNotices = useRef(new Set<string>());
  const [focusCardVisible, setFocusCardVisible] = useState(true);
  const active = state.sessions.find(s => s.id === state.activeSessionId);
  if (active && active.id !== knownSessionId) {
    setKnownSessionId(active.id);
    setMode(active.mode);
    if (active.mode === "pomodoro") setPomodoroMinutes(Math.round(active.targetMs / 60000));
  }
  const activeTask = state.tasks.find(t => t.id === active?.taskId);
  const selectedTask = state.tasks.find(t => t.id === selectedId) ?? activeTask ?? state.tasks.find(t => !t.archived && t.status !== "done") ?? state.tasks.find(t => !t.archived);
  const selectedTaskSessions = selectedTask ? state.sessions.filter(session => session.taskId === selectedTask.id) : [];
  const selectedTaskMs = selectedTaskSessions.reduce((sum, session) => sum + sessionElapsedMs(session, now), 0);
  const timerTask = active ? activeTask : selectedTask;
  const resumeTask = state.tasks.find(task => task.id === resumeTaskId);
  const timerProject = state.projects.find(p => p.id === timerTask?.projectId);
  const elapsed = active ? sessionElapsedMs(active, now) : 0;
  const naturalDone = !!active && active.mode === "pomodoro" && elapsed >= active.targetMs;
  const running = !!active && !naturalDone && active.segments.some(s => s.end === null);
  const timerMode = active ? active.mode : mode;
  const displayedTime = timerMode === "pomodoro" ? Math.max(0, (active?.targetMs ?? pomodoroMinutes * 60000) - elapsed) : elapsed;
  const today = dayKey(now);
  const daily = totalsByDay(state, now);
  const todayMs = daily[today] ?? 0;
  const completed = state.tasks.filter(t => t.status === "done").length;
  const blocked = status === "conflict" || status === "auth" || status === "error";
  const floatingTimer = !!active && (view !== "desk" || !focusCardVisible);
  const send = (action: Action) => { const saved = store.dispatch({ ...action, at: Date.now() } as Command); if (!saved) setNotice("操作未完成，请检查输入或同步状态"); return saved; };
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(""), 3500); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    if (view !== "desk" || !timerControls.current) return;
    const observer = new IntersectionObserver(([entry]) => setFocusCardVisible(entry.isIntersecting && entry.intersectionRatio >= 0.8), {
      rootMargin: window.matchMedia("(max-width: 700px)").matches ? "-60px 0px -76px 0px" : "-60px 0px 0px 0px",
      threshold: [0, 0.8, 1],
    });
    observer.observe(timerControls.current);
    return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    if (!active || !naturalDone || completedNotices.current.has(active.id)) return;
    completedNotices.current.add(active.id);
    setResumeTaskId(active.taskId);
    setNotice(`本次番茄专注已完成，已积累 ${duration(active.targetMs)}。休息一下吧。`);
  }, [active, naturalDone]);
  useEffect(() => {
    document.title = active ? `${naturalDone ? "专注完成" : running ? "专注中" : "已暂停"} ${clockText(displayedTime)} · ${active.mode === "pomodoro" ? "番茄专注" : "自由计时"} · ${activeTask?.title ?? "当前学习任务"} · 一刻` : "一刻 · 学习工作台";
  }, [active, activeTask?.title, naturalDone, running, displayedTime]);
  useEffect(() => () => { document.title = "一刻 · 学习工作台"; }, []);

  function selectTask(id: string) {
    setSelectedId(id);
    setTaskTab("chat");
    if (window.matchMedia("(max-width: 700px)").matches) requestAnimationFrame(() => notesCard.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
  }
  function editTask(id: string) {
    setSelectedId(id);
    setTaskTab("notes");
    requestAnimationFrame(() => {
      notesCard.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
      const title = document.getElementById("task-title") as HTMLInputElement | null;
      title?.focus({ preventScroll: true });
      title?.select();
    });
  }
  function openNotes(projectId = "all", entryId: string | null = null, taskFilter = "all", create = false) {
    setNotesProject(projectId);
    setInitialNoteId(entryId);
    setNotesTask(taskFilter);
    setCreateNoteOnOpen(create);
    setView("notes");
    requestAnimationFrame(() => document.getElementById("notes-heading")?.scrollIntoView({ block: "start" }));
  }
  function taskDeleted() {
    setSelectedId(null);
    requestAnimationFrame(() => document.getElementById("task-list-heading")?.focus({ preventScroll: true }));
  }
  function returnToTimer() {
    setView("desk");
    requestAnimationFrame(() => focusCard.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
  }
  function openHistoryDay(date: string) {
    setHistoryDate(date);
    setView("history");
    requestAnimationFrame(() => {
      const detail = document.getElementById("daily-history");
      detail?.focus({ preventScroll: true });
      detail?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    });
  }
  function openProjectManager(focusNew = false) {
    setView("settings");
    setAddProject(false);
    requestAnimationFrame(() => {
      const target = document.getElementById(focusNew ? "settings-project-name" : "project-management");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    });
  }
  function changeMode(nextMode: "free" | "pomodoro") {
    if (naturalDone && !send({ type: "session.finish" })) return;
    setMode(nextMode);
  }

  function newProject(event: FormEvent) {
    event.preventDefault();
    if (!newProjectTitle.trim()) return;
    const id = uniqueId();
    if (send({ type: "project.add", id, title: newProjectTitle.trim(), color: COLORS[state.projects.length % COLORS.length] })) { setNewProjectTitle(""); setAddProject(false); setProjectFilter(id); setNotice("学习项目已创建"); }
  }
  function start(taskId = selectedTask?.id) {
    if (blocked) return;
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) { setAddTask(true); return; }
    if (task.archived) { setNotice("请先恢复归档任务，再开始专注"); return; }
    if (active && !naturalDone) {
      if (active.taskId !== task.id) setNotice("请先结束当前专注，再开始另一项任务");
      else if (!running) send({ type: "session.resume" });
      returnToTimer();
      return;
    }
    const nextMode = active?.mode ?? mode;
    const targetMs = nextMode === "pomodoro" ? active?.targetMs ?? pomodoroMinutes * 60000 : 0;
    if (send({ type: "session.start", id: uniqueId(), taskId: task.id, mode: nextMode, targetMs })) {
      setSelectedId(task.id);
      setNotice("这一刻，专注开始了");
      returnToTimer();
    }
  }
  function finish() {
    const taskId = active?.taskId;
    if (send({ type: "session.finish" })) {
      setResumeTaskId(taskId ?? null);
      setNotice("本次学习已记录，辛苦了");
    }
  }
  function saveQuiz(questions: { question: string; answer: string }[]) {
    if (!selectedTask) return false;
    const saved = send({ type: "review.add", cards: questions.map(question => ({ ...question, id: uniqueId(), taskId: selectedTask.id })) });
    if (saved) setNotice(`已保存 ${questions.length} 道题，可在工作台「主动回忆」作答`);
    return saved;
  }
  const syncText = { loading: "正在连接", synced: store.localPreview ? "已保存到本机" : "已自动保存", saving: "正在保存", offline: "离线 · 本机已暂存", conflict: "有同步冲突", error: "同步待重试", auth: "需要重新登录" }[status];

  return <div className={`app-shell ${floatingTimer ? "has-floating-timer" : ""}`}>
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <aside className="sidebar"><Link className="brand" href="/"><span className="brand-symbol"><Leaf size={24} strokeWidth={1.8} /></span><span>一刻<span className="brand-subtitle">MY STUDY SPACE</span></span></Link><div className="sidebar-caption">我的空间</div><nav className="main-navigation" aria-label="主导航"><button className={view === "desk" ? "nav-link active" : "nav-link"} onClick={() => setView("desk")}><LayoutDashboard size={19} /> 工作台<span className="nav-active-dot" /></button><button className={view === "notes" ? "nav-link active" : "nav-link"} onClick={() => openNotes()}><BookOpen size={19} /> 学习笔记</button><button className={view === "history" ? "nav-link active" : "nav-link"} onClick={() => setView("history")}><History size={19} /> 学习统计</button><button className={view === "settings" ? "nav-link active" : "nav-link"} onClick={() => setView("settings")}><Settings2 size={19} /> 设置</button></nav>
      <div className="sidebar-project-heading"><span className="sidebar-caption">学习项目</span><div className="sidebar-project-actions"><button className="quiet-button" aria-label="管理学习项目" onClick={() => openProjectManager()}>管理</button><button className="icon-button" aria-label="新建学习项目" onClick={() => setAddProject(!addProject)}><Plus size={16} /></button></div></div><div className="project-navigation"><button className={(view === "notes" ? notesProject === "all" : projectFilter === "all" && view === "desk") ? "project-link selected" : "project-link"} onClick={() => { if (view === "notes") { setNotesProject("all"); setNotesTask("all"); } else { setProjectFilter("all"); setView("desk"); } }}><span className="project-all"><BookOpen size={15} /></span>全部项目<span>{view === "notes" ? (state.notes?.length ?? 0) + state.tasks.filter(t => t.notes.trim()).length : state.tasks.filter(t => !t.archived && t.status !== "done").length}</span></button>{state.projects.map(p => <button key={p.id} className={(view === "notes" ? notesProject === p.id : projectFilter === p.id && view === "desk") ? "project-link selected" : "project-link"} onClick={() => { if (view === "notes") { setNotesProject(p.id); setNotesTask("all"); } else { setProjectFilter(p.id); setView("desk"); } }}><i style={{ background: p.color }} /><span className="sidebar-project-title" title={p.title}>{p.title}</span><span>{view === "notes" ? (state.notes ?? []).filter(note => note.projectId === p.id).length + state.tasks.filter(t => t.projectId === p.id && t.notes.trim()).length : state.tasks.filter(t => !t.archived && t.projectId === p.id && t.status !== "done").length}</span></button>)}</div>
      {addProject && <form className="project-form" onSubmit={newProject}><label htmlFor="project-name">新项目名称</label><input autoFocus id="project-name" maxLength={80} value={newProjectTitle} onChange={e => setNewProjectTitle(e.target.value)} placeholder="例如：Qt 大作业" required /><div><button type="button" className="quiet-button" onClick={() => setAddProject(false)}>取消</button><button className="small-primary" disabled={blocked}>创建</button></div></form>}
      <div className="sidebar-bottom"><div className="gentle-note"><Sparkles size={20} strokeWidth={1.5} /><p>慢慢来，<br />每一刻都在积累。</p><span>KEEP GROWING</span></div><div className="user-profile"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName.includes("@") ? user.displayName.split("@")[0] : user.displayName}</strong><small>{store.localPreview ? "本机体验账号" : "我的个人工作台"}</small></span><button className="icon-button" aria-label="打开账号设置" onClick={() => setView("settings")}><MoreHorizontal size={19} /></button></div></div>
    </aside>

    <div className="main-shell"><header className="topbar"><span className="breadcrumb"><span className="mobile-brand"><Leaf size={18} /> 一刻<span>/</span></span><span className="breadcrumb-space">我的空间</span><ChevronRight size={13} className="breadcrumb-divider" /><strong>{view === "desk" ? "工作台" : view === "notes" ? "学习笔记" : view === "history" ? "学习统计" : "设置"}</strong></span><button className={`sync-status ${status}`} onClick={status === "error" || status === "offline" ? store.retry : undefined} aria-label={syncText}>{status === "synced" ? <CloudCheck size={16} /> : status === "offline" ? <CloudOff size={16} /> : status === "saving" || status === "loading" ? <LoaderCircle className="spin" size={15} /> : <CloudOff size={16} />}<span>{syncText}</span></button></header>
      <main id="main-content" className="main-content">
        {store.localPreview && <div className="preview-banner" role="status"><MonitorPreviewIcon /><span><strong>本机预览</strong> · 这里使用独立的本机数据；电脑与手机同步请打开已发布的网站</span></div>}
        {(status === "offline" || status === "error" || status === "conflict" || status === "auth") && <div role="status" className="status-banner"><div><strong>{status === "conflict" ? "另一台设备更新了你的学习记录" : status === "offline" ? "暂时离线，继续学习也没关系" : status === "auth" ? "登录已过期" : "这次同步没有完成"}</strong><p>{store.message || "本机记录已保留，联网后将继续同步。"}</p></div><div className="banner-actions"><button onClick={store.exportBackup}>保存备份</button>{(status === "conflict" || status === "error") ? <button onClick={store.resolveConflict}>重新加载云端</button> : status === "auth" ? <a href="/signin-with-chatgpt?return_to=%2F" target="_top">重新登录</a> : <button onClick={store.retry}>重新连接</button>}</div></div>}
        {status === "conflict" && <SyncConflictPanel details={store.conflictDetails} keepLocal={store.keepLocalConflict} loadRemote={store.resolveConflict} />}
        {view !== "notes" && <div className="page-heading"><div><div className="eyebrow">{view === "desk" ? "MAKE TIME FOR YOURSELF" : view === "history" ? "YOUR TIME, WELL SPENT" : "A SPACE THAT FEELS LIKE YOU"}</div><h1>{view === "desk" ? "今天，也向前一点。" : view === "history" ? "每一步，都算数。" : "你的空间，你的节奏。"}</h1><p>{view === "desk" ? "从一件小事开始，把此刻交给专注。" : view === "history" ? "看看最近的投入，找到适合自己的学习节奏。" : "让学习工作台，适合你自己的习惯。"}</p></div><span className="date-chip"><CalendarDays size={16} />{dateText(now)}</span></div>}

        {resumeTask && <ResumeStepForm key={resumeTask.id} title={resumeTask.title} value={resumeTask.nextStep ?? ""} blocked={blocked} onSave={nextStep => { if (send({ type: "task.update", id: resumeTask.id, nextStep })) setResumeTaskId(null); }} onSkip={() => setResumeTaskId(null)} />}
        {view === "desk" && <>
          <div className="focus-grid"><section id="focus-timer" ref={focusCard} className="card focus-card" aria-label="专注计时器"><div className="card-topline"><h2><span className="tiny-icon"><TimerIcon /></span>此刻专注</h2><span className={`focus-state ${running ? "running" : ""}`}><i />{running ? "专注进行中" : naturalDone ? "本次专注已完成" : active ? "已暂停，随时继续" : "准备好，就开始"}</span></div><div className="timer-modes" aria-label="计时模式"><button disabled={blocked || !!active && !naturalDone} className={timerMode === "free" ? "selected" : ""} onClick={() => changeMode("free")}><Clock3 size={15} /> 自由计时</button><button disabled={blocked || !!active && !naturalDone} className={timerMode === "pomodoro" ? "selected" : ""} onClick={() => changeMode("pomodoro")}><Target size={15} /> 番茄专注</button></div>
            <div className="timer-context"><span className="project-color" style={{ background: timerProject?.color ?? "#b3c6ab" }} /><span className="timer-task-title" title={timerTask?.title}>{timerTask ? timerTask.title : "为想做的事，留一段时间"}</span>{timerProject && <span className="timer-project" title={timerProject.title}>{timerProject.title}</span>}</div><div className={`timer-number ${timerMode === "pomodoro" ? "countdown" : ""}`} aria-label={`计时时间 ${clockText(displayedTime)}`}>{clockText(displayedTime).split(":").map((part, index) => <span key={index}>{index > 0 && <b>:</b>}{part}</span>)}</div><p className="timer-caption">{naturalDone ? "做得很好。喝口水，让思路歇一歇。" : running ? "只管专注，时间会替你记录。" : active ? "休息一下，暂停的时间不会计入学习。" : "不必一次走很远，开始就是进步。"}</p>
            {timerTask?.nextStep && <p className="timer-next-step">下次第一步 · {timerTask.nextStep}</p>}
            {mode === "pomodoro" && !active && <label className="pomodoro-setting">专注时长 <input aria-label="番茄钟分钟数" type="number" min={1} max={180} value={pomodoroMinutes} onChange={e => setPomodoroMinutes(Math.max(1, Math.min(180, Number(e.target.value) || 1)))} /> 分钟</label>}
            {naturalDone && selectedTask && selectedTask.id !== activeTask?.id && <p className="next-session-target">下一次：{selectedTask.title}</p>}
            <div ref={timerControls} className="timer-controls">{active && !naturalDone ? <><button className="primary-button timer-start" disabled={blocked} onClick={() => send({ type: running ? "session.pause" : "session.resume" })}>{running ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}{running ? "暂停一下" : "继续专注"}</button><button className="secondary-button" disabled={blocked} onClick={finish}><Square size={15} /> 结束</button></> : <><button className="primary-button timer-start" disabled={blocked || !!selectedTask?.archived} onClick={() => start()}><Play size={17} fill="currentColor" />{selectedTask?.archived ? "恢复任务后开始" : naturalDone ? selectedTask?.id !== activeTask?.id ? "开始所选任务" : "开启下一次专注" : selectedTask ? "开始专注" : "添加任务，开始专注"}</button>{naturalDone && <button className="secondary-button" disabled={blocked} onClick={finish}><Check size={17} /> 完成</button>}</>}</div><div className="timer-footer"><ShieldCheck size={14} /><span>进度自动保存，关闭页面也会继续计时</span></div>
          </section><section className="card today-card"><div className="card-topline"><h2>今日积累</h2><span className="soft-icon"><Leaf size={18} strokeWidth={1.5} /></span></div><div className="today-time"><strong>{Math.floor(todayMs / 3600000)}</strong><span>小时</span><strong>{Math.floor(todayMs / 60000) % 60}</strong><span>分钟</span></div><div className="goal-caption"><span>每日目标 · {state.goalMinutes ? `${state.goalMinutes} 分钟` : "不限时长"}</span><button className="icon-button" aria-label="调整每日目标" onClick={() => setGoalEditing(!goalEditing)}><PencilLine size={14} /></button>{state.goalMinutes > 0 && <strong>{Math.min(100, Math.floor(todayMs / (state.goalMinutes * 60000) * 100))}%</strong>}</div><div className="progress-track"><span style={{ width: `${state.goalMinutes ? Math.min(100, todayMs / (state.goalMinutes * 60000) * 100) : 0}%` }} /></div>{goalEditing && <GoalForm value={state.goalMinutes} onSave={minutes => { if (send({ type: "settings.goal", minutes })) setGoalEditing(false); }} onCancel={() => setGoalEditing(false)} />}<p className="goal-message">{state.goalMinutes && todayMs >= state.goalMinutes * 60000 ? "今天的目标达成了，给自己一点掌声。" : todayMs > 0 ? "一点一滴，都是向前的证据。" : "今天的第一份积累，从下一刻开始。"}</p><div className="project-breakdown"><span className="section-caption">时间都去了哪里</span>{state.projects.map(p => { const ids = new Set(state.tasks.filter(t => t.projectId === p.id).map(t => t.id)); const ms = totalsByDay({ ...state, sessions: state.sessions.filter(s => ids.has(s.taskId)) }, now)[today] ?? 0; return <div className="project-stat" key={p.id}><span title={p.title}><i style={{ background: p.color }} />{p.title}</span><strong>{Math.floor(ms / 60000)} <small>分钟</small></strong></div>; })}</div><div className="today-bottom"><CircleCheck size={15} /><span>累计完成 {completed} 个学习任务</span></div></section></div>

          <section className="mobile-today-summary" aria-label="今日学习进度"><div><span><Clock3 size={15} /> 今日积累</span><strong>{duration(todayMs)}</strong></div><div className="mobile-today-goal"><span>{state.goalMinutes > 0 ? todayMs >= state.goalMinutes * 60000 ? "今日目标已达成" : `还差 ${Math.ceil((state.goalMinutes * 60000 - todayMs) / 60000)} 分钟` : "按自己的节奏积累"}</span><button className="text-button" onClick={() => { setHistoryProject(undefined); openHistoryDay(today); }} aria-label="查看今日学习记录"><ChevronRight size={18} /></button></div></section>
          <div className="work-grid">
            <TaskPanel state={state} now={now} activeTaskId={!naturalDone ? active?.taskId : undefined} running={running} selectedTaskId={selectedTask?.id} projectFilter={projectFilter} onProjectFilter={setProjectFilter} onSelect={selectTask} onEdit={editTask} onStartTask={start} adding={addTask} onAddingChange={setAddTask} send={send} blocked={blocked} onNotice={setNotice} onAddProject={() => openProjectManager(true)} />
            <section ref={notesCard} className="card notes-card">
              <div className="card-topline"><h2><MessageCircle size={17} /> 任务学习空间</h2><button className="text-button task-open-notebook" onClick={() => openNotes(selectedTask?.projectId ?? "all", null, selectedTask?.id ?? "all")}><BookOpen size={15} aria-hidden="true" /> 打开学习笔记</button></div>
              {selectedTask ? <>
                <div className="task-detail-tabs" role="tablist" aria-label="任务学习空间">
                  <button id="task-chat-tab" role="tab" aria-selected={taskTab === "chat"} aria-controls="task-chat-panel" tabIndex={taskTab === "chat" ? 0 : -1} onClick={() => setTaskTab("chat")} onKeyDown={event => { if (["ArrowRight", "ArrowLeft", "End"].includes(event.key)) { event.preventDefault(); setTaskTab("notes"); document.getElementById("task-notes-tab")?.focus(); } }}><MessageCircle size={16} aria-hidden="true" />学习对话</button>
                  <button id="task-notes-tab" role="tab" aria-selected={taskTab === "notes"} aria-controls="task-notes-panel" tabIndex={taskTab === "notes" ? 0 : -1} onClick={() => setTaskTab("notes")} onKeyDown={event => { if (["ArrowRight", "ArrowLeft", "Home"].includes(event.key)) { event.preventDefault(); setTaskTab("chat"); document.getElementById("task-chat-tab")?.focus(); } }}><PencilLine size={16} aria-hidden="true" />任务与笔记</button>
                </div>
                <div id="task-chat-panel" role="tabpanel" aria-labelledby="task-chat-tab" hidden={taskTab !== "chat"}><TaskChat key={`${user.userId}:${selectedTask.id}`} task={selectedTask} userKey={user.userId} disabled={status !== "synced"} relatedNotes={(state.notes ?? []).filter(note => note.taskId === selectedTask.id)} onQuizGenerated={saveQuiz} /></div>
                <div id="task-notes-panel" role="tabpanel" aria-labelledby="task-notes-tab" hidden={taskTab !== "notes"}><TaskNotes key={selectedTask.id} task={selectedTask} projects={state.projects} relatedNotes={(state.notes ?? []).filter(note => note.taskId === selectedTask.id)} onOpenNotes={(entryId, create) => openNotes(selectedTask.projectId, entryId, selectedTask.id, create)} recordCount={selectedTaskSessions.length} studyMs={selectedTaskMs} disabled={blocked} activeLocked={active?.taskId === selectedTask.id && !naturalDone} send={send} onNotice={setNotice} onDeleted={taskDeleted} /></div>
              </> : <div className="empty-notes"><span className="note-line" /><span className="note-line" /><span className="note-line short" /><p>想从哪里开始学？</p><small>选择一个任务，打开学习对话与笔记。</small></div>}
            </section>
          </div>
        </>}
        <ReviewPanel hidden={view !== "desk"} state={state} now={now} selectedTaskId={selectedTask?.id} send={send} blocked={blocked} online={status === "synced"} onNotice={setNotice} />
        {view === "desk" && <>
          <WeekChart daily={daily} now={now} onHistory={() => setView("history")} />
          <footer className="workspace-footer"><span>一刻 · 让专注慢慢发生</span><span>所有日期按北京时间计算</span></footer>
        </>}
        {view === "notes" && <NotesPanel state={state} projectId={notesProject} onProjectChange={setNotesProject} initialEntryId={initialNoteId} taskFilter={notesTask} onTaskChange={setNotesTask} initialCreate={createNoteOnOpen} send={send} blocked={blocked} online={status === "synced"} saveState={syncText} onNotice={setNotice} />}
        {view === "history" && <>
          <StatisticsPanel state={state} now={now} selectedDay={historyDate} onSelectDay={openHistoryDay} projectId={historyProject} onProjectChange={setHistoryProject} />
          <div id="daily-history" tabIndex={-1}>
            <HistoryView key={`${historyDate}:${historyProject ?? "all"}`} state={state} now={now} send={send} blocked={blocked} date={historyDate} onDateChange={setHistoryDate} projectId={historyProject} />
          </div>
        </>}
        {view === "settings" && <div className="settings-grid"><section className="card settings-card"><div className="card-topline"><h2><Target size={18} /> 设定你的节奏</h2></div><p>每日学习目标</p><GoalForm value={state.goalMinutes} onSave={minutes => { if (send({ type: "settings.goal", minutes })) setNotice("每日目标已更新"); }} /><small>设为 0 表示不限时长。目标只是方向，请按自己的节奏学习。</small><hr /><ProjectManager state={state} send={send} blocked={blocked} onNotice={setNotice} /><form className="settings-project-form" onSubmit={newProject}><label htmlFor="settings-project-name">新项目名称</label><div><input id="settings-project-name" placeholder="例如：Qt 大作业" maxLength={80} value={newProjectTitle} onChange={e => setNewProjectTitle(e.target.value)} required /><button className="secondary-button" disabled={blocked}><Plus size={16} /> 添加</button></div></form></section><section className="card settings-card"><div className="card-topline"><h2><ShieldCheck size={18} /> 你的记录，好好保存</h2></div><div className="setting-info"><CloudCheck size={20} /><div><h3>自动保存与多端同步</h3><p>{store.localPreview ? "目前使用独立的本机体验账号，记录只保存在这台电脑。电脑和手机同步学习时，请打开已发布的网站，使用同一个 ChatGPT 账号登录。" : "登录同一 ChatGPT 账号，即可在电脑和手机接着学习。短时断网会在本机暂存，联网后继续同步。"}</p></div></div><div className="setting-info"><Clock3 size={20} /><div><h3>计时与每日汇总</h3><p>关闭页面后继续计时；暂停不计入时长。番茄钟到时自动停止累计。跨午夜的记录按北京时间分别计入两天。</p></div></div><button className="secondary-button" onClick={store.exportBackup}><ArrowDownToLine size={16} /> 导出全部学习记录（JSON）</button><BackupPanel state={state} saveCommands={store.saveCommands} userKey={user.userId} />{store.exportMessage && <p className="task-project-hint" role="status">{store.exportMessage}</p>}<hr /><div className="account-setting"><div><small>{store.localPreview ? "本机体验账号" : "当前登录账号"}</small><strong>{user.displayName}</strong></div><a className="quiet-button" href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={15} /> 退出登录</a></div></section></div>}
      </main>
    </div>{floatingTimer && <section className="floating-timer" aria-label="当前专注快捷控制"><button className="floating-timer-summary" onClick={returnToTimer} aria-label="返回主计时器"><span className="floating-timer-task" title={activeTask?.title}>{activeTask?.title ?? "当前学习任务"}</span><span className="floating-timer-clock"><strong>{clockText(displayedTime)}</strong><span>{naturalDone ? "已完成" : running ? "专注中" : "已暂停"}</span></span></button><div className="floating-timer-actions">{!naturalDone && <button className="primary-button" disabled={blocked} aria-label={running ? "暂停当前专注" : "继续当前专注"} onClick={() => send({ type: running ? "session.pause" : "session.resume" })}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "暂停" : "继续"}</button>}<button className={naturalDone ? "primary-button" : "secondary-button"} disabled={blocked} aria-label={naturalDone ? "完成当前专注记录" : "结束当前专注"} onClick={finish}>{naturalDone ? <Check size={16} /> : <Square size={15} />}{naturalDone ? "完成记录" : "结束"}</button></div></section>}<nav className="mobile-nav" aria-label="手机导航"><button className={view === "desk" ? "active" : ""} onClick={() => setView("desk")}><LayoutDashboard size={20} /><span>工作台</span></button><button className={view === "notes" ? "active" : ""} onClick={() => openNotes()}><BookOpen size={20} /><span>学习笔记</span></button><button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={20} /><span>学习统计</span></button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings2 size={20} /><span>设置</span></button></nav>{notice && <div role="status" className="toast"><CircleCheck size={17} />{notice}</div>}
  </div>;
}

function ResumeStepForm({ title, value, blocked, onSave, onSkip }: { title: string; value: string; blocked: boolean; onSave: (value: string) => void; onSkip: () => void }) {
  const [draft, setDraft] = useState(value);
  return <form className="resume-step-form" onSubmit={event => { event.preventDefault(); if (!blocked && draft.trim()) onSave(draft.trim()); }}>
    <h3>给「{title}」留下一步</h3>
    <label htmlFor="resume-next-step">下次从哪里继续</label><textarea id="resume-next-step" maxLength={2000} value={draft} disabled={blocked} placeholder="例如：先验证删除节点后的父节点指针" onChange={event => setDraft(event.target.value)} />
    <div className="quiz-actions"><button type="button" className="quiet-button" onClick={onSkip}>跳过</button><button type="submit" className="small-primary" disabled={blocked || !draft.trim()}>保存下一步</button></div>
  </form>;
}

function MonitorPreviewIcon() { return <CloudOff size={15} />; }

function TimerIcon() { return <Clock3 size={17} />; }

function GoalForm({ value, onSave, onCancel }: { value: number; onSave: (value: number) => void; onCancel?: () => void }) {
  const [minutes, setMinutes] = useState(value);
  return <form className="goal-form" onSubmit={e => { e.preventDefault(); onSave(minutes); }}><label>目标分钟数<input type="number" min={0} max={1440} step={1} value={minutes} onChange={e => setMinutes(Number(e.target.value))} required /></label><button className="small-primary">保存</button>{onCancel && <button type="button" className="icon-button" aria-label="取消调整目标" onClick={onCancel}><X size={16} /></button>}</form>;
}

function WeekChart({ daily, now, onHistory }: { daily: Record<string, number>; now: number; onHistory: () => void }) {
  const days = Array.from({ length: 7 }, (_, i) => { const timestamp = now - (6 - i) * 86400000; const key = dayKey(timestamp); return { key, label: i === 6 ? "今天" : `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`, ms: daily[key] ?? 0 }; });
  const max = Math.max(3600000, ...days.map(d => d.ms));
  const sum = days.reduce((s, d) => s + d.ms, 0);
  return <section className="card week-card"><div className="week-intro"><span className="section-caption">一点点，积少成多</span><h2>最近 7 天</h2><p>共专注 <strong>{duration(sum)}</strong></p><button className="text-button" onClick={onHistory}>查看学习统计 <ArrowRight size={14} /></button></div><div className="week-chart" role="img" aria-label={`最近七天学习时长：${days.map(d => `${d.label} ${duration(d.ms)}`).join("，")}`}><div className="chart-lines"><span /><span /><span /></div>{days.map((d, i) => <div className={`chart-column ${i === 6 ? "today" : ""}`} key={d.key}><span className="bar-value">{Math.floor(d.ms / 60000)}<small>m</small></span><div className="bar-track"><div className="chart-bar" style={{ height: d.ms ? `${Math.max(3, d.ms / max * 100)}%` : "3px" }} /></div><span className="bar-label">{d.label}</span></div>)}</div></section>;
}

function HistoryView({ state, now, send, blocked, date, onDateChange: setDate, projectId }: { state: Workspace; now: number; send: (command: Action) => boolean; blocked: boolean; date: string; onDateChange: (date: string) => void; projectId?: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(0);
  const start = new Date(`${date}T00:00:00+08:00`).getTime();
  const end = start + 86400000;
  const projectTasks = new Set(state.tasks.filter(task => !projectId || task.projectId === projectId).map(task => task.id));
  const scopedState = { ...state, sessions: state.sessions.filter(session => projectTasks.has(session.taskId)) };
  const projectTitle = state.projects.find(project => project.id === projectId)?.title;
  const sessions = scopedState.sessions.filter(s => effectiveSessionSegments(s, now).some(seg => seg.start < end && seg.end > start) || (sessionElapsedMs(s, now) === 0 && dayKey(s.segments[0]?.start ?? now) === date)).slice().reverse();
  const dayTotal = totalsByDay(scopedState, now)[date] ?? 0;
  const shift = (days: number) => setDate(dayKey(start + days * 86400000));
  const time = (ms: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
  return <><section className="card history-summary"><div><span className="section-caption">{projectTitle ? `${projectTitle} · 当日记录` : "这一天的专注"}</span><h2>{duration(dayTotal)}</h2><p>{sessions.length} 次学习记录 · 暂停时间已扣除</p></div><div className="date-picker"><button className="icon-button" aria-label="前一天" onClick={() => shift(-1)}><ChevronLeft size={18} /></button><label><span className="sr-only">选择记录日期</span><input type="date" max={dayKey(now)} value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label><button className="icon-button" aria-label="后一天" disabled={date >= dayKey(now)} onClick={() => shift(1)}><ChevronRight size={18} /></button></div></section><section className="card history-card"><div className="card-topline"><h2>学习记录</h2><span className="section-caption">北京时间 · {date}</span></div>{sessions.length ? sessions.map(s => { const task = state.tasks.find(t => t.id === s.taskId); const project = state.projects.find(p => p.id === task?.projectId); const ms = effectiveSessionSegments(s, now).reduce((sum, seg) => sum + Math.max(0, Math.min(seg.end, end) - Math.max(seg.start, start)), 0); const total = sessionElapsedMs(s, now); const expired = s.mode === "pomodoro" && total >= s.targetMs; const canEdit = s.finishedAt !== null || expired; return <div className="history-row" key={s.id}><span className="history-icon"><BookOpen size={19} /></span><div className="history-detail"><h3 title={task?.title}>{task?.title ?? "学习任务"}</h3><p><span className="history-project" title={project?.title}><i style={{ background: project?.color }} />{project?.title}</span><span className="history-session-meta">{s.mode === "free" ? "自由计时" : "番茄专注"} · {time(s.segments[0]?.start ?? now)} 开始</span></p></div><div className="history-duration"><strong>{duration(ms)}</strong><span>{expired ? "已完成 · 番茄到时" : canEdit ? "已结束" : s.segments.some(segment => segment.end === null) ? "专注中" : "已暂停"}</span></div>{canEdit && <button className="icon-button" aria-label={`修正 ${task?.title} 的学习时长`} disabled={blocked} onClick={() => { setEditing(editing === s.id ? null : s.id); setMinutes(Math.round(total / 60000)); }}><PencilLine size={16} /></button>}{editing === s.id && <form className="correction-form" onSubmit={e => { e.preventDefault(); if (send({ type: "session.correct", id: s.id, minutes })) setEditing(null); }}><label>本次总时长（分钟）<input type="number" min={0} max={s.mode === "pomodoro" ? Math.round(s.targetMs / 60000) : 1440} value={minutes} onChange={e => setMinutes(Number(e.target.value))} required /></label><button className="small-primary" disabled={blocked}>保存修正</button><button type="button" className="quiet-button" onClick={() => setEditing(null)}>取消</button><p>缩短时从尾部扣除，延长时补到最后一段；暂停仍会保留，跨午夜按实际日期分配。</p></form>}</div>; }) : <div className="empty-tasks history-empty"><span className="empty-icon"><History size={28} strokeWidth={1.3} /></span><h3>{projectTitle ? "这个项目当天还没有学习记录" : "这一天，还没有学习记录"}</h3><p>每一次开始，都会在这里留下足迹。</p></div>}</section><p className="history-help"><PencilLine size={14} /> 忘记停止计时？结束后，点击记录旁的编辑按钮修正本次时长。</p></>;
}

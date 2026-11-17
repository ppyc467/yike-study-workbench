import { mergeWorkspaceImport, validateWorkspaceImport } from "./backup.ts";

/** Shared, deterministic study rules. All persisted timestamps are epoch milliseconds. */
export type Project = { id: string; title: string; color: string };
export type Task = {
  id: string;
  projectId: string;
  title: string;
  status: "todo" | "doing" | "done";
  notes: string;
  createdAt: number;
  pinned?: boolean;
  archived?: boolean;
  plannedDate?: string;
  dueDate?: string;
  nextStep?: string;
};
export type StudyNote = {
  id: string;
  projectId: string;
  taskId?: string;
  title: string;
  body: string;
  important: boolean;
  createdAt: number;
  updatedAt: number;
};
export type Segment = { start: number; end: number | null };
export type ReviewRating = "again" | "hard" | "good";
export type ReviewAttempt = { id: string; at: number; rating: ReviewRating; response: string };
export type ReviewCard = {
  id: string;
  taskId: string;
  sourceNoteId?: string;
  question: string;
  answer: string;
  createdAt: number;
  dueAt: number;
  intervalDays: number;
  attempts: ReviewAttempt[];
};
export type NewReviewCard = Pick<ReviewCard, "id" | "taskId" | "question" | "answer" | "sourceNoteId">;
export type Session = {
  id: string;
  taskId: string;
  mode: "free" | "pomodoro";
  targetMs: number;
  segments: Segment[];
  finishedAt: number | null;
};
export type Workspace = {
  projects: Project[];
  tasks: Task[];
  notes?: StudyNote[];
  reviews?: ReviewCard[];
  sessions: Session[];
  activeSessionId: string | null;
  goalMinutes: number;
};

export type Command = { at: number } & (
  | { type: "project.add"; id: string; title: string; color: string }
  | { type: "project.update"; id: string; title?: string; color?: string }
  | { type: "project.delete"; id: string; targetProjectId?: string }
  | { type: "task.add"; id: string; projectId: string; title: string; plannedDate?: string; dueDate?: string }
  | { type: "task.update"; id: string; title?: string; status?: Task["status"]; notes?: string; projectId?: string; pinned?: boolean; archived?: boolean; plannedDate?: string | null; dueDate?: string | null; nextStep?: string }
  | { type: "task.delete"; id: string; deleteHistory?: boolean }
  | { type: "note.add"; id: string; projectId: string; title: string; body?: string; taskId?: string | null }
  | { type: "note.update"; id: string; title?: string; body?: string; projectId?: string; important?: boolean; taskId?: string | null }
  | { type: "note.delete"; id: string }
  | { type: "review.add"; cards: NewReviewCard[] }
  | { type: "review.rate"; id: string; attemptId: string; expectedDueAt: number; rating: ReviewRating; response: string }
  | { type: "review.delete"; id: string }
  | { type: "workspace.import"; state: Workspace; taskIds?: string[] }
  | { type: "session.start"; id: string; taskId: string; mode: Session["mode"]; targetMs: number }
  | { type: "session.pause" | "session.resume" | "session.finish" }
  | { type: "session.correct"; id: string; minutes: number }
  | { type: "settings.goal"; minutes: number }
);

const MINUTE = 60_000;
const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * MINUTE;

export class StudyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StudyError(message);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

function validTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160;
}

export function validStudyDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validate the untrusted command before accessing its discriminated fields. */
export function validateCommand(input: unknown): asserts input is Command {
  assert(input && typeof input === "object" && !Array.isArray(input), "操作格式不正确");
  const command = input as Record<string, unknown>;
  assert(Number.isSafeInteger(command.at) && (command.at as number) >= 0 && (command.at as number) <= 8_000_000_000_000, "操作时间不正确");
  const common = ["type", "at"];
  let allowed: string[];
  switch (command.type) {
    case "project.add":
      allowed = ["id", "title", "color"];
      assert(validId(command.id) && validTitle(command.title), "项目名称或标识不正确");
      assert(typeof command.color === "string" && /^#[a-fA-F0-9]{6}$/.test(command.color), "项目颜色不正确");
      break;
    case "project.update":
      allowed = ["id", "title", "color"];
      assert(validId(command.id), "项目标识不正确");
      assert(command.title === undefined || validTitle(command.title), "项目名称不能为空，且不能超过 160 字");
      assert(command.color === undefined || (typeof command.color === "string" && /^#[a-fA-F0-9]{6}$/.test(command.color)), "项目颜色不正确");
      break;
    case "project.delete":
      allowed = ["id", "targetProjectId"];
      assert(validId(command.id), "项目标识不正确");
      assert(command.targetProjectId === undefined || validId(command.targetProjectId), "接收任务的项目标识不正确");
      break;
    case "task.add":
      allowed = ["id", "projectId", "title", "plannedDate", "dueDate"];
      assert(validId(command.id) && validId(command.projectId) && validTitle(command.title), "任务名称或项目不正确");
      assert(command.plannedDate === undefined || validStudyDate(command.plannedDate), "计划日期不正确");
      assert(command.dueDate === undefined || validStudyDate(command.dueDate), "截止日期不正确");
      break;
    case "task.update":
      allowed = ["id", "title", "status", "notes", "projectId", "pinned", "archived", "plannedDate", "dueDate", "nextStep"];
      assert(validId(command.id), "任务标识不正确");
      assert(command.title === undefined || validTitle(command.title), "任务名称不能为空，且不能超过 160 字");
      assert(command.status === undefined || ["todo", "doing", "done"].includes(command.status as string), "任务状态不正确");
      assert(command.notes === undefined || (typeof command.notes === "string" && command.notes.length <= 20_000), "笔记不能超过 20000 字");
      assert(command.projectId === undefined || validId(command.projectId), "项目标识不正确");
      assert(command.pinned === undefined || typeof command.pinned === "boolean", "置顶状态不正确");
      assert(command.archived === undefined || typeof command.archived === "boolean", "归档状态不正确");
      assert(command.plannedDate == null || validStudyDate(command.plannedDate), "计划日期不正确");
      assert(command.dueDate == null || validStudyDate(command.dueDate), "截止日期不正确");
      assert(command.nextStep === undefined || (typeof command.nextStep === "string" && command.nextStep.length <= 2000), "下次第一步不能超过 2000 字");
      break;
    case "task.delete":
      allowed = ["id", "deleteHistory"];
      assert(validId(command.id), "任务标识不正确");
      assert(command.deleteHistory === undefined || typeof command.deleteHistory === "boolean", "删除学习记录的确认状态不正确");
      break;
    case "note.add":
      allowed = ["id", "projectId", "title", "body", "taskId"];
      assert(validId(command.id) && validId(command.projectId) && validTitle(command.title), "笔记名称或项目不正确");
      assert(command.body === undefined || (typeof command.body === "string" && command.body.length <= 50_000), "笔记正文不能超过 50000 字");
      assert(command.taskId === undefined || command.taskId === null || validId(command.taskId), "关联任务标识不正确");
      break;
    case "note.update":
      allowed = ["id", "title", "body", "projectId", "important", "taskId"];
      assert(validId(command.id), "笔记标识不正确");
      assert(command.title === undefined || validTitle(command.title), "笔记名称不能为空，且不能超过 160 字");
      assert(command.body === undefined || (typeof command.body === "string" && command.body.length <= 50_000), "笔记正文不能超过 50000 字");
      assert(command.projectId === undefined || validId(command.projectId), "项目标识不正确");
      assert(command.important === undefined || typeof command.important === "boolean", "重点标记不正确");
      assert(command.taskId === undefined || command.taskId === null || validId(command.taskId), "关联任务标识不正确");
      break;
    case "note.delete":
      allowed = ["id"];
      assert(validId(command.id), "笔记标识不正确");
      break;
    case "review.add":
      allowed = ["cards"];
      assert(Array.isArray(command.cards) && command.cards.length >= 1 && command.cards.length <= 5, "每次可保存 1 到 5 道复习题");
      for (const item of command.cards) {
        assert(item && typeof item === "object" && !Array.isArray(item), "复习题格式不正确");
        const card = item as Record<string, unknown>;
        assert(Object.keys(card).every(key => ["id", "taskId", "sourceNoteId", "question", "answer"].includes(key)), "复习题包含未知字段");
        assert(validId(card.id) && validId(card.taskId), "复习题标识不正确");
        assert(card.sourceNoteId === undefined || validId(card.sourceNoteId), "来源笔记标识不正确");
        assert(typeof card.question === "string" && card.question.trim().length > 0 && card.question.length <= 2000, "题目应为 1 到 2000 字");
        assert(typeof card.answer === "string" && card.answer.trim().length > 0 && card.answer.length <= 6000, "参考答案应为 1 到 6000 字");
      }
      break;
    case "review.rate":
      allowed = ["id", "attemptId", "expectedDueAt", "rating", "response"];
      assert(validId(command.id) && validId(command.attemptId), "复习记录标识不正确");
      assert(Number.isSafeInteger(command.expectedDueAt) && (command.expectedDueAt as number) >= 0, "复习版本不正确");
      assert(["again", "hard", "good"].includes(command.rating as string), "请选择不会、模糊或会了");
      assert(typeof command.response === "string" && command.response.trim().length > 0 && command.response.length <= 6000, "请先写下你的回答，最多 6000 字");
      break;
    case "review.delete":
      allowed = ["id"];
      assert(validId(command.id), "复习题标识不正确");
      break;
    case "workspace.import":
      allowed = ["state", "taskIds"];
      validateWorkspaceImport(command.state);
      assert(command.taskIds === undefined || Array.isArray(command.taskIds) && command.taskIds.every(validId), "恢复任务标识不正确");
      break;
    case "session.start":
      allowed = ["id", "taskId", "mode", "targetMs"];
      assert(validId(command.id) && validId(command.taskId), "计时任务不正确");
      assert(command.mode === "free" || command.mode === "pomodoro", "计时模式不正确");
      assert(Number.isSafeInteger(command.targetMs) && (command.targetMs as number) >= 0 && (command.targetMs as number) <= 180 * MINUTE, "番茄钟时长不正确");
      assert(command.mode !== "pomodoro" || (command.targetMs as number) >= MINUTE, "番茄钟至少需要 1 分钟");
      break;
    case "session.pause":
    case "session.resume":
    case "session.finish":
      allowed = [];
      break;
    case "session.correct":
      allowed = ["id", "minutes"];
      assert(validId(command.id), "记录标识不正确");
      assert(typeof command.minutes === "number" && Number.isFinite(command.minutes) && command.minutes >= 0 && command.minutes <= 10_080, "修正时长必须在 0 到 10080 分钟之间");
      break;
    case "settings.goal":
      allowed = ["minutes"];
      assert(Number.isInteger(command.minutes) && (command.minutes as number) >= 0 && (command.minutes as number) <= 1440, "每日目标必须在 0 到 1440 分钟之间");
      break;
    default:
      throw new StudyError("不支持此操作");
  }
  assert(Object.keys(command).every((key) => common.includes(key) || allowed.includes(key)), "操作包含未知字段");
}

export function initialWorkspace(): Workspace {
  return {
    projects: [
      { id: "course", title: "课程学习", color: "#637A5B" },
      { id: "english", title: "英语学习", color: "#B88B5C" },
      { id: "personal", title: "个人项目", color: "#748B9A" },
    ],
    tasks: [],
    notes: [],
    reviews: [],
    sessions: [],
    activeSessionId: null,
    goalMinutes: 120,
  };
}

/** Materialize only studied time; pauses and time beyond the pomodoro target disappear. */
export function effectiveSessionSegments(session: Session, now: number): { start: number; end: number }[] {
  let remaining = session.mode === "pomodoro" ? session.targetMs : Infinity;
  const result: { start: number; end: number }[] = [];
  for (const segment of session.segments) {
    if (remaining <= 0) break;
    const bound = Math.min(segment.end ?? now, now, session.finishedAt ?? Infinity);
    const duration = Math.min(Math.max(0, bound - segment.start), remaining);
    if (duration > 0) result.push({ start: segment.start, end: segment.start + duration });
    remaining -= duration;
  }
  return result;
}

export function sessionElapsedMs(session: Session, now: number): number {
  return effectiveSessionSegments(session, now).reduce((sum, segment) => sum + segment.end - segment.start, 0);
}

export function dayKey(timestamp: number): string {
  return new Date(timestamp + SHANGHAI_OFFSET).toISOString().slice(0, 10);
}

/** Split at Beijing midnight, including the current running segment. */
export function totalsByDay(state: Workspace, now: number): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const session of state.sessions) {
    for (const segment of effectiveSessionSegments(session, now)) {
      let cursor = segment.start;
      while (cursor < segment.end) {
        const nextMidnight = (Math.floor((cursor + SHANGHAI_OFFSET) / DAY) + 1) * DAY - SHANGHAI_OFFSET;
        const end = Math.min(nextMidnight, segment.end);
        const key = dayKey(cursor);
        totals[key] = (totals[key] ?? 0) + end - cursor;
        cursor = end;
      }
    }
  }
  return totals;
}

function finishSession(session: Session, at: number): void {
  const segments = effectiveSessionSegments(session, at);
  session.segments = segments.length ? segments : [{ start: session.segments[0].start, end: session.segments[0].start }];
  session.finishedAt = session.mode === "pomodoro" && sessionElapsedMs(session, at) >= session.targetMs
    ? (segments.at(-1)?.end ?? at)
    : at;
}

function latestBoundary(session: Session): number {
  const last = session.segments.at(-1)!;
  return last.end ?? last.start;
}

/** Apply atomically to a cloned state. A thrown error leaves the original untouched. */
export function applyCommand(source: Workspace, command: Command): Workspace {
  validateCommand(command);
  const state = structuredClone(source);
  const at = command.at;
  let active = state.sessions.find((session) => session.id === state.activeSessionId);
  const naturallyFinished = active && active.mode === "pomodoro" && sessionElapsedMs(active, at) >= active.targetMs;
  if (naturallyFinished && active) {
    finishSession(active, at);
    state.activeSessionId = null;
    active = undefined;
  }

  switch (command.type) {
    case "project.add":
      assert(state.projects.length < 100, "最多可创建 100 个项目");
      assert(!state.projects.some((project) => project.id === command.id), "项目已存在");
      state.projects.push({ id: command.id, title: command.title.trim(), color: command.color });
      break;
    case "project.update": {
      const project = state.projects.find((item) => item.id === command.id);
      assert(project, "项目不存在");
      if (command.title !== undefined) project.title = command.title.trim();
      if (command.color !== undefined) project.color = command.color;
      break;
    }
    case "project.delete": {
      assert(state.projects.some((project) => project.id === command.id), "项目不存在");
      assert(state.projects.length > 1, "请至少保留一个学习项目");
      if (command.targetProjectId !== undefined) {
        assert(command.targetProjectId !== command.id, "接收任务的项目不能是正在删除的项目");
        assert(state.projects.some((project) => project.id === command.targetProjectId), "接收任务的项目不存在");
      }
      const tasks = state.tasks.filter((task) => task.projectId === command.id);
      const notes = (state.notes ?? []).filter((note) => note.projectId === command.id);
      if (tasks.length || notes.length) {
        assert(command.targetProjectId !== undefined, "此项目还有任务或笔记，请选择一个项目接收任务、笔记及学习记录");
        for (const task of tasks) task.projectId = command.targetProjectId;
        for (const note of notes) {
          note.projectId = command.targetProjectId;
          note.updatedAt = Math.max(note.updatedAt, at);
        }
      }
      state.projects = state.projects.filter((project) => project.id !== command.id);
      break;
    }
    case "task.add":
      assert(state.tasks.length < 5000, "最多可创建 5000 个任务");
      assert(!state.tasks.some((task) => task.id === command.id), "任务已存在");
      assert(state.projects.some((project) => project.id === command.projectId), "所属项目不存在");
      state.tasks.push({ id: command.id, projectId: command.projectId, title: command.title.trim(), status: "todo", notes: "", createdAt: at,
        ...(command.plannedDate ? { plannedDate: command.plannedDate } : {}),
        ...(command.dueDate ? { dueDate: command.dueDate } : {}) });
      break;
    case "task.update": {
      const task = state.tasks.find((item) => item.id === command.id);
      assert(task, "任务不存在");
      assert(command.projectId === undefined || state.projects.some((project) => project.id === command.projectId), "所属项目不存在");
      assert(command.archived !== true || active?.taskId !== task.id, "请先结束此任务的计时，再归档任务");
      assert(command.status !== "done" || active?.taskId !== task.id, "请先结束此任务的计时，再标记完成");
      if (command.title !== undefined) task.title = command.title.trim();
      if (command.status !== undefined) task.status = command.status;
      if (command.notes !== undefined) task.notes = command.notes;
      if (command.projectId !== undefined && command.projectId !== task.projectId) {
        task.projectId = command.projectId;
        for (const note of state.notes ?? []) {
          if (note.taskId === task.id) {
            note.projectId = command.projectId;
            note.updatedAt = Math.max(note.updatedAt, at);
          }
        }
      }
      if (command.pinned !== undefined) task.pinned = command.pinned;
      if (command.archived !== undefined) task.archived = command.archived;
      if (command.plannedDate === null) delete task.plannedDate;
      else if (command.plannedDate !== undefined) task.plannedDate = command.plannedDate;
      if (command.dueDate === null) delete task.dueDate;
      else if (command.dueDate !== undefined) task.dueDate = command.dueDate;
      if (command.nextStep !== undefined) task.nextStep = command.nextStep;
      break;
    }
    case "task.delete": {
      assert(state.tasks.some((task) => task.id === command.id), "任务不存在");
      assert(active?.taskId !== command.id, "请先结束此任务的计时，再删除任务");
      const hasHistory = state.sessions.some((session) => session.taskId === command.id);
      assert(!hasHistory || command.deleteHistory === true, "此任务已有学习记录，请确认同时删除学习记录；需要保留记录时可归档任务");
      state.tasks = state.tasks.filter((task) => task.id !== command.id);
      state.sessions = state.sessions.filter((session) => session.taskId !== command.id);
      if (state.reviews) state.reviews = state.reviews.filter(card => card.taskId !== command.id);
      for (const note of state.notes ?? []) {
        if (note.taskId === command.id) {
          delete note.taskId;
          note.updatedAt = Math.max(note.updatedAt, at);
        }
      }
      break;
    }
    case "note.add": {
      const notes = state.notes ?? [];
      assert(!notes.some((note) => note.id === command.id), "笔记已存在");
      assert(state.projects.some((project) => project.id === command.projectId), "所属项目不存在");
      if (command.taskId != null) {
        const task = state.tasks.find((item) => item.id === command.taskId);
        assert(task, "关联任务不存在");
        assert(task.projectId === command.projectId, "笔记与关联任务必须属于同一项目");
      }
      notes.push({
        id: command.id,
        projectId: command.projectId,
        ...(command.taskId ? { taskId: command.taskId } : {}),
        title: command.title.trim(),
        body: command.body ?? "",
        important: false,
        createdAt: at,
        updatedAt: at,
      });
      state.notes = notes;
      break;
    }
    case "note.update": {
      const note = state.notes?.find((item) => item.id === command.id);
      assert(note, "笔记不存在");
      assert(command.projectId === undefined || state.projects.some((project) => project.id === command.projectId), "所属项目不存在");
      const projectId = command.projectId ?? note.projectId;
      let taskId = command.taskId === undefined ? note.taskId : command.taskId ?? undefined;
      if (command.projectId !== undefined && command.taskId === undefined && taskId && !state.tasks.some(task => task.id === taskId && task.projectId === projectId)) {
        taskId = undefined;
      }
      if (taskId !== undefined) {
        const task = state.tasks.find((item) => item.id === taskId);
        assert(task, "关联任务不存在");
        assert(task.projectId === projectId, "笔记与关联任务必须属于同一项目");
      }
      if (command.title !== undefined) note.title = command.title.trim();
      if (command.body !== undefined) note.body = command.body;
      if (command.projectId !== undefined) note.projectId = command.projectId;
      if (command.important !== undefined) note.important = command.important;
      if (taskId === undefined) delete note.taskId;
      else note.taskId = taskId;
      note.updatedAt = Math.max(note.updatedAt, at);
      break;
    }
    case "note.delete": {
      const notes = state.notes ?? [];
      assert(notes.some((note) => note.id === command.id), "笔记不存在");
      state.notes = notes.filter((note) => note.id !== command.id);
      for (const card of state.reviews ?? []) {
        if (card.sourceNoteId === command.id) delete card.sourceNoteId;
      }
      break;
    }
    case "review.add": {
      const cards = state.reviews ?? [];
      assert(cards.length + command.cards.length <= 2000, "复习题已达 2000 道，请整理旧题后再添加");
      for (const card of command.cards) {
        assert(!cards.some(existing => existing.id === card.id), "复习题已存在");
        assert(state.tasks.some(task => task.id === card.taskId), "关联任务不存在，请重新选择任务");
        assert(card.sourceNoteId === undefined || state.notes?.some(note => note.id === card.sourceNoteId), "来源笔记已不存在，请重新打开笔记");
        cards.push({ ...card, question: card.question.trim(), answer: card.answer.trim(), createdAt: at, dueAt: at, intervalDays: 0, attempts: [] });
      }
      state.reviews = cards;
      break;
    }
    case "review.rate": {
      const card = state.reviews?.find(item => item.id === command.id);
      assert(card, "复习题不存在");
      if (card.attempts.some(attempt => attempt.id === command.attemptId)) break;
      assert(card.dueAt === command.expectedDueAt, "这道题已在其他设备复习，请查看最新结果后再作答");
      assert(at >= card.createdAt && at >= (card.attempts.at(-1)?.at ?? 0), "复习时间早于上一条记录，请检查设备时间");
      card.intervalDays = command.rating === "again" ? 0 : command.rating === "hard" ? 1 : Math.min(60, Math.max(3, card.intervalDays * 2));
      card.dueAt = at + (command.rating === "again" ? 10 * MINUTE : card.intervalDays * DAY);
      card.attempts.push({ id: command.attemptId, at, rating: command.rating, response: command.response.trim() });
      break;
    }
    case "review.delete":
      assert(state.reviews?.some(card => card.id === command.id), "复习题不存在");
      state.reviews = (state.reviews ?? []).filter(card => card.id !== command.id);
      break;
    case "workspace.import":
      return mergeWorkspaceImport(state, command.state, command.taskIds);
    case "session.start": {
      assert(!active, "已有计时正在进行，请先结束当前计时");
      assert(state.sessions.length < 20_000, "学习记录数量已达上限，请先导出备份");
      assert(!state.sessions.some((session) => session.id === command.id), "此学习记录已存在");
      const task = state.tasks.find((item) => item.id === command.taskId);
      assert(task, "请先选择一个任务");
      assert(!task.archived, "请先恢复已归档的任务，再开始计时");
      assert(state.sessions.every((session) => (session.finishedAt ?? Infinity) <= at), "开始时间早于已有学习记录，请检查设备时间");
      state.sessions.push({ id: command.id, taskId: command.taskId, mode: command.mode, targetMs: command.mode === "free" ? 0 : command.targetMs, segments: [{ start: at, end: null }], finishedAt: null });
      state.activeSessionId = command.id;
      task.status = "doing";
      break;
    }
    case "session.pause":
    case "session.resume":
    case "session.finish": {
      if (!active && naturallyFinished) break;
      assert(active, "当前没有正在进行的计时");
      assert(at >= latestBoundary(active), "计时时间发生冲突，请检查设备时间");
      const last = active.segments.at(-1)!;
      if (command.type === "session.pause" && last.end === null) last.end = at;
      if (command.type === "session.resume" && last.end !== null) active.segments.push({ start: at, end: null });
      if (command.type === "session.finish") {
        finishSession(active, at);
        state.activeSessionId = null;
      }
      break;
    }
    case "session.correct": {
      const session = state.sessions.find((item) => item.id === command.id);
      assert(session && session.finishedAt !== null, "只能修正已结束的学习记录");
      assert(at >= session.finishedAt, "修正时间早于记录结束时间，请检查设备时间");
      const firstStart = session.segments[0].start;
      const wanted = Math.round(command.minutes * MINUTE);
      assert(session.mode !== "pomodoro" || wanted <= session.targetMs, "修正时长不能超过该番茄钟的目标时长");
      const segments = effectiveSessionSegments(session, at);
      const elapsed = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
      if (wanted <= elapsed) {
        let remaining = wanted;
        session.segments = [];
        for (const segment of segments) {
          const duration = Math.min(remaining, segment.end - segment.start);
          if (duration > 0) session.segments.push({ start: segment.start, end: segment.start + duration });
          remaining -= duration;
        }
        if (!session.segments.length) session.segments.push({ start: firstStart, end: firstStart });
      } else {
        const start = segments.at(-1)?.end ?? session.segments[0].start;
        const end = start + wanted - elapsed;
        assert(end <= at, "修正后的学习时间不能超过当前时间");
        assert(!state.sessions.some((other) => other.id !== session.id && effectiveSessionSegments(other, at).some((segment) => start < segment.end && end > segment.start)), "修正后的时间会与另一条学习记录重叠");
        session.segments = segments.length ? segments : [{ start, end: start }];
        session.segments[session.segments.length - 1].end = end;
        session.finishedAt = Math.max(session.finishedAt, end);
      }
      break;
    }
    case "settings.goal":
      state.goalMinutes = command.minutes;
      break;
  }
  return state;
}

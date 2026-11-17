import { applyCommand, StudyError, validateCommand, type Command, type Workspace } from "./study.ts";

const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8_000_000_000_000;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StudyError(message);
}

/** Validate complete backups and the independently queued portions of a restore. */
export function validateWorkspaceImport(value: unknown): asserts value is Workspace {
  check(value && typeof value === "object" && !Array.isArray(value), "备份中的学习数据格式不正确");
  const state = value as Workspace;
  for (const [items, maximum] of [[state.projects, 100], [state.tasks, 5000], [state.notes ?? [], 10000], [state.sessions, 20000], [state.reviews ?? [], 2000]] as const) {
    check(Array.isArray(items) && items.length <= maximum, "备份中的记录数量超出支持范围");
    const ids = new Set<string>();
    for (const item of items) {
      check(item && typeof item === "object" && validId(item.id) && !ids.has(item.id), "备份中存在无效或重复标识");
      ids.add(item.id);
    }
  }
  check(state.activeSessionId === null || validId(state.activeSessionId), "备份中的当前计时标识不正确");
  validateCommand({ type: "settings.goal", minutes: state.goalMinutes, at: 0 });
  for (const project of state.projects) validateCommand({ type: "project.add", ...project, at: 0 });
  for (const task of state.tasks) {
    validateCommand({ type: "task.add", id: task.id, title: task.title, projectId: task.projectId, at: 0 });
    check(["todo", "doing", "done"].includes(task.status), "备份中的任务状态不正确");
    validateCommand({ type: "task.update", id: task.id, title: task.title, status: task.status, notes: task.notes, projectId: task.projectId, pinned: task.pinned, archived: task.archived, plannedDate: task.plannedDate, dueDate: task.dueDate, nextStep: task.nextStep, at: 0 });
    check(validTime(task.createdAt) && typeof task.notes === "string", "备份中的任务时间或随记不正确");
  }
  for (const note of state.notes ?? []) {
    validateCommand({ type: "note.add", id: note.id, projectId: note.projectId, title: note.title, body: note.body, taskId: note.taskId, at: 0 });
    check(typeof note.body === "string" && typeof note.important === "boolean" && validTime(note.createdAt) && validTime(note.updatedAt), "备份中的笔记格式不正确");
  }
  for (const session of state.sessions) {
    validateCommand({ type: "session.start", id: session.id, taskId: session.taskId, mode: session.mode, targetMs: session.targetMs, at: 0 });
    check(Array.isArray(session.segments) && session.segments.length > 0 && session.segments.length <= 20000, "备份中的计时片段不正确");
    check(session.finishedAt === null || validTime(session.finishedAt), "备份中的结束时间不正确");
    let boundary = 0;
    for (const [index, segment] of session.segments.entries()) {
      check(validTime(segment.start) && segment.start >= boundary, "备份中的计时片段顺序不正确");
      check(segment.end === null ? index === session.segments.length - 1 && session.finishedAt === null : validTime(segment.end) && segment.end >= segment.start, "备份中的计时结束时间不正确");
      boundary = segment.end ?? segment.start;
    }
    check(session.finishedAt === null || session.finishedAt >= boundary, "备份中的记录结束时间早于计时片段");
  }
  for (const card of state.reviews ?? []) {
    validateCommand({ type: "review.add", cards: [{ id: card.id, taskId: card.taskId, sourceNoteId: card.sourceNoteId, question: card.question, answer: card.answer }], at: 0 });
    check(validTime(card.createdAt) && validTime(card.dueAt) && Number.isFinite(card.intervalDays) && card.intervalDays >= 0 && card.intervalDays <= 36500 && Array.isArray(card.attempts) && card.attempts.length <= 10000, "备份中的复习记录不正确");
    const attempts = new Set<string>();
    for (const attempt of card.attempts) {
      check(validId(attempt.id) && !attempts.has(attempt.id) && validTime(attempt.at) && ["again", "hard", "good"].includes(attempt.rating) && typeof attempt.response === "string" && attempt.response.trim().length > 0 && attempt.response.length <= 6000, "备份中的作答记录不正确");
      attempts.add(attempt.id);
    }
  }
}

function validateReferences(state: Workspace) {
  const projects = new Set(state.projects.map(project => project.id));
  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  const notes = new Set((state.notes ?? []).map(note => note.id));
  check(state.projects.length > 0 && state.tasks.every(task => projects.has(task.projectId)), "备份中的任务缺少所属项目");
  check((state.notes ?? []).every(note => projects.has(note.projectId) && (!note.taskId || tasks.get(note.taskId)?.projectId === note.projectId)), "备份中的笔记关联无效");
  check(state.sessions.every(session => tasks.has(session.taskId)), "备份中的计时缺少关联任务");
  check((state.reviews ?? []).every(card => tasks.has(card.taskId) && (!card.sourceNoteId || notes.has(card.sourceNoteId))), "备份中的复习题关联无效");
  check(state.activeSessionId === null || state.sessions.some(session => session.id === state.activeSessionId), "备份中的当前计时不存在");
}

/** Restores append fresh IDs, so existing edits and the live timer are preserved. */
export function mergeWorkspaceImport(current: Workspace, incoming: Workspace, taskIds?: string[]): Workspace {
  validateWorkspaceImport(incoming);
  check(taskIds === undefined || Array.isArray(taskIds) && taskIds.every(validId), "恢复任务选择不正确");
  const selected = taskIds ? new Set(taskIds) : null;
  const next = structuredClone(current);
  const append = <T extends { id: string }>(existing: T[], additions: T[]) => {
    const byId = new Map(existing.map(item => [item.id, item]));
    for (const item of additions) {
      const previous = byId.get(item.id);
      check(!previous || JSON.stringify(previous) === JSON.stringify(item), "恢复标识与现有记录冲突，请重新预览备份");
      if (!previous) { existing.push(structuredClone(item)); byId.set(item.id, item); }
    }
  };
  append(next.projects, incoming.projects);
  append(next.tasks, incoming.tasks.filter(task => !selected || selected.has(task.id)));
  next.notes ??= [];
  append(next.notes, (incoming.notes ?? []).filter(note => !selected || !!note.taskId && selected.has(note.taskId)));
  append(next.sessions, incoming.sessions.filter(session => !selected || selected.has(session.taskId)));
  next.reviews ??= [];
  append(next.reviews, (incoming.reviews ?? []).filter(card => !selected || selected.has(card.taskId)));
  check(incoming.activeSessionId === null && incoming.sessions.every(session => session.finishedAt !== null), "恢复的历史计时必须先结束");
  validateWorkspaceImport(next);
  validateReferences(next);
  return next;
}

export type BackupPreview = { state: Workspace; conversations: unknown[]; exportedAt: number; chatExportStatus?: string; chatDrafts: { taskId: string; draft: Record<string, unknown> }[] };

/** Old exports store the confirmed snapshot and pending commands separately. */
export function parseBackup(value: unknown): BackupPreview {
  check(value && typeof value === "object" && !Array.isArray(value), "请选择一刻导出的 JSON 备份");
  const data = value as Record<string, any>;
  let state: Workspace = structuredClone(data.state ?? data.base?.state ?? data);
  validateWorkspaceImport(state);
  check(data.pending === undefined || Array.isArray(data.pending) && data.pending.length <= 50000, "备份中的待同步操作不正确");
  for (const command of data.pending ?? []) state = applyCommand(state, command);
  validateReferences(state);
  const date = typeof data.exportedAt === "string" ? Date.parse(data.exportedAt) : data.base?.serverNow;
  const exportedAt = validTime(date) ? date : Date.now();
  const chatDrafts = Array.isArray(data.chatDrafts) ? data.chatDrafts.filter((item: any) => validId(item?.taskId) && item.draft && typeof item.draft === "object") : [];
  return { state, exportedAt, conversations: Array.isArray(data.conversations) ? data.conversations : [], chatExportStatus: data.chatExportStatus, chatDrafts };
}

export function backupSources(value: unknown): { label: string; preview: BackupPreview }[] {
  const primary = parseBackup(value);
  const sources = [{ label: "导出时的当前页面", preview: primary }];
  const other = (value as Record<string, unknown>).otherDeviceDrafts;
  if (Array.isArray(other)) for (const [index, draft] of other.entries()) {
    try {
      const preview = parseBackup({ ...draft, exportedAt: new Date(primary.exportedAt).toISOString(), conversations: primary.conversations, chatDrafts: primary.chatDrafts });
      sources.push({ label: `其他页面的离线草稿 ${index + 1}`, preview });
    } catch { /* A damaged secondary draft does not prevent restoring the primary backup. */ }
  }
  return sources;
}

export function prepareRestore(current: Workspace, backup: BackupPreview, selectedTaskIds: string[], includeStandalone: boolean, createId = () => crypto.randomUUID()) {
  const selected = new Set(selectedTaskIds);
  check(selectedTaskIds.every(id => backup.state.tasks.some(task => task.id === id)), "选中的恢复任务不存在");
  const projectIds = new Map<string, string>();
  const taskIds = new Map<string, string>();
  const noteIds = new Map<string, string>();
  const restored: Workspace = { projects: [], tasks: [], notes: [], sessions: [], reviews: [], activeSessionId: null, goalMinutes: current.goalMinutes };
  const projectId = (id: string) => {
    if (projectIds.has(id)) return projectIds.get(id)!;
    const source = backup.state.projects.find(project => project.id === id)!;
    const existing = current.projects.find(project => project.id === id && project.title === source.title);
    const destination = existing?.id ?? createId();
    projectIds.set(id, destination);
    if (!existing) restored.projects.push({ ...source, id: destination });
    return destination;
  };
  for (const task of backup.state.tasks.filter(task => selected.has(task.id))) {
    const id = createId(); taskIds.set(task.id, id);
    restored.tasks.push({ ...task, id, projectId: projectId(task.projectId), title: `${task.title.slice(0, 152)}（恢复副本）` });
  }
  for (const note of (backup.state.notes ?? []).filter(note => note.taskId ? selected.has(note.taskId) : includeStandalone)) {
    const id = createId(); noteIds.set(note.id, id);
    restored.notes!.push({ ...note, id, projectId: projectId(note.projectId), ...(note.taskId ? { taskId: taskIds.get(note.taskId)! } : {}) });
  }
  for (const session of backup.state.sessions.filter(session => selected.has(session.taskId))) {
    const stop = Math.max(backup.exportedAt, ...session.segments.map(segment => segment.end ?? segment.start));
    restored.sessions.push({ ...session, id: createId(), taskId: taskIds.get(session.taskId)!, segments: session.segments.map(segment => ({ ...segment, end: segment.end ?? stop })), finishedAt: session.finishedAt ?? stop });
  }
  for (const card of (backup.state.reviews ?? []).filter(card => selected.has(card.taskId))) {
    restored.reviews!.push({ ...card, id: createId(), taskId: taskIds.get(card.taskId)!, sourceNoteId: card.sourceNoteId ? noteIds.get(card.sourceNoteId) : undefined, attempts: card.attempts.map(attempt => ({ ...attempt, id: createId() })) });
  }
  // Queue bounded independent portions, preserving project/task/reference ordering.
  const commands: Command[] = [];
  const empty = (): Workspace => ({ projects: [], tasks: [], notes: [], sessions: [], reviews: [], activeSessionId: null, goalMinutes: current.goalMinutes });
  let portion = empty();
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const flush = () => { commands.push({ type: "workspace.import", state: portion, at: Date.now() } as Command); portion = empty(); };
  for (const key of ["projects", "tasks", "notes", "sessions", "reviews"] as const) {
    for (const item of restored[key] ?? []) {
      if (bytes(portion) + bytes(item) > 300000) flush();
      check(bytes(item) <= 300000, "这条历史记录过大，请先恢复其他任务");
      (portion[key] as { id: string }[]).push(item);
    }
  }
  if ([portion.projects, portion.tasks, portion.notes!, portion.sessions, portion.reviews!].some(items => items.length)) flush();
  check(commands.length > 0, "请至少选择一个任务或一篇独立笔记");
  const chatDrafts = backup.chatDrafts.filter(item => taskIds.has(item.taskId)).map(item => {
    const draft = structuredClone(item.draft) as Record<string, any>;
    draft.taskId = taskIds.get(item.taskId);
    const mapNotes = (ids: unknown) => Array.isArray(ids) ? ids.map(id => noteIds.get(id)).filter(Boolean) : [];
    if (draft.selectedNoteIds) draft.selectedNoteIds = mapNotes(draft.selectedNoteIds);
    if (draft.operation?.selectedNoteIds) draft.operation.selectedNoteIds = mapNotes(draft.operation.selectedNoteIds);
    return { taskId: taskIds.get(item.taskId)!, draft };
  });
  return { commands, taskIds, chatDrafts, conversations: backup.conversations.filter((item: any) => taskIds.has(item?.taskId)).map((item: any) => ({ ...item, taskId: taskIds.get(item.taskId) })) };
}

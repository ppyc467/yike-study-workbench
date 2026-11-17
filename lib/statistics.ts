import { dayKey, effectiveSessionSegments, type Workspace } from "./study";

export type StudyRangeDays = 7 | 30;
export type StudyStatistics = {
  rangeDays: StudyRangeDays;
  startKey: string;
  endKey: string;
  totalMs: number;
  dailyAverageMs: number;
  activeDays: number;
  sessionCount: number;
  days: { key: string; ms: number }[];
  projectTotals: { projectId: string; title: string; color: string; ms: number }[];
  taskTotals: { taskId: string; projectId: string; title: string; archived: boolean; ms: number }[];
};

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60_000;

/** Inclusive Beijing calendar window ending now; history follows each task's current project. */
export function summarizeStudy(state: Workspace, now: number, rangeDays: StudyRangeDays = 7, projectId?: string): StudyStatistics {
  if (!Number.isFinite(now) || Math.abs(now) > 8_000_000_000_000) throw new RangeError("统计时间不正确");
  if (rangeDays !== 7 && rangeDays !== 30) throw new RangeError("统计范围应为 7 天或 30 天");
  const todayStart = Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
  const rangeStart = todayStart - (rangeDays - 1) * DAY;
  const days = Array.from({ length: rangeDays }, (_, index) => ({ key: dayKey(rangeStart + index * DAY), ms: 0 }));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const projects = new Map(state.projects.map((project) => [project.id, project]));
  const projectMs = new Map<string, number>();
  const taskMs = new Map<string, number>();
  let totalMs = 0;
  let sessionCount = 0;

  for (const session of state.sessions) {
    const task = tasks.get(session.taskId);
    // The command model retains every task and rejects unknown task references.
    if (!task || (projectId !== undefined && task.projectId !== projectId)) continue;
    let sessionMs = 0;
    for (const segment of effectiveSessionSegments(session, now)) {
      let cursor = Math.max(segment.start, rangeStart);
      const end = Math.min(segment.end, now);
      while (cursor < end) {
        const index = Math.floor((cursor - rangeStart) / DAY);
        const partEnd = Math.min(end, rangeStart + (index + 1) * DAY);
        const duration = partEnd - cursor;
        days[index].ms += duration;
        sessionMs += duration;
        cursor = partEnd;
      }
    }
    if (sessionMs <= 0) continue;
    sessionCount++;
    totalMs += sessionMs;
    projectMs.set(task.projectId, (projectMs.get(task.projectId) ?? 0) + sessionMs);
    taskMs.set(task.id, (taskMs.get(task.id) ?? 0) + sessionMs);
  }

  const projectTotals = Array.from(projectMs, ([id, ms]) => {
    const project = projects.get(id);
    return { projectId: id, title: project?.title ?? "未分类项目", color: project?.color ?? "#748B9A", ms };
  }).sort((a, b) => b.ms - a.ms || a.projectId.localeCompare(b.projectId));
  const taskTotals = Array.from(taskMs, ([id, ms]) => {
    const task = tasks.get(id)!;
    return { taskId: id, projectId: task.projectId, title: task.title, archived: task.archived === true, ms };
  }).sort((a, b) => b.ms - a.ms || a.taskId.localeCompare(b.taskId));

  return {
    rangeDays,
    startKey: days[0].key,
    endKey: days[days.length - 1].key,
    totalMs,
    dailyAverageMs: totalMs / rangeDays,
    activeDays: days.filter((day) => day.ms > 0).length,
    sessionCount,
    days,
    projectTotals,
    taskTotals,
  };
}

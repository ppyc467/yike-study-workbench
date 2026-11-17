"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BarChart3, CalendarDays, Clock3, Layers3, Target } from "lucide-react";
import { summarizeStudy } from "../lib/statistics";
import type { Workspace } from "../lib/study";
import "./statistics.css";

type StatisticsPanelProps = {
  state: Workspace;
  now: number;
  selectedDay: string;
  onSelectDay: (key: string) => void;
  projectId?: string;
  onProjectChange: (id?: string) => void;
};

const duration = (ms: number) => {
  if (ms <= 0) return "0 分钟";
  if (ms < 60_000) return "不足 1 分钟";
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`
    : `${minutes} 分钟`;
};

function ChartDurationValue({ ms }: { ms: number }) {
  if (ms <= 0) return <span>0分</span>;
  if (ms < 60_000) return <><span>不足</span><span>1分</span></>;
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60
    ? <><span>{Math.floor(minutes / 60)}时</span>{minutes % 60 > 0 && <span>{minutes % 60}分</span>}</>
    : <span>{minutes}分</span>;
}

const shortDate = (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;

function DurationValue({ ms }: { ms: number }) {
  if (ms <= 0) return <span>0 分钟</span>;
  if (ms < 60_000) return <span className="stats-less-than-minute">不足 1 分钟</span>;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return <span>{minutes} 分钟</span>;
  return <><span>{Math.floor(minutes / 60)} 小时</span>{minutes % 60 > 0 && <>{" "}<span>{minutes % 60} 分钟</span></>}</>;
}

export default function StatisticsPanel({ state, now, selectedDay, onSelectDay, projectId, onProjectChange }: StatisticsPanelProps) {
  const [rangeDays, setRangeDays] = useState<7 | 30>(7);
  const projectSelectId = useId();
  const chartHintId = useId();
  const chartViewport = useRef<HTMLDivElement | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false, overflow: false });
  const summary = summarizeStudy(state, now, rangeDays, projectId);
  const maxDayMs = Math.max(1, ...summary.days.map(day => day.ms));
  const projects = new Map(state.projects.map(project => [project.id, project]));
  const selectedProject = projectId ? projects.get(projectId) : undefined;
  const topTasks = summary.taskTotals.slice(0, 5);

  useEffect(() => {
    const viewport = chartViewport.current;
    if (!viewport) return;
    const measure = () => {
      const maximum = viewport.scrollWidth - viewport.clientWidth;
      const next = { left: viewport.scrollLeft > 2, right: viewport.scrollLeft < maximum - 2, overflow: maximum > 2 };
      setScrollEdges(previous => previous.left === next.left && previous.right === next.right && previous.overflow === next.overflow ? previous : next);
    };
    // Keep the newest dates visible when opening a longer range.
    viewport.scrollLeft = viewport.scrollWidth;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    viewport.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
    };
  }, [rangeDays]);

  const scrollChart = (direction: -1 | 1) => {
    const viewport = chartViewport.current;
    if (viewport) viewport.scrollBy({ left: direction * Math.max(52, viewport.clientWidth - 52), behavior: "instant" });
  };

  return <div className="study-statistics">
    <section className="stats-filter-bar" aria-label="学习统计筛选">
      <div>
        <div className="stats-range-switch" role="group" aria-label="统计时间范围">
          <button type="button" aria-pressed={rangeDays === 7} onClick={() => setRangeDays(7)}>近 7 天</button>
          <button type="button" aria-pressed={rangeDays === 30} onClick={() => setRangeDays(30)}>近 30 天</button>
        </div>
        <p className="stats-range-caption">{summary.startKey.replaceAll("-", ".")} — {summary.endKey.replaceAll("-", ".")} · 含今天</p>
      </div>
      <div className="stats-project-filter">
        <label htmlFor={projectSelectId}>统计项目</label>
        <select id={projectSelectId} value={projectId ?? ""} onChange={event => onProjectChange(event.target.value || undefined)}>
          <option value="">全部项目</option>
          {state.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </div>
    </section>

    <dl className="stats-metrics">
      <div className="card stats-metric">
        <dt><Clock3 size={16} aria-hidden="true" />累计学习</dt>
        <dd className="stats-metric-duration"><DurationValue ms={summary.totalMs} /></dd>
        <dd className="stats-metric-caption">{selectedProject?.title ?? "所有项目的专注时间"}</dd>
      </div>
      <div className="card stats-metric">
        <dt><BarChart3 size={16} aria-hidden="true" />每日平均</dt>
        <dd className="stats-metric-duration"><DurationValue ms={summary.dailyAverageMs} /></dd>
        <dd className="stats-metric-caption">按完整 {rangeDays} 天计算</dd>
      </div>
      <div className="card stats-metric">
        <dt><CalendarDays size={16} aria-hidden="true" />学习天数</dt>
        <dd>{summary.activeDays}<small> / {rangeDays} 天</small></dd>
        <dd className="stats-metric-caption">有实际学习时间的日子</dd>
      </div>
      <div className="card stats-metric">
        <dt><Target size={16} aria-hidden="true" />专注次数</dt>
        <dd>{summary.sessionCount}<small> 次</small></dd>
        <dd className="stats-metric-caption">暂停后继续仍算一次</dd>
      </div>
    </dl>

    <section className="card stats-trend-card" aria-labelledby="study-trend-heading">
      <div className="stats-panel-heading">
        <div>
          <h2 id="study-trend-heading">每天学了多久</h2>
          <p id={chartHintId}>点选日期，查看下方的学习记录。</p>
        </div>
        {scrollEdges.overflow && <div className="stats-chart-navigation" role="group" aria-label="浏览趋势日期">
          <button type="button" aria-label="查看更早日期" disabled={!scrollEdges.left} onClick={() => scrollChart(-1)}><ArrowLeft size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="查看较近日期" disabled={!scrollEdges.right} onClick={() => scrollChart(1)}><ArrowRight size={18} aria-hidden="true" /></button>
        </div>}
      </div>
      {summary.totalMs === 0 && <p className="stats-chart-empty">这段时间还没有学习记录。开始一次专注，就能看到自己的积累。</p>}
      <div className="stats-chart-viewport" ref={chartViewport} role="group" aria-label={`近 ${rangeDays} 天学习时长`} aria-describedby={chartHintId}>
        <div className="stats-daily-chart" style={{ gridTemplateColumns: `repeat(${rangeDays}, minmax(44px, 1fr))` }}>
          {summary.days.map((day, index) => <button
            type="button"
            className={`stats-day${day.key === selectedDay ? " is-selected" : ""}${day.key === summary.endKey ? " is-today" : ""}`}
            key={day.key}
            aria-label={`${day.key}，${duration(day.ms)}，查看当天记录`}
            aria-pressed={day.key === selectedDay}
            onClick={() => onSelectDay(day.key)}
            onKeyDown={event => {
              const next = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? rangeDays - 1 : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const buttons = chartViewport.current?.querySelectorAll<HTMLButtonElement>(".stats-day");
              const target = buttons?.[Math.max(0, Math.min(rangeDays - 1, next))];
              target?.focus({ preventScroll: true });
              target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
            }}
          >
            <span className="stats-day-value"><ChartDurationValue ms={day.ms} /></span>
            <span className="stats-day-track" aria-hidden="true"><span className={`stats-day-fill${day.ms <= 0 ? " is-empty" : ""}`} style={{ height: day.ms > 0 ? `${Math.max(2, day.ms / maxDayMs * 100)}%` : "2px" }} /></span>
            <span className="stats-day-date">{shortDate(day.key)}</span>
            <span className="stats-day-marker">{day.key === summary.endKey ? "今天" : day.key === selectedDay ? "已选" : ""}</span>
          </button>)}
        </div>
      </div>
      {scrollEdges.overflow && <p className="stats-scroll-hint">左右滑动或使用箭头，查看全部 {rangeDays} 天。</p>}
    </section>

    <div className="stats-breakdowns">
      <section className="card stats-project-card" aria-labelledby="study-project-heading">
        <div className="stats-panel-heading"><div><h2 id="study-project-heading">时间花在了哪里</h2><p>每个项目的时长与占比</p></div><Layers3 size={20} aria-hidden="true" /></div>
        {summary.projectTotals.length ? <ul className="stats-project-list">
          {summary.projectTotals.map(project => {
            const percentage = summary.totalMs ? project.ms / summary.totalMs * 100 : 0;
            return <li key={project.projectId}>
              <div className="stats-project-label"><span title={project.title}><i style={{ background: project.color }} aria-hidden="true" />{project.title}</span><strong>{duration(project.ms)}</strong></div>
              <div className="stats-project-bar-row"><span className="stats-project-track" aria-hidden="true"><span style={{ width: `${percentage}%`, background: project.color }} /></span><span className="stats-project-percentage">{percentage > 0 && percentage < 1 ? "<1" : Math.round(percentage)}%</span></div>
            </li>;
          })}
        </ul> : <div className="stats-empty-detail"><p>还没有可统计的项目时长</p><span>任务产生学习记录后，会自动汇总到所属项目。</span></div>}
      </section>

      <section className="card stats-task-card" aria-labelledby="study-task-heading">
        <div className="stats-panel-heading"><div><h2 id="study-task-heading">用时最多的任务</h2><p>近 {rangeDays} 天 · 最多显示 5 项</p></div></div>
        {topTasks.length ? <ol className="stats-task-list">
          {topTasks.map((task, index) => <li key={task.taskId}>
            <span className="stats-task-rank" aria-hidden="true">{index + 1}</span>
            <div className="stats-task-name"><strong title={task.title}>{task.title}</strong><p><span title={projects.get(task.projectId)?.title}>{projects.get(task.projectId)?.title ?? "未分类项目"}</span>{task.archived && <span className="stats-archived-label">已归档</span>}</p></div>
            <span className="stats-task-duration">{duration(task.ms)}</span>
          </li>)}
        </ol> : <div className="stats-empty-detail"><p>还没有任务学习记录</p><span>每次专注都会计入对应任务，无需手动整理。</span></div>}
      </section>
    </div>
    <p className="stats-explanation">按北京时间统计，扣除暂停，包含进行中的专注和归档任务记录。项目按任务当前归属汇总。</p>
  </div>;
}

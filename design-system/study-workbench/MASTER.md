# Study Workbench — reviewed design system

Status: reviewed synthesis, 2026-10-23. Product: private Chinese personal learning dashboard, desktop + phone. User-approved direction: warm white, muted green, clear timer, task progress, autosave, daily summaries, cross-device continuity. This document is the implementation source of truth.

## Skill provenance and query verification

Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills/ui-ux-pro-max
Downloaded only inside this project; no global installation or repository installer ran.

Required design-system query: `personal study productivity dashboard`, variance 2, density 5. Verified identity: **Productivity Tool**; style **Minimalism & Swiss Style**; typography **Friendly SaaS**. Product and style fit the application. Its Product Demo + Features landing pattern does not fit the authenticated workbench.

One narrower retry: `study focus planner dashboard`, same dials. Verified identity: **Study Together / Virtual Coworking**; style **Minimalism & Swiss Style**; typography **Dashboard Data**. Study/focus and restrained dashboard typography are useful; coworking, testimonials, and marketing conversion structure do not fit a private personal app. No additional retry was performed.

Therefore no fully applicable generated system was found. Raw aggregated output was NOT persisted. This reviewed file retains only the verified minimalist functional style and spacing guidance; layout and warm-white/green palette below are explicitly a user-directed design synthesis. Marketing landing patterns, video, testimonials, coworking, and blue/orange palette suggestions are rejected. `references/quick-reference.md` accessibility, touch, performance, and responsive rules were reviewed as general fallback guidance.

## Color tokens

Use semantic variables, not scattered raw component colors.

| Token | Value | Use |
|---|---|---|
| background | #F7F8F2 | Warm page canvas |
| surface | #FFFFFF | Main cards and forms |
| surface-soft | #EAF0E5 | Selected task, subtle green panels |
| foreground | #21372E | Main text |
| muted-foreground | #5E6B61 | Secondary text; reviewed update for legibility on soft summary panels |
| primary | #3D6B53 | Start/resume CTA, selected navigation, focus indicator |
| primary-foreground | #FFFFFF | Primary button text, 6.13:1 on primary |
| primary-hover | #315943 | Hover/pressed primary |
| border | #DFE5DA | Decorative card dividers, not the sole control boundary |
| accent | #C9D8B4 | Decorative chart fill, never low-contrast body text |
| warning | #7A551B | Pending/offline warning text |
| destructive | #A93737 | Destructive action and error text |

Measured text contrast: foreground/background 11.91:1; updated muted text on the implementation's #EDF1E8 soft panel 4.89:1; white/primary 6.13:1; primary/surface-soft 5.28:1. Avoid applying opacity to muted text because this erases the margin. Essential field boundaries/focus indicators use primary or another measured 3:1 color; the light border is only decorative.

## Typography and rhythm

- Chinese body: system UI sans stack, `Inter, "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`. Use installed fallbacks immediately; do not block on a remote font.
- Body and inputs: 16px / 1.5. Secondary metadata: 13–14px / 1.5. Do not shrink critical action labels.
- Page title: 30–34px desktop, 26–28px phone, weight 600.
- Timer: desktop 76–88px, phone 58–68px; tabular numerals, restrained letter spacing, stable width. Keep digit layout stable across ticks.
- Section heading: 18–20px, weight 600. KPI value: 28–32px.
- Spacing: 4, 8, 16, 24, 32, 48, 64px. Cards: 24px desktop, 20px phone. Page gutters: 32–40px desktop, 16–20px phone.
- Radii: controls 10–12px, cards 18–22px, small tags pill. Use one subtle shadow or a fine border; avoid layered glass, saturated gradients, or ornamental motion.
- Icons: one consistent SVG outline family, 20–22px, decorative icons `aria-hidden`; every standalone control has an accessible name.

## Composition

Desktop (>=1100px): 216–232px calm sidebar, flexible main column, 300–330px summary/notes column. Keep overall content readable around 1440–1600px. Main column begins with a concise greeting/date, a large focus card, then current projects/tasks. Right column contains today's total, weekly bars, and a short next-step note.

Tablet: collapse right column below the main content; reduce sidebar to a compact rail or top navigation if space requires it.

Phone (implementation breakpoint <=700px): single column. A compact daily total and remaining-goal summary sits above the timer; the complete project breakdown stays below tasks and notes. Keep current task + timer + controls prominent. Bottom navigation has three destinations (工作台 / 学习统计 / 设置), 44px minimum targets and `env(safe-area-inset-bottom)` clearance. When primary timer controls leave the viewport, show a compact timer above bottom navigation with enough content clearance. Long names truncate visually while retaining their full title. No page-level horizontal scrolling at 320px or 375px; the daily chart has a labeled internal scroll area to preserve readable dates and touch targets.

The primary CTA is the current session's start/resume/pause action. End session is secondary. Mode switch uses explicit labels 自由计时 / 番茄钟. Task/project selectors must make the current target clear before time is assigned.

## Core interaction and states

- A real empty state on first use: zero time, no invented historical sessions. Offer a concise 创建学习任务 action.
- Persist progress automatically and expose honest concise states: 已保存 / 正在保存 / 离线待同步 / 需要处理冲突. Never display 已同步 before server acknowledgement.
- Current session state is unambiguous: 未开始 / 专注中 / 已暂停 / 本次完成. Text and icons supplement color.
- Keep timer visible when the user chooses a task; do not force a new route for start/pause/end.
- Manual corrections remain available in session history. Show the project/task and original time range in the edit dialog so the user edits the intended record.
- Autosave notes with a brief debounce and an immediate local durable write; show validation/error next to the relevant input. Keep typed content after an error.
- Shared account state may have only one active timer. If another device changes it, refresh the visible state and state the change without silently overwriting it.
- Today totals count only learning time, including currently running duration. Split midnight according to Asia/Shanghai. Pause/break duration is excluded.
- Show raw durations consistently: timer HH:MM:SS, totals e.g. 1小时 25分; do not round 59 seconds into a completed minute on one screen and zero on another without labeling the convention.
- Charts: compact 7-day overview and dedicated 7/30-day statistics, with date/value labels, current day clearly marked and totals available as text. Color must not be the only day/project identifier. Empty bars have zero-value labels, not fake starter data. Daily bars use discrete totals; chart skill query `dashboard time trend comparison` informed trend labels and accessible equivalents while discrete bars fit the interaction better than a continuous line.
- Task organization: search title/notes, project/status filters, pinned-first ordering, recent study/creation sorting, reversible archive. Distinguish an empty workspace from no matching results. Archive preserves notes/history and blocks new timers until restored. Active or paused tasks must finish the session before completion/archive.
- Statistics: show cumulative time, full-range daily average, active days, overlapping session count, project shares and top task durations. Include archived history and zero days; attribute historical time to the task's current project with an explanatory label. Show positive durations below a minute as 不足1分钟 and keep hour/minute text units together on narrow screens.
- Date selection navigates to matching daily details and moves focus to their heading region. Project filtering applies to both charts and daily details. Support arrow/Home/End chart keyboard navigation, scroll buttons, 44px date targets and reduced-motion scrolling. On mobile, selecting a task reveals notes without opening the software keyboard.
- Project management: expose a visible 管理 action beside the sidebar project heading and the same manager in Settings. Rename inline; deletion opens an explicit confirmation with safe initial focus. Populated projects require a chosen destination and preserve every task, note, session and active timer. Explain the last-project rule. Reset missing filters after remote deletion while preserving a new task draft.
- Responsive content: use shrinkable grid/flex columns, bounded task/project titles with full title text available, and grouped hour/minute labels. On narrow screens, daily history metadata and duration move below the title, forms have usable full-width fields, and action controls retain 44px targets. Keep the timer title on one line and size its project badge to its actual content. The verified UX query `long content responsive overflow` supplied long-token and truncation guidance; implementation follows the existing CSS system.

## Accessibility and verification

- Use semantic buttons/inputs, labels, a skip link, logical headings, full keyboard traversal, and visible 2–3px focus rings with offset.
- Primary touch controls at least 44×44 CSS px, gaps at least 8px. Keep all actions usable without hover or drag.
- Modal: focus enters and is contained appropriately, Escape closes, focus returns to trigger. Form errors are persistent and near fields.
- Do not place the ticking seconds in an assertive live region. Announce start/pause/finish or sync conflicts once through a polite status region.
- Respect `prefers-reduced-motion`; use 150–200ms color/opacity transitions only where useful. No continuously pulsing timer ring.
- Check desktop, 375px phone, narrow landscape, 200% zoom, long Chinese task names, empty states, running/pause/finish, offline/pending/conflict, and server errors.
- Preserve readable input/font sizes and ensure sticky navigation never obscures keyboard focus or bottom actions.

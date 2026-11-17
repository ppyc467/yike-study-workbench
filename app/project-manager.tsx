"use client";

import { useRef, useState } from "react";
import { ArrowRightLeft, Check, FolderCog, Pencil, Trash2, X } from "lucide-react";
import type { Command, Workspace } from "../lib/study";
import "./projects.css";

type Action = Command extends infer T ? T extends { at: number } ? Omit<T, "at"> : never : never;
type Editor = { type: "rename"; id: string; title: string } | { type: "delete"; id: string; targetId: string };
type ProjectManagerProps = {
  state: Workspace;
  send: (action: Action) => boolean;
  blocked: boolean;
  onNotice: (message: string) => void;
};

export default function ProjectManager({ state, send, blocked, onNotice }: ProjectManagerProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onlyProject = state.projects.length <= 1;

  function closeEditor() {
    const triggerKey = editor ? `${editor.type}:${editor.id}` : null;
    setEditor(null);
    if (triggerKey) queueMicrotask(() => triggerRefs.current.get(triggerKey)?.focus());
  }

  return <section className="project-manager" aria-labelledby="project-management">
    <div className="project-manager-heading">
      <h3 id="project-management" tabIndex={-1} ref={headingRef}><FolderCog size={19} aria-hidden="true" /> 管理学习项目</h3>
      <span>{state.projects.length} 个项目</span>
    </div>
    <p className="project-manager-intro">整理项目名称，或将任务与笔记合并到其他项目。</p>
    <ul className="project-manager-list">
      {state.projects.map(project => {
        const tasks = state.tasks.filter(task => task.projectId === project.id);
        const noteCount = (state.notes ?? []).filter(note => note.projectId === project.id).length;
        const needsTransfer = tasks.length > 0 || noteCount > 0;
        const archivedCount = tasks.filter(task => task.archived).length;
        const isRenaming = editor?.type === "rename" && editor.id === project.id;
        const isDeleting = editor?.type === "delete" && editor.id === project.id;
        const target = isDeleting ? state.projects.find(item => item.id === editor.targetId && item.id !== project.id) : undefined;
        const detailsId = `project-editor-${project.id}`;

        return <li className={`project-manager-item ${isRenaming || isDeleting ? "is-editing" : ""}`} key={project.id}>
          <div className="project-manager-row">
            <div className="project-manager-identity">
              <span className="project-manager-dot" style={{ background: project.color }} aria-hidden="true" />
              <div><strong title={project.title}>{project.title}</strong><p>{tasks.length} 个任务{archivedCount > 0 && <span> · 含 {archivedCount} 个已归档</span>} · {noteCount} 篇笔记</p></div>
            </div>
            <div className="project-manager-actions">
              <button type="button" ref={node => { if (node) triggerRefs.current.set(`rename:${project.id}`, node); else triggerRefs.current.delete(`rename:${project.id}`); }} aria-label={`重命名项目 ${project.title}`} aria-expanded={isRenaming} aria-controls={isRenaming ? detailsId : undefined} disabled={blocked} onClick={() => setEditor({ type: "rename", id: project.id, title: project.title })}><Pencil size={15} aria-hidden="true" /> 重命名</button>
              <button type="button" className="project-manager-delete" ref={node => { if (node) triggerRefs.current.set(`delete:${project.id}`, node); else triggerRefs.current.delete(`delete:${project.id}`); }} aria-label={`删除项目 ${project.title}`} aria-expanded={isDeleting} aria-controls={isDeleting ? detailsId : undefined} aria-describedby={onlyProject ? "project-last-help" : undefined} disabled={blocked || onlyProject} onClick={() => setEditor({ type: "delete", id: project.id, targetId: "" })}><Trash2 size={15} aria-hidden="true" /> 删除</button>
            </div>
          </div>

          {isRenaming && <form id={detailsId} className="project-manager-editor" onSubmit={event => {
            event.preventDefault();
            if (blocked || !editor.title.trim()) return;
            if (send({ type: "project.update", id: project.id, title: editor.title.trim() })) {
              closeEditor();
              onNotice("项目名称已更新");
            }
          }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeEditor(); } }}>
            <label htmlFor={`project-name-${project.id}`}>项目名称</label>
            <input id={`project-name-${project.id}`} autoFocus value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} maxLength={160} required disabled={blocked} aria-describedby={`project-name-help-${project.id}`} />
            <p id={`project-name-help-${project.id}`} className="project-manager-help">最多 160 字，任务、笔记和学习记录会保留。</p>
            <div className="project-manager-form-actions"><button type="button" onClick={closeEditor}><X size={15} aria-hidden="true" /> 取消</button><button type="submit" className="project-manager-primary" disabled={blocked || !editor.title.trim()}><Check size={15} aria-hidden="true" /> 保存名称</button></div>
          </form>}

          {isDeleting && <form id={detailsId} className="project-manager-editor project-manager-confirm" onSubmit={event => {
            event.preventDefault();
            if (blocked || onlyProject || (needsTransfer && !target)) return;
            if (send({ type: "project.delete", id: project.id, ...(needsTransfer && target ? { targetProjectId: target.id } : {}) })) {
              setEditor(null);
              queueMicrotask(() => headingRef.current?.focus());
              onNotice(needsTransfer ? "任务与笔记已转移，原项目已删除，历史记录已保留" : "空项目已删除");
            }
          }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeEditor(); } }}>
            <h4>确认删除这个项目？</h4>
            <p className="project-manager-confirm-name">{project.title}</p>
            {needsTransfer ? <>
              <p className="project-manager-help">先将全部 {tasks.length} 个任务和 {noteCount} 篇笔记转移到另一个项目，包括已完成和已归档的任务。任务笔记及学习记录都会保留，历史用时会计入新项目。</p>
              <label htmlFor={`project-destination-${project.id}`}><ArrowRightLeft size={15} aria-hidden="true" /> 转移到</label>
              <select id={`project-destination-${project.id}`} autoFocus value={target?.id ?? ""} onChange={event => setEditor({ ...editor, targetId: event.target.value })} required disabled={blocked}>
                <option value="" disabled>请选择接收任务与笔记的项目</option>
                {state.projects.filter(item => item.id !== project.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
              <p className="project-manager-help">正在进行的计时会继续。</p>
            </> : <p className="project-manager-help">这个项目的任务、笔记和学习记录均为空，可以直接删除。</p>}
            <div className="project-manager-form-actions"><button type="button" autoFocus={!needsTransfer} onClick={closeEditor}><X size={15} aria-hidden="true" /> 保留项目</button><button type="submit" className="project-manager-danger" disabled={blocked || onlyProject || (needsTransfer && !target)}><Trash2 size={15} aria-hidden="true" /> {needsTransfer ? "转移并删除" : "确认删除"}</button></div>
          </form>}
        </li>;
      })}
    </ul>
    {onlyProject && <p className="project-manager-last" id="project-last-help">至少保留一个学习项目。可以重命名当前项目，或先新建其他项目再删除。</p>}
    <p className="project-manager-footnote">项目修改会自动保存，并同步到其他设备。</p>
  </section>;
}

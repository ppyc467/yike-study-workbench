"use client";
import type { SyncDifference } from "../lib/sync-merge";
import "./backup-panel.css";

export default function SyncConflictPanel({ details, keepLocal, loadRemote }: { details: SyncDifference[]; keepLocal: () => void; loadRemote: () => void }) {
  return <section className="sync-differences card" aria-label="同步差异">
    <h2>核对两台设备的修改</h2>
    {details.map((detail, index) => <details key={index} open={index === 0}><summary>{detail.label}</summary><div className="sync-difference-columns"><div><h3>本机修改</h3><pre>{detail.local}</pre></div><div><h3>云端修改</h3><pre>{detail.remote}</pre></div></div></details>)}
    <div className="banner-actions"><button className="secondary-button" onClick={keepLocal}>保留本机修改并合并</button><button className="quiet-button" onClick={loadRemote}>使用云端版本</button></div>
  </section>;
}

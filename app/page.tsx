import Link from "next/link";
import { ArrowRight, Check, Cloud, Leaf, MonitorSmartphone, Timer } from "lucide-react";
import { getChatGPTUser } from "./chatgpt-auth";
import Workbench from "./workbench";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  const localPreview = process.env.NODE_ENV === "development";
  if (user) return <Workbench user={{ userId: user.userId, displayName: user.displayName }} />;
  return (
    <main className="welcome-page">
      <header className="welcome-header"><Link href="/" className="brand"><span className="brand-symbol"><Leaf size={23} strokeWidth={1.7} /></span><span>一刻<span className="brand-subtitle">个人学习工作台</span></span></Link><span className="welcome-private"><Cloud size={16} /> {localPreview ? "本机预览 · 尚未发布云端同步" : "私人空间 · 自动保存"}</span></header>
      <div className="welcome-content">
        <div className="welcome-copy"><span className="eyebrow"><span className="live-dot" /> A LITTLE FOCUS, EVERY DAY</span><h1>留一刻，<br />给正在成长的自己。</h1><p className="welcome-description">把想学的，变成正在做的。<br />记录每一次专注，让每天的小小进步，都有迹可循。</p><a className="primary-button welcome-signin" href="/signin-with-chatgpt?return_to=%2F" target="_top">{localPreview ? "打开本机工作台" : "使用 ChatGPT 登录"} <ArrowRight size={18} /></a><p className="signin-caption">{localPreview ? "本机预览使用体验账号，数据只保存在这台电脑。" : "电脑和手机，同一个账号，接着学。"}</p><div className="welcome-features"><span><Timer size={17} /> 专注计时</span><span><Check size={17} /> 任务与笔记</span><span><MonitorSmartphone size={17} /> 多端同步</span></div></div>
        <div className="welcome-visual" aria-hidden="true"><div className="welcome-visual-top"><span><span className="live-dot" /> 我的专注空间</span><Leaf size={19} /></div><div className="welcome-clock"><span className="clock-ring"><span className="welcome-clock-label">此刻，专注就好</span><strong>25<span>:</span>00</strong><span className="welcome-clock-caption">给一件事，完整的注意力</span></span></div><div className="welcome-note"><span className="note-check"><Check size={16} /></span><div><strong>每一刻，都算数。</strong><p>你的时间、任务和思路，会被好好保存。</p></div></div><div className="welcome-foliage foliage-one" /><div className="welcome-foliage foliage-two" /></div>
      </div><footer className="welcome-footer"><span>一刻 YIKE</span><p>不必急着抵达，先开始这一刻。</p><span>为你的专注而设计</span></footer>
    </main>
  );
}

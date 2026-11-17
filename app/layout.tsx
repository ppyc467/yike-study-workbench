import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "一刻 · 我的学习工作台",
  description: "留一刻，给正在成长的自己。专注计时、学习任务、每日汇总，电脑与手机自动同步。",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "一刻", statusBarStyle: "default" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

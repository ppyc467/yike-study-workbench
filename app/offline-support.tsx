"use client";
import { useEffect, useState } from "react";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export default function OfflineSupport({ userKey }: { userKey: string }) {
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "development" || !("serviceWorker" in navigator)) return;
    let stopped = false;
    let registration: ServiceWorkerRegistration | undefined;
    const installable = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const signout = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.('a[href^="/signout-with-chatgpt"]')) {
        navigator.serviceWorker.controller?.postMessage({ type: "CLEAR_USER" });
      }
    };
    const prepare = async () => {
      registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const active = (await navigator.serviceWorker.ready).active;
      if (stopped || !active) return;
      const elements = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src],link[rel="stylesheet"],link[rel="modulepreload"],link[rel="preload"]')]
        .map(element => "src" in element ? element.src : element.href);
      const resources = performance.getEntriesByType("resource").map(entry => entry.name);
      const assets = [...new Set([...elements, ...resources])].filter(value => {
        const url = new URL(value, location.origin);
        return url.origin === location.origin && !url.pathname.startsWith("/api/") && /\.(?:m?js|css|png|svg|woff2?|ttf|otf|ico)$/.test(url.pathname);
      });
      active.postMessage({ type: "PREPARE_USER", userKey, assets });
    };
    window.addEventListener("beforeinstallprompt", installable);
    document.addEventListener("click", signout, true);
    void prepare().catch(() => {});
    return () => { stopped = true; window.removeEventListener("beforeinstallprompt", installable); document.removeEventListener("click", signout, true); };
  }, [userKey]);
  return install ? <button className="offline-install quiet-button" style={{ position: "fixed", bottom: 86, right: 14, zIndex: 50, background: "#f7f8f2", border: "1px solid #dfe5d8", borderRadius: 14, padding: "10px 14px" }} onClick={async () => { await install.prompt(); await install.userChoice; setInstall(null); }}>安装一刻到桌面</button> : null;
}

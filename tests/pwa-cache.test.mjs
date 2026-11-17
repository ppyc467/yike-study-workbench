import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const origin = "https://study.example";
const workerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function bootWorker({ digest = value => webcrypto.subtle.digest("SHA-256", value), intercept } = {}) {
  const handlers = new Map();
  const storage = new Map();
  const requests = [];
  const state = { online: true, user: "account-a" };
  const key = request => new URL(typeof request === "string" ? request : request.url, origin).href;
  async function network(request, options = {}) {
    const url = key(request);
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    requests.push(url);
    if (!state.online) throw new Error("offline");
    const special = intercept?.(url, options, state);
    if (special) return await special;
    const path = new URL(url).pathname;
    if (path === "/signout-with-chatgpt") state.user = null;
    return new Response(path === "/" ? `PRIVATE_SHELL_${state.user}` : path === "/offline.html" ? "OFFLINE_FALLBACK" : `STATIC_${path}`);
  }
  const caches = {
    async keys() { return [...storage.keys()]; },
    async delete(name) { return storage.delete(name); },
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) { entries.set(key(request), response.clone()); },
        async addAll(urls) { for (const url of urls) entries.set(key(url), await network(url)); },
      };
    },
    async match(request) { for (const entries of storage.values()) if (entries.has(key(request))) return entries.get(key(request)).clone(); },
  };
  vm.runInNewContext(workerSource, {
    self: { location: { origin }, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    crypto: { subtle: { digest: (_algorithm, value) => digest(value) } },
    caches, fetch: network, Response, URL, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout,
  });
  async function lifecycle(name) {
    const pending = [];
    handlers.get(name)({ waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
  }
  async function message(data) {
    const pending = [];
    handlers.get("message")({ data, waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
  }
  async function request(path, options = {}) {
    const pending = [];
    let result;
    const req = { url: new URL(path, origin).href, method: options.method ?? "GET", mode: options.mode ?? "navigate" };
    handlers.get("fetch")({ request: req, waitUntil: promise => pending.push(promise), respondWith: promise => { result = promise; } });
    const response = await (result ?? network(req));
    await Promise.all(pending);
    return response;
  }
  return { state, requests, caches, lifecycle, message, request, storage };
}

test("PWA opens a prepared account offline and clears it for direct logout navigation", async () => {
  const app = bootWorker();
  await app.lifecycle("install");
  await app.message({ type: "PREPARE_USER", userKey: "account-a", assets: [] });
  app.state.online = false;
  assert.equal(await (await app.request("/")).text(), "PRIVATE_SHELL_account-a");
  app.state.online = true;
  await app.request("/signout-with-chatgpt?return_to=%2F");
  app.state.online = false;
  assert.equal(await (await app.request("/")).text(), "OFFLINE_FALLBACK");
  assert.equal((await app.caches.keys()).some(key => key.startsWith("yike-pages-")), false);
});

test("a delayed account preparation cannot recreate a cleared offline account", async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const app = bootWorker({ digest: async value => { entered(); await gate; return webcrypto.subtle.digest("SHA-256", value); } });
  await app.lifecycle("install");
  const preparing = app.message({ type: "PREPARE_USER", userKey: "account-a" });
  await started;
  const clearing = app.message({ type: "CLEAR_USER" });
  release();
  await Promise.all([preparing, clearing]);
  app.state.online = false;
  assert.equal(await (await app.request("/")).text(), "OFFLINE_FALLBACK");
});

test("switching accounts replaces the private shell and discards stale navigation cache writes", async () => {
  let release;
  let block = false;
  const app = bootWorker({ intercept: url => {
    if (block && url === `${origin}/`) {
      block = false;
      return new Promise(resolve => { release = () => resolve(new Response("PRIVATE_SHELL_account-a")); });
    }
  } });
  await app.lifecycle("install");
  await app.message({ type: "PREPARE_USER", userKey: "account-a" });
  block = true;
  const stale = app.request("/");
  await tick();
  app.state.user = "account-b";
  await app.message({ type: "PREPARE_USER", userKey: "account-b" });
  release();
  await stale;
  app.state.online = false;
  assert.equal(await (await app.request("/")).text(), "PRIVATE_SHELL_account-b");
  assert.equal((await app.caches.keys()).filter(key => key.startsWith("yike-pages-")).length, 1);
});

test("PWA precaches same-origin module dependencies and never caches APIs or auth pages", async () => {
  const app = bootWorker();
  await app.lifecycle("install");
  await app.message({ type: "PREPARE_USER", userKey: "account-a", assets: ["/_next/static/chunks/dependency.js", "/font.woff2", "/api/private.js", "/mcp", "/signin-with-chatgpt", "https://foreign.example/private.js"] });
  assert.equal(app.requests.some(url => url.endsWith("/api/private.js")), false);
  app.state.online = false;
  assert.match(await (await app.request("/_next/static/chunks/dependency.js", { mode: "cors" })).text(), /dependency.js/);
  assert.match(await (await app.request("/font.woff2", { mode: "cors" })).text(), /font.woff2/);
  app.state.online = true;
  await app.request("/api/private.js", { mode: "cors" });
  await app.request("/signin-with-chatgpt", { mode: "navigate" });
  assert.equal(await app.caches.match("/api/private.js"), undefined);
  assert.equal(await app.caches.match("/signin-with-chatgpt"), undefined);
  await app.request("/_next/static/chunks/lazy.js", { mode: "cors" });
  app.state.online = false;
  assert.match(await (await app.request("/_next/static/chunks/lazy.js", { mode: "cors" })).text(), /lazy.js/);
});

test("OfflineSupport includes modulepreloads and first-load resource dependencies", async () => {
  const source = ts.transpileModule(readFileSync(new URL("../app/offline-support.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const messages = [];
  const active = { postMessage: message => messages.push(message) };
  let selector;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: name => name === "react" ? { useState: () => [null, () => {}], useEffect: callback => callback() } : { jsx: () => null },
    process: { env: { NODE_ENV: "production" } },
    navigator: { serviceWorker: { register: async () => ({}), ready: Promise.resolve({ active }) } },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, querySelectorAll(value) { selector = value; return [{ src: `${origin}/entry.js` }, { href: `${origin}/modulepreload.js` }]; } },
    performance: { getEntriesByType: () => [{ name: `${origin}/hydration-dependency.js` }, { name: `${origin}/font.woff2` }, { name: `${origin}/api/private.js` }, { name: "https://foreign.example/external.js" }] },
    location: { origin }, URL,
  });
  module.exports.default({ userKey: "account-a" });
  await tick();
  assert.match(selector, /modulepreload/);
  assert.deepEqual(Array.from(messages[0].assets), [`${origin}/entry.js`, `${origin}/modulepreload.js`, `${origin}/hydration-dependency.js`, `${origin}/font.woff2`]);
});

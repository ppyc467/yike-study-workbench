import { ChatError } from "./task-chat";

/** Limit streamed bodies as well as requests that declare their length. */
export async function readChatInput(request: Request, allowed: string[], maxBytes = 100_000): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new ChatError("此学习对话请求的来源无效", 403);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw new ChatError("请使用 JSON 提交学习对话", 415);
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new ChatError("这次提交的内容过大，请缩短后重试", 413);
  if (!request.body) throw new ChatError("请求内容不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ChatError("这次提交的内容过大，请缩短后重试", 413); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ChatError("请求内容不是有效的 JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))) throw new ChatError("学习对话请求格式不正确");
  return payload as Record<string, unknown>;
}

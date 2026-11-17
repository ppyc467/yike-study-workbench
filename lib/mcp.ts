import { STUDY_TOOLS, callStudyTool } from "./study-tools";
import type { WorkspaceStore } from "./workspace-store";

const PROTOCOL_VERSION = "2026-07-28";
const MAX_BODY_BYTES = 128_000;
type RequestId = string | number | null;

class RequestError extends Error {
  constructor(readonly code: number, message: string, readonly status = 400) { super(message); }
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function failure(id: RequestId, code: number, message: string, status = 200) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Enforce the byte limit even when the caller uses chunked transfer. */
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw new RequestError(-32600, "请求内容过大，请减少笔记内容后重试", 413);
  }
  if (!request.body) throw new RequestError(-32700, "请求内容不能为空");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(-32600, "请求内容过大，请减少笔记内容后重试", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(-32700, "请求内容不是有效的 JSON");
  } finally {
    reader.releaseLock();
  }
}

/** Stateless MCP; Sites verifies this identity before forwarding /mcp requests. */
export async function handleMcpRequest(request: Request, store: WorkspaceStore): Promise<Response> {
  if (request.method !== "POST") {
    const response = failure(null, -32600, "请使用 POST 请求", 405);
    response.headers.set("Allow", "POST");
    return response;
  }
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (!userId) return failure(null, -32001, "请先连接学习工作台插件", 401);

  const origin = request.headers.get("origin");
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return failure(null, -32003, "请求来源无效", 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return failure(null, -32600, "请使用 JSON 请求", 415);
  }

  let id: RequestId = null;
  try {
    const body = await readBody(request);
    if (!record(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || !body.method.length) {
      throw new RequestError(-32600, "JSON-RPC 请求格式不正确");
    }
    const hasId = Object.hasOwn(body, "id");
    if (hasId && body.id !== null && typeof body.id !== "string" && (typeof body.id !== "number" || !Number.isFinite(body.id))) {
      throw new RequestError(-32600, "JSON-RPC 请求标识不正确");
    }
    id = hasId ? body.id as RequestId : null;
    if (body.params !== undefined && !record(body.params)) {
      throw new RequestError(-32602, "请求参数必须是对象");
    }
    // No notification may dispatch a tool: mutations always have a result the
    // caller can inspect, retry safely, and distinguish from a rejected update.
    if (!hasId) return new Response(null, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    const params = (body.params ?? {}) as Record<string, unknown>;
    let result: unknown;
    switch (body.method) {
      case "server/discover":
        result = { supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {} } };
        break;
      case "initialize": {
        // Older MCP clients may still initialize before listing tools.
        const legacyVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        const requested = params.protocolVersion;
        result = {
          protocolVersion: typeof requested === "string" && legacyVersions.includes(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "yike-study-workbench", version: "1.0.0" },
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        if (params.cursor !== undefined) throw new RequestError(-32602, "工具列表无需分页");
        result = { tools: STUDY_TOOLS };
        break;
      case "tools/call": {
        if (typeof params.name !== "string" || !STUDY_TOOLS.some((tool) => tool.name === params.name)) {
          throw new RequestError(-32602, "没有找到这个学习工具");
        }
        if (params.arguments !== undefined && !record(params.arguments)) {
          throw new RequestError(-32602, "工具参数必须是对象");
        }
        result = await callStudyTool(params.name, params.arguments ?? {}, userId, store);
        break;
      }
      default:
        return failure(id, -32601, "不支持这个 MCP 方法");
    }
    return json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (error instanceof RequestError) return failure(id, error.code, error.message, error.status);
    return failure(id, -32603, "暂时无法处理学习工作台请求，请稍后重试", 500);
  }
}

export type ServerEvent = { event: string; data: string };
// A completed event includes a full page of saved turns, with JSON escaping.
const MAX_EVENT_LENGTH = 32_000_000;

/** Decode SSE across arbitrary UTF-8 chunks, including CRLF and multiline data. */
export async function readServerEvents(response: Response, onEvent: (event: ServerEvent) => void | Promise<void>) {
  if (!response.body) throw new Error("回答连接中断，请重试这个问题。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let eventSize = 0;
  async function line(value: string) {
    if (!value) {
      if (data.length) await onEvent({ event, data: data.join("\n") });
      event = "message";
      data = [];
      eventSize = 0;
      return;
    }
    if (value.startsWith("event:")) event = value.slice(6).trim();
    if (value.startsWith("data:")) {
      const part = value.slice(5).replace(/^ /, "");
      eventSize += part.length;
      if (eventSize > MAX_EVENT_LENGTH) throw new Error("回答数据过大，请重新连接后查看。");
      data.push(part);
    }
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > MAX_EVENT_LENGTH) throw new Error("回答数据过大，请重新连接后查看。");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        await line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
      if (chunk.done) break;
    }
    if (buffer) await line(buffer.replace(/\r$/, ""));
    await line("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

/** Read just the reply string while JSON is arriving. Final JSON is validated separately. */
export function createReplyDecoder() {
  let phase: "key" | "keyText" | "colon" | "value" | "valueText" | "after" = "key";
  let key = "";
  let escape = false;
  let unicode: string | null = null;
  return (chunk: string) => {
    let reply = "";
    for (const character of chunk) {
      if (phase === "keyText" || phase === "valueText") {
        let decoded = character;
        if (unicode !== null) {
          unicode += character;
          if (unicode.length < 4) continue;
          decoded = String.fromCharCode(parseInt(unicode, 16));
          unicode = null;
        } else if (escape) {
          escape = false;
          if (character === "u") { unicode = ""; continue; }
          const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
          decoded = escapes[character] ?? character;
        } else if (character === "\\") {
          escape = true;
          continue;
        } else if (character === '"') {
          phase = phase === "keyText" ? "colon" : "after";
          continue;
        }
        if (phase === "keyText") key += decoded;
        else if (key === "reply") reply += decoded;
      } else if (phase === "key" && character === '"') {
        key = "";
        phase = "keyText";
      } else if (phase === "colon" && character === ":") phase = "value";
      else if (phase === "value" && character === '"') phase = "valueText";
      else if (phase === "after" && character === ",") phase = "key";
    }
    return reply;
  };
}

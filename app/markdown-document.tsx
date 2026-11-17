"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import type { Root, Nodes, PhrasingContent } from "mdast";
import type { Element } from "hast";
import "./markdown-document.css";

export type MarkdownHeading = { id: string; text: string; depth: number };
type LocatedHeading = MarkdownHeading & { line: number };

function documentHeadings(body: string, headingPrefix = "note-heading"): LocatedHeading[] {
  const headings: LocatedHeading[] = [];
  const usedIds = new Set<string>();

  function collect(node: Nodes) {
    if (node.type === "heading") {
      const text = toString(node).replace(/==(.+?)==/g, "$1").replace(/~~(.+?)~~/g, "$1");
      const slug = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-") || "section";
      let id = `${headingPrefix}-${slug}`;
      let suffix = 2;
      while (usedIds.has(id)) id = `${headingPrefix}-${slug}-${suffix++}`;
      usedIds.add(id);
      headings.push({ id, text, depth: node.depth, line: node.position?.start.line ?? 0 });
    }
    if ("children" in node) node.children.forEach(collect);
  }

  collect(fromMarkdown(body));
  return headings;
}

export function markdownHeadings(body: string): MarkdownHeading[] {
  return documentHeadings(body).map(({ id, text, depth }) => ({ id, text, depth }));
}

/** Highlight text nodes only, keeping inline code and fenced code literal. */
function highlightedText(value: string): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  let offset = 0;
  for (const match of value.matchAll(/==(.+?)==/g)) {
    const index = match.index!;
    if (index > offset) children.push({ type: "text", value: value.slice(offset, index) });
    children.push({ type: "emphasis", data: { hName: "mark" }, children: [{ type: "text", value: match[1] }] });
    offset = index + match[0].length;
  }
  if (offset < value.length) children.push({ type: "text", value: value.slice(offset) });
  return children;
}

function remarkReadingFeatures({ headings }: { headings: LocatedHeading[] }) {
  const idsByLine = new Map(headings.map(heading => [heading.line, heading.id]));

  return (tree: Root) => {
    function visit(node: Nodes) {
      if (node.type === "heading") {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: idsByLine.get(node.position?.start.line ?? 0) } };
      }
      if ("children" in node) {
        for (const child of node.children) visit(child);
        if (node.type === "paragraph" || node.type === "heading" || node.type === "emphasis" || node.type === "strong" || node.type === "delete" || node.type === "link" || node.type === "linkReference" || node.type === "tableCell") {
          node.children = node.children.flatMap(child => child.type === "text" ? highlightedText(child.value) : [child]);
        }
      }
    }
    visit(tree);
  };
}

function codeText(node: Element): string {
  return node.children.map(child => child.type === "text" ? child.value : child.type === "element" ? codeText(child) : "").join("");
}

function CodeBlock({ children, node }: { children?: ReactNode; node?: Element }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const code = node ? codeText(node).replace(/\n$/, "") : "";
  const codeNode = node?.children.find(child => child.type === "element" && child.tagName === "code");
  const classNames = codeNode?.type === "element" ? codeNode.properties.className : undefined;
  const language = Array.isArray(classNames) ? classNames.find(value => typeof value === "string" && value.startsWith("language-"))?.toString().slice(9) : undefined;

  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  async function copyCode() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      resetTimer.current = setTimeout(() => setCopyState("idle"), 2200);
    } catch {
      setCopyState("error");
    }
  }

  return <div className="markdown-code-block">
    <div className="markdown-code-header">
      <span>{language || "代码"}</span>
      <button type="button" onClick={() => void copyCode()} aria-label={copyState === "copied" ? "代码已复制" : "复制代码"}>
        {copyState === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {copyState === "copied" ? "已复制" : "复制"}
      </button>
    </div>
    <pre tabIndex={0} aria-label={language ? `${language} 代码` : "代码块"}>{children}</pre>
    {copyState === "error" && <p className="markdown-copy-error" role="status">复制失败，请选中代码复制。</p>}
    <span className="sr-only" role="status">{copyState === "copied" ? "代码已复制" : ""}</span>
  </div>;
}

const markdownComponents: Components = {
  pre: CodeBlock,
  table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="笔记表格">
    <table>{children}</table>
  </div>,
};

export const MarkdownDocument = memo(function MarkdownDocument({ body, headingPrefix = "note-heading" }: { body: string; headingPrefix?: string }) {
  const headings = useMemo(() => documentHeadings(body, headingPrefix), [body, headingPrefix]);
  const components = useMemo<Components>(() => ({
    ...markdownComponents,
    a: ({ href, children }) => {
      const internal = href?.startsWith("#");
      let target = href;
      if (internal) {
        try {
          const headingId = `${headingPrefix}-${decodeURIComponent(href!.slice(1))}`;
          if (headings.some(heading => heading.id === headingId)) target = `#${headingId}`;
        } catch { /* Keep malformed fragments as their original text. */ }
      }
      return <a href={target} target={internal ? undefined : "_blank"} rel={internal ? undefined : "noreferrer noopener"}>{children}</a>;
    },
  }), [headings, headingPrefix]);

  return <div className="markdown-document">
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, [remarkReadingFeatures, { headings }]]}
      rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: false }]]}
      components={components}
    >{body}</ReactMarkdown>
  </div>;
});

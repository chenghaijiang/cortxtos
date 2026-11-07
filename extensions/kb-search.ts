// kb_search tool（票 03 文件版；票 09 无感升级语义检索）：知识库检索 extension
// 宿主注入 pi 实例；parameters 用裸 JSON Schema（Pi 文档确认与 TypeBox 等价），保持零宿主依赖
import { loadConfig } from "../src/config.ts";
import { formatHits, searchHybrid } from "../src/search.ts";
import { makeEmbedder } from "../src/embed.ts";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}
interface ExtensionAPI {
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }): void;
}

const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "关键词或自然语言描述均可（已建向量索引时支持『讲上下文压缩那篇』这类不记得词的问法）" },
    tags: { type: "array", items: { type: "string" }, description: "按 frontmatter tags 过滤，命中其一即可" },
    type: { type: "string", enum: ["note", "summary", "log", "workflow-output"], description: "按笔记类型过滤" },
    source: { type: "string", enum: ["inbox-pdf", "inbox-image", "manual", "reflect", "audio", "video"], description: "按来源过滤" },
    days: { type: "number", description: "只看最近 N 天创建的笔记（如『上周』传 14）" },
    limit: { type: "number", description: "返回条数上限，默认 5，最大 20" },
  },
  required: ["query"],
  additionalProperties: false,
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "kb_search",
    label: "KB Search",
    description:
      "检索本地知识库 cortxt-vault（notes/ 与 daily/ 的 Markdown 笔记），语义+关键字混合匹配，支持关键词、tags、类型、来源、近 N 天过滤。返回命中笔记的路径、标题、元信息、命中方式（关键字/语义）与上下文摘录。",
    promptSnippet: "检索本地知识库笔记（语义+关键字/tag/类型/时间）",
    promptGuidelines: [
      "当问题涉及用户自己保存的笔记、看过的资料或历史沉淀时，先调用 kb_search 再回答，不要凭空猜测。",
      "可以用自然语言描述来查（如「上次那篇讲上下文压缩的笔记」），不必强求精确关键词。",
      "kb_search 返回的『路径』应原样引用给用户，便于定位原始笔记。",
      "kb_search 未找到结果时如实告知，不要编造内容。",
    ],
    parameters,
    async execute(_toolCallId, params) {
      const { config } = loadConfig();
      const query = typeof params.query === "string" ? params.query : "";
      if (query.trim().length === 0) {
        return { content: [{ type: "text", text: "query 不能为空" }], details: { hits: [] } };
      }
      const hits = await searchHybrid(config, {
        query,
        tags: Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === "string") : undefined,
        type: typeof params.type === "string" ? params.type : undefined,
        source: typeof params.source === "string" ? params.source : undefined,
        days: typeof params.days === "number" ? params.days : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      }, makeEmbedder(config));
      const text = hits.note !== undefined ? `${hits.note}\n\n${formatHits(hits.hits)}` : formatHits(hits.hits);
      return { content: [{ type: "text", text }], details: { count: hits.hits.length, mode: hits.mode, hits: hits.hits } };
    },
  });
}

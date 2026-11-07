// /reflect（票 06）：会话回顾沉淀
// 命令 → 注入蒸馏指令（模型看得见完整会话上下文）→ 模型产出条目 → daily_log 工具落盘
// 追加语义由代码保证（src/daily.ts），不依赖模型自觉；手动触发，不做自动跑
import { loadConfig } from "../src/config.ts";
import { appendDaily } from "../src/daily.ts";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}
interface ExtensionAPI {
  registerCommand(name: string, options: { description?: string; handler: (args: string) => Promise<void> | void }): void;
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }): void;
  sendUserMessage(content: string): Promise<unknown> | void;
}

/** 注入给模型的蒸馏指令；focus 为 /reflect 的可选参数 */
export function buildReflectPrompt(focus: string): string {
  return [
    "用户触发了 /reflect：请回顾本次会话的完整内容，把其中有长期价值的结论蒸馏成沉淀条目，要求：",
    focus.trim().length > 0
      ? `本次沉淀聚焦方向：${focus.trim()}（只保留与该方向相关的结论）。`
      : "",
    "- 只沉淀结论、决策、方法与踩坑教训，不记流水账；每条一行，markdown 无序列表",
    "- 每条独立成立（未来的你不看会话原文也能读懂），保留关键名词与数字",
    "- 若本次会话没有值得沉淀的内容，直接回复『本次会话无可沉淀内容』，不要调用 daily_log，不要硬写",
    "- 有内容时调用一次 daily_log 工具，把全部条目作为 entry 传入",
    "- 落库后向用户报告写入路径与条目数",
  ]
    .filter(Boolean)
    .join("\n");
}

const parameters = {
  type: "object",
  properties: {
    entry: { type: "string", description: "要沉淀的 markdown 条目（一个或多个列表行，来自本次会话的蒸馏结论）" },
  },
  required: ["entry"],
  additionalProperties: false,
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reflect", {
    description: "回顾本次会话，把有长期价值的结论蒸馏进 daily/YYYY-MM-DD.md（可带提示词聚焦）",
    handler: async (args) => {
      await pi.sendUserMessage(buildReflectPrompt(args));
    },
  });

  pi.registerTool({
    name: "daily_log",
    label: "Daily Log",
    description:
      "把蒸馏出的结论条目追加到知识库 daily/YYYY-MM-DD.md（当日文件不存在则按 frontmatter schema 新建，存在则追加新节，绝不覆盖旧条目）。仅供 /reflect 会话沉淀使用。",
    promptSnippet: "向当日 daily 文件追加沉淀条目",
    promptGuidelines: [
      "只在用户明确触发 /reflect（或要求把会话结论写入 daily）时调用 daily_log；不要主动用它记流水账。",
      "daily_log 的 entry 应是蒸馏后的结论列表，每条一行 markdown 列表项，而非原始对话摘录。",
    ],
    parameters,
    async execute(_toolCallId, params) {
      const entry = typeof params.entry === "string" ? params.entry : "";
      if (entry.trim().length === 0) {
        return { content: [{ type: "text", text: "entry 不能为空" }], details: {} };
      }
      const { config } = loadConfig();
      const res = await appendDaily(config, entry);
      return {
        content: [
          {
            type: "text",
            text: `已${res.created ? "新建并写入" : "追加到"} ${res.path}（当前时间 ${new Date().toISOString()}）`,
          },
        ],
        details: res,
      };
    },
  });
}

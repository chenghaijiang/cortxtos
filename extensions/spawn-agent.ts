// spawn-agent（二期最小多 agent）：深度会话把整块活委派给无人值守会话
// run_headless_task = 起一个 cortxtos 同款 pi -p 子进程（CORTXTOS_HEADLESS=1 走 session-guard 窄门，无 bash）
// 定位：批量整理 inbox / 全库重刷摘要这类"能自主跑完、结果可摘要"的活；不用于需要用户确认的操作
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.ts";
import { headlessCommand } from "../src/launchd.ts";

const OUTPUT_MAX = 4000;
const TASK_TIMEOUT_MS = 12 * 60_000;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 跑一条无人值守子任务（导出供单测）：返回输出尾部、退出码与是否超时 */
export function runHeadlessCommand(
  cmd: string,
  timeoutMs = TASK_TIMEOUT_MS,
): Promise<{ text: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", cmd], { env: { ...process.env, CORTXTOS_HEADLESS: "1" } });
    const lines: string[] = [];
    let timedOut = false;
    const push = (buf: Buffer): void => {
      for (const l of buf.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        lines.push(l);
        if (lines.length > 2000) lines.splice(0, lines.length - 2000);
      }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ text: lines.join("\n").slice(-OUTPUT_MAX), code, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ text: `子任务启动失败：${e.message}`, code: -1, timedOut: false });
    });
  });
}

/** 便捷封装：按 prompt 组装无人值守命令后执行 */
export function runHeadless(prompt: string, skill?: string, timeoutMs = TASK_TIMEOUT_MS): Promise<{ text: string; code: number | null; timedOut: boolean }> {
  const { config } = loadConfig();
  return runHeadlessCommand(headlessCommand(config, prompt, skill), timeoutMs);
}

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
    prompt: { type: "string", description: "交给无人值守子会话的完整任务描述（自包含：背景、目标、完成标准都写清楚）" },
    use_inbox_skill: { type: "boolean", description: "是否加载 inbox-process 技能（处理 inbox/ 批量归档类任务时置 true）" },
  },
  required: ["prompt"],
  additionalProperties: false,
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_headless_task",
    label: "Run Headless Task",
    description:
      "把一个自包含的子任务委派给无人值守的本地 AI 会话（独立进程，只能读检索知识库与写笔记，不能执行系统命令），等它跑完返回结论。适合『批量整理 inbox』『把某批笔记重刷摘要』这类可并行、无需交互、结果可摘要的工作。",
    promptSnippet: "委派子任务给无人值守会话（最小多 agent）",
    promptGuidelines: [
      "子会话看不到当前对话上下文，prompt 必须自包含：要做什么、在哪、成功标准。",
      "需要用户逐步确认的操作不要交给子会话；子会话只能做检索/读写笔记/整理 inbox。",
      "子任务耗时可能达数分钟，一次不要串行委派多个任务。",
      "拿到子会话输出后，先提炼结论再回复用户，不要整段转贴。",
    ],
    parameters,
    async execute(_toolCallId, params) {
      const prompt = typeof params.prompt === "string" ? params.prompt.trim().slice(0, 4000) : "";
      if (!prompt) return { content: [{ type: "text", text: "run_headless_task 需要非空 prompt" }], details: { error: "empty prompt" } };
      const skill = params.use_inbox_skill === true ? join(PACKAGE_ROOT, "skills", "inbox-process") : undefined;
      const r = await runHeadless(prompt, skill);
      const head = r.timedOut ? "⚠ 子任务超时被终止。" : r.code === 0 ? "✅ 子任务正常结束。" : `⚠ 子任务退出码 ${r.code}。`;
      return {
        content: [{ type: "text", text: `${head}\n\n--- 子会话输出（尾部） ---\n${r.text || "（无输出）"}` }],
        details: { code: r.code, timedOut: r.timedOut, outputLength: r.text.length },
      };
    },
  });
}

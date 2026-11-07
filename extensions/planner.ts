// planner（二期 Web 深度模式）：独立任务规划面板工具
// update_plan 不做任何实际工作，只把当前计划全量落到 workflows/plan-*.md（可被 kb 检索、断电可恢复）
// 事件翻译层会把它的参数转成 {plan} 事件，前端渲染进度条 + 步骤勾选卡片并原地刷新
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { vaultDir } from "../src/vault.ts";

const STATUSES = ["pending", "doing", "done", "skipped"] as const;
type Status = (typeof STATUSES)[number];

export interface PlanStep {
  text: string;
  status: Status;
}

/** 参数校验 + 归一化：非法输入返回错误文案，合法返回整理后的 goal/steps（导出供单测） */
export function normalizePlan(params: Record<string, unknown>): { error: string } | { goal: string; steps: PlanStep[] } {
  const goal = typeof params.goal === "string" ? params.goal.trim().slice(0, 300) : "";
  if (!goal) return { error: "update_plan 需要非空 goal（一句话说明这次任务要达成什么）" };
  if (!Array.isArray(params.steps) || params.steps.length === 0) return { error: "update_plan 需要至少一个 step" };
  if (params.steps.length > 30) return { error: "steps 超过 30 项，请拆分任务" };
  const steps: PlanStep[] = [];
  for (const s of params.steps as unknown[]) {
    const o = (s ?? {}) as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 300) : "";
    if (!text) return { error: "存在空步骤文本（每个 step 需要 {text, status}）" };
    const status = (STATUSES as readonly string[]).includes(String(o.status)) ? (o.status as Status) : "pending";
    steps.push({ text, status });
  }
  if (!steps.some((s) => s.status === "doing") && steps.some((s) => s.status === "pending") && steps.every((s) => s.status === "pending")) {
    steps[0]!.status = "doing"; // 首步自动开工，避免面板全是灰勾
  }
  return { goal, steps };
}

/** 计划文件正文：Markdown checkbox，进度行便于人读 */
export function renderPlan(goal: string, steps: PlanStep[], stamp: string): string {
  const done = steps.filter((s) => s.status === "done").length;
  const mark = (s: PlanStep): string => (s.status === "done" ? "x" : " ");
  return [
    "# 任务计划",
    "",
    `- goal：${goal}`,
    `- 更新：${stamp}`,
    `- 进度：${done}/${steps.length}`,
    "",
    ...steps.map((s) => `- [${mark(s)}] ${s.text}${s.status === "doing" ? "（进行中）" : s.status === "skipped" ? "（跳过）" : ""}`),
    "",
  ].join("\n");
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
    goal: { type: "string", description: "本次任务要达成什么（一句话）" },
    steps: {
      type: "array",
      description: "完整步骤清单（每次调用都要提交全量，不是增量）",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "步骤描述" },
          status: { type: "string", enum: [...STATUSES], description: "pending|doing|done|skipped" },
        },
        required: ["text", "status"],
      },
    },
  },
  required: ["goal", "steps"],
  additionalProperties: false,
};

function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 正文时间戳与文件名同源（本地时区），避免 iso 的 UTC 差 8 小时 */
function timeText(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "update_plan",
    label: "Update Plan",
    description:
      "建立并持续更新多步骤任务的执行计划（任务规划面板）。首次动手前调用建立计划；每完成一步再次调用并提交全量步骤与新状态。不做实际工作，只记录计划。",
    promptSnippet: "建立/更新多步骤任务计划（规划面板）",
    promptGuidelines: [
      "超过两步的任务，先调用 update_plan 建立计划，再开始实际执行。",
      "每完成一步就调用一次 update_plan 更新状态；steps 必须提交全量而不是增量。",
      "同一次任务尽量复用同一个 goal 文本，便于用户对照进度。",
      "任务全部完成时用 update_plan 把剩余步骤标为 done 或 skipped，收尾说明结论。",
    ],
    parameters,
    async execute(_toolCallId, params) {
      const norm = normalizePlan(params);
      if ("error" in norm) return { content: [{ type: "text", text: norm.error }], details: { error: norm.error } };
      const { config } = loadConfig();
      const dir = join(vaultDir(config), "workflows");
      await mkdir(dir, { recursive: true });
      const now = new Date();
      const file = join(dir, `plan-${stamp(now)}.md`);
      await writeFile(file, renderPlan(norm.goal, norm.steps, timeText(now)), "utf8");
      const done = norm.steps.filter((s) => s.status === "done").length;
      return {
        content: [{ type: "text", text: `计划已更新（${done}/${norm.steps.length} 完成）：${file.slice(dir.length + 1)}` }],
        details: { goal: norm.goal, steps: norm.steps, file },
      };
    },
  });
}

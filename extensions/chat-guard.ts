// chat-guard（二期 Web 深度模式）：浏览器确认闸门
// 与 session-guard（无人值守白名单）互不干扰：本文件只在 Web 深度会话通过 -e 显式加载
// 策略：bash 一律确认；write/edit 越出 vault 才确认；read/自带低风险工具（检索、规划）不拦
// RPC 模式下 ctx.ui.confirm 会自动转为 extension_ui_request 发到 stdout，阻塞等待前端 extension_ui_response

const DANGEROUS = /(\brm\b|\bsudo\b|\bmkfs\b|\bdd\s|chmod\s+-R|:\(\)\s*\{|\breboot\b|\bshutdown\b|\bgit\s+push\b|\bkill\b|\blaunchctl\b)/i;

// 本仓库自带的低风险工具：只读或写入固定在 vault 内（kb_search 检索、update_plan 只写 workflows/），
// 不打扰用户；否则一次多步任务会被规划工具的确认卡片刷屏。
const LOW_RISK = new Set(["kb_search", "update_plan", "list_inbox", "extract_pdf", "transcribe_audio", "archive_inbox"]);

export interface Decision {
  need: boolean;
  title: string;
  message: string;
}

/** vault 内路径判定：resolve 后必须以 root + sep 开头（与 server.ts withinVault 同逻辑，extension 内不 import 服务端） */
function withinRoot(root: string, p: string): boolean {
  if (!p) return false;
  if (p.startsWith("~")) return false; // 家目录展开不在 vault 内（pi 工具入参可能已展开，但模型直写 ~/ 也要拦）
  const abs = p.startsWith("/") ? p : `${root.replace(/\/+$/, "")}/${p.replace(/^\.\/+/, "")}`;
  const norm = (s: string): string => {
    const out: string[] = [];
    for (const seg of s.split("/")) {
      if (seg === "..") out.pop();
      else if (seg && seg !== ".") out.push(seg);
    }
    return (s.startsWith("/") ? "/" : "") + out.join("/");
  };
  const r = norm(root).replace(/\/+$/, "");
  const a = norm(abs);
  return a === r || a.startsWith(`${r}/`);
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") {
    const cmd = String(input.command ?? "");
    const t = String(input.timeout ?? "");
    return `命令：${cmd.slice(0, 800)}${t ? `\n超时：${t}s` : ""}`;
  }
  const p = String(input.path ?? input.file_path ?? "");
  const body = String(input.content ?? input.new_string ?? "");
  return `路径：${p.slice(0, 300)}${body ? `\n内容长度：${body.length} 字符` : ""}`;
}

/** 是否需要用户确认（导出供单测；root 为空时视为无法判定路径 → 写侧一律确认） */
export function needsApproval(toolName: string, input: Record<string, unknown>, root = ""): Decision | null {
  if (toolName === "read" || toolName === "ls" || toolName === "glob" || toolName === "grep") return null;
  if (LOW_RISK.has(toolName)) return null;
  if (toolName === "bash") {
    const cmd = String(input.command ?? "");
    const danger = DANGEROUS.test(cmd);
    return {
      need: true,
      title: danger ? "⚠ 高危命令确认" : "允许执行命令？",
      message: summarize("bash", input),
    };
  }
  if (toolName === "write" || toolName === "edit") {
    const p = String(input.path ?? input.file_path ?? "");
    if (root && withinRoot(root, p)) return null; // vault 内写入：低危，模型自主
    return { need: true, title: "⚠ vault 外写入确认", message: summarize(toolName, input) };
  }
  // 未知/其他工具（含 MCP 等外部能力）：默认确认，宁可多问
  // pi 的 codemode 会把外部 MCP 工具（如 GitHub）聚合成一个代码执行工具，单独给个说得清的标题
  if (toolName === "codemode" || toolName.startsWith("mcp")) {
    const code = input.code ?? input.snippet;
    const message = typeof code === "string" && code.trim() ? code : JSON.stringify(input);
    return { need: true, title: `允许执行 MCP 外部能力（${toolName}）？`, message: message.slice(0, 800) };
  }
  return { need: true, title: `允许调用工具 ${toolName}？`, message: JSON.stringify(input).slice(0, 800) };
}

interface ExtensionUI {
  confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
}
interface ExtensionCtx {
  cwd: string;
  ui: ExtensionUI;
  [key: string]: unknown;
}
interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}
interface ExtensionAPI {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionCtx) => Promise<{ block?: boolean; reason?: string } | undefined>,
  ): void;
}

const CONFIRM_TIMEOUT_MS = 300_000; // 5 分钟无操作由 pi 侧自动按拒绝处理（前端另有 120s 主动取消）

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const d = needsApproval(event.toolName, event.input ?? {}, ctx?.cwd ?? "");
    if (!d?.need) return undefined;
    const ok = await ctx.ui.confirm(d.title, `${d.message}\n\n（拒绝后模型会收到原因并改用其他方式）`, { timeout: CONFIRM_TIMEOUT_MS });
    if (ok) return undefined;
    return { block: true, reason: `用户在 Web 工作台拒绝（或 ${CONFIRM_TIMEOUT_MS / 1000}s 内未确认）：${d.title}` };
  });
}

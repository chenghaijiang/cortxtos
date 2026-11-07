// session-guard（票 04）：无人值守会话工具窄门
// print/json 模式或 CORTXTOS_HEADLESS=1 时：白名单外工具从清单裁剪 + 调用拦截双保险
// inbox 工具（票 05/08）自身已把路径锁死在 vault/inbox，纳入白名单不扩大爆炸半径
export const HEADLESS_WHITELIST = [
  "read",
  "write",
  "kb_search",
  "list_inbox",
  "extract_pdf",
  "transcribe_audio",
  "archive_inbox",
] as const;

export interface GuardRunCtx {
  mode: string; // "tui" | "rpc" | "json" | "print"
}

export function isHeadless(ctx: GuardRunCtx): boolean {
  return ctx.mode === "print" || ctx.mode === "json" || process.env.CORTXTOS_HEADLESS === "1";
}

export function isToolAllowed(toolName: string): boolean {
  return (HEADLESS_WHITELIST as readonly string[]).includes(toolName);
}

interface ExtensionCtx extends GuardRunCtx {
  [key: string]: unknown;
}
interface ToolCallEvent {
  toolName: string;
  [key: string]: unknown;
}
interface ExtensionAPI {
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionCtx) => Promise<unknown> | unknown): void;
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionCtx) => Promise<{ block?: boolean; reason?: string } | undefined>,
  ): void;
  setActiveTools(names: string[]): void;
}

export default function (pi: ExtensionAPI) {
  // 双保险第一层：会话启动即裁剪，白名单外工具对模型不可见
  pi.on("session_start", (_event, ctx) => {
    if (isHeadless(ctx)) {
      pi.setActiveTools([...HEADLESS_WHITELIST]);
    }
  });

  // 双保险第二层：拦截漏网调用（其他 extension 后续激活的工具也挡得住）
  pi.on("tool_call", async (event, ctx) => {
    if (!isHeadless(ctx)) return undefined;
    if (isToolAllowed(event.toolName)) return undefined;
    return {
      block: true,
      reason: `无人值守会话安全窄门：工具 ${event.toolName} 不在白名单（${HEADLESS_WHITELIST.join(", ")}）内，被 session-guard 拦截`,
    };
  });
}

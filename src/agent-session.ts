// 深度模式会话管理器（二期 RPC 嵌入）：以 pi --mode rpc 长驻子进程为智能体运行时
// Web 端通过 /api/agent/* 收发的 NDJSON 事件由本模块从 pi 的 JSONL 协议翻译而来
// 协议要点（本机 pi 1.5.0 docs 实测核对）：
// - 严格 LF 分帧：每条记录一个 JSON 对象以 \n 结尾；Node readline 会在 U+2028/U+2029 断行，禁用
// - 命令走 stdin（带自增 id），stdout 回 response（按 id 关联）+ session 事件 + extension_ui_request
// - agent_settled 表示 pi 不再有自动后续工作（重试/压缩/追加都排完），是每轮提示的收尾信号
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CortxtosConfig } from "./config.ts";
import { pipelineModel } from "./tier.ts";
import { vaultDir } from "./vault.ts";

const IDLE_MS = 10 * 60_000; // 空闲 10 分钟自动回收 pi 进程
const CMD_TIMEOUT_MS = 10_000; // 命令→response 关联超时
const TOOL_RESULT_MAX = 4000; // 工具结果透给前端的预览上限

/** pi 全局 npm 包与 node 同目录（launchd.ts 同款教训：PATH 不可靠时用绝对路径） */
export function piBinary(): string {
  if (process.env.CORTXTOS_PI) return process.env.CORTXTOS_PI;
  const sameDir = join(dirname(process.execPath), "pi");
  return existsSync(sameDir) ? sameDir : "pi";
}

/** 严格 LF 分帧：只按 0x0A 切，容忍可选 \r；U+2028/U+2029 是字符串合法字符不是边界（导出供单测） */
export function splitFrames(buf: Buffer, pending: Buffer): { frames: string[]; rest: Buffer } {
  const all = pending.length ? Buffer.concat([pending, buf]) : buf;
  const frames: string[] = [];
  let start = 0;
  for (;;) {
    const i = all.indexOf(0x0a, start);
    if (i < 0) break;
    let s = all.subarray(start, i).toString("utf8");
    if (s.endsWith("\r")) s = s.slice(0, -1);
    if (s.trim()) frames.push(s);
    start = i + 1;
  }
  return { frames, rest: all.subarray(start) };
}

// —— 事件翻译表：pi session 事件 -> Web NDJSON（纯函数，导出供单测）——
// null = 无需透传给浏览器的事件；ui_request 由 PiSession 单独走 onUiRequest 通道
export type WebEvent = Record<string, unknown> | null;

export function translatePiEvent(o: Record<string, unknown>): WebEvent {
  switch (o.type) {
    case "message_update": {
      const am = o.assistantMessageEvent as Record<string, unknown> | undefined;
      if (am?.type === "text_delta" && typeof am.delta === "string" && am.delta) return { content: am.delta };
      return null;
    }
    case "tool_execution_start":
      return { tool: String(o.toolName ?? ""), args: o.args ?? {} };
    case "tool_execution_end": {
      const result = o.result as { content?: Array<{ type: string; text?: string }> } | undefined;
      const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      const ok = o.isError !== true;
      const ev: Record<string, unknown> = {
        tool_result: String(o.toolName ?? ""),
        preview: text.slice(0, TOOL_RESULT_MAX),
        ok,
      };
      // planner 特判：update_plan 的参数即完整计划 -> 独立规划卡片事件（前端原地刷新）
      if (o.toolName === "update_plan" && ok) {
        const args = o.args as Record<string, unknown> | undefined;
        if (args && Array.isArray(args.steps)) ev.plan = { goal: String(args.goal ?? ""), steps: args.steps };
      }
      return ev;
    }
    case "compaction_start":
      return { system: `上下文压缩中（${String(o.reason ?? "自动")}）…` };
    case "compaction_end":
      return o.result
        ? { system: "上下文压缩完成，历史已摘要保留" }
        : o.aborted
          ? null
          : { error: `上下文压缩失败：${String(o.errorMessage ?? "未知原因")}` };
    case "auto_retry_start":
      return { system: `模型调用失败正在重试（${String(o.attempt ?? 1)}/${String(o.maxAttempts ?? 3)}）：${String(o.errorMessage ?? "").slice(0, 120)}` };
    case "extension_error":
      return { error: `扩展执行异常：${String(o.error ?? "").slice(0, 300)}` };
    case "agent_settled":
      return { done: true, aborted: o.aborted === true };
    default:
      return null;
  }
}

/** tool_execution_end 协议里不带 args —— 会话层按 toolCallId 缓存 start 参数补齐（导出供单测） */
export function attachStartArgs(
  o: Record<string, unknown>,
  startArgs: Map<string, unknown>,
): Record<string, unknown> {
  if (o.type === "tool_execution_start" && typeof o.toolCallId === "string") {
    startArgs.set(o.toolCallId, o.args);
    return o;
  }
  if (o.type === "tool_execution_end" && typeof o.toolCallId === "string" && o.args === undefined && startArgs.has(o.toolCallId)) {
    const copy = { ...o, args: startArgs.get(o.toolCallId) };
    startArgs.delete(o.toolCallId);
    return copy;
  }
  return o;
}

export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusText?: string;
  timeout?: number;
}

export interface PiCommandResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** 单个 pi RPC 子进程的封装：命令关联、事件分发、UI 请求双通道 */
export class PiSession {
  readonly sessionId = randomUUID().slice(0, 8);
  readonly child: ChildProcessWithoutNullStreams;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private cmdSeq = 0;
  private waiting = new Map<string, { resolve: (r: PiCommandResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private eventCbs: Array<(o: Record<string, unknown>) => void> = [];
  private uiCbs: Array<(req: UiRequest) => void> = [];
  private exitCb: ((code: number | null) => void) | null = null;
  private toolStartArgs = new Map<string, unknown>();
  private stderrRing: string[] = [];
  private disposed = false;
  private lastActivityAt = Date.now(); // 最近一次收到 pi 输出（事件/响应/UI 请求都算活动）
  private turnActive = false; // 本轮 agent 未收尾
  private uiPending = new Set<string>(); // 确认卡片在等用户应答

  constructor(config: CortxtosConfig, packageRoot: string, opts: { skillDir?: string; extensions: string[]; appendSystemPrompt?: string }) {
    const vault = vaultDir(config);
    const args = [
      "--mode", "rpc",
      "--provider", "ollama",
      "--model", pipelineModel(config),
      "--approve",
    ];
    if (opts.skillDir) args.push("--skill", opts.skillDir);
    if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
    for (const e of opts.extensions) args.push("-e", e);
    this.child = spawn(piBinary(), args, {
      cwd: vault,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
        OLLAMA_MAX_LOADED_MODELS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (buf: Buffer) => this.onData(buf));
    this.child.stderr.on("data", (buf: Buffer) => {
      for (const l of buf.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        this.stderrRing.push(l);
        if (this.stderrRing.length > 100) this.stderrRing.splice(0, this.stderrRing.length - 100);
      }
    });
    this.child.on("exit", (code) => {
      this.turnActive = false;
      this.uiPending.clear();
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error(`pi 进程已退出（code ${code}）：${this.tail(3)}`));
      }
      this.waiting.clear();
      this.exitCb?.(code);
    });
    this.child.on("error", (e) => {
      this.stderrRing.push(`spawn error: ${e.message}`);
    });
  }

  tail(n = 5): string {
    return this.stderrRing.slice(-n).join("\n");
  }

  /** 本轮 agent 未收尾，或有确认卡片在等用户应答 —— 此时不能按空闲回收（长任务单轮可远超 10 分钟） */
  busy(): boolean {
    return this.turnActive || this.uiPending.size > 0;
  }

  /** 服务端派发 prompt 时标记本轮开始；收尾由 agent_settled 事件 / 进程退出清除 */
  noteTurnStart(): void {
    this.turnActive = true;
    this.lastActivityAt = Date.now();
  }

  /** 本轮事件流已交回服务端（收尾/异常/超时）：不再阻止空闲回收 */
  noteTurnEnd(): void {
    this.turnActive = false;
    this.uiPending.clear(); // 卡片要么已应答、要么由 pi 侧超时自行按拒绝 resolve
  }

  /** 距上次收到 pi 任何输出的毫秒数（状态轮询不算活动，只有真实输出才续命） */
  idleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  alive(): boolean {
    return !this.disposed && this.child.exitCode === null && !this.child.killed;
  }

  private onData(buf: Buffer): void {
    const { frames, rest } = splitFrames(buf, this.pending);
    this.pending = rest;
    if (frames.length > 0) this.lastActivityAt = Date.now();
    for (const frame of frames) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(frame) as Record<string, unknown>;
      } catch {
        continue; // 半截/非法记录：丢弃，保持流继续
      }
      if (o.type === "response") {
        const rid = typeof o.id === "string" ? o.id : "";
        const w = rid ? this.waiting.get(rid) : undefined;
        if (w && rid) {
          clearTimeout(w.timer);
          this.waiting.delete(rid);
          w.resolve(o as unknown as PiCommandResponse);
        }
        continue;
      }
      if (o.type === "extension_ui_request") {
        if (typeof o.id === "string") this.uiPending.add(o.id);
        this.uiCbs.forEach((cb) => cb(o as unknown as UiRequest));
        continue;
      }
      if (o.type === "extension_ui_response") continue; // 我方写回的响应不会重现
      if (o.type === "agent_settled") { this.turnActive = false; this.uiPending.clear(); } // 本轮收尾（pi 事件为扁平结构，type 即事件名），可以参与空闲回收
      const enriched = attachStartArgs(o, this.toolStartArgs);
      this.eventCbs.forEach((cb) => cb(enriched));
    }
  }

  /** 写命令并按 id 等待 response（response 本身不透传给事件回调） */
  command(type: string, payload: Record<string, unknown> = {}, timeoutMs = CMD_TIMEOUT_MS): Promise<PiCommandResponse> {
    if (!this.alive()) return Promise.reject(new Error("pi 进程不在运行"));
    const id = `cmd-${++this.cmdSeq}`;
    return new Promise<PiCommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`pi 命令 ${type} 超时（${Math.round(timeoutMs / 1000)}s）：${this.tail(3) || "无 stderr 输出"}`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n", (err) => {
        if (err) {
          const w = this.waiting.get(id);
          if (w) { clearTimeout(w.timer); this.waiting.delete(id); w.reject(err); }
        }
      });
    });
  }

  onEvent(cb: (o: Record<string, unknown>) => void): void {
    this.eventCbs.push(cb);
  }

  onUiRequest(cb: (req: UiRequest) => void): void {
    this.uiCbs.push(cb);
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  /** 把 extension_ui_request 的用户答复写回 pi stdin（confirm 用 confirmed，select/input/editor 用 value，超时/断开用 cancelled） */
  respondUi(id: string, body: { confirmed?: boolean; value?: string; cancelled?: boolean }): void {
    this.uiPending.delete(id);
    this.lastActivityAt = Date.now();
    if (!this.alive()) return;
    this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...body }) + "\n");
  }

  /** 有序退出：关 stdin 让 pi 自然收尾，3s 兜底 SIGTERM，再 2s SIGKILL */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error("会话已关闭"));
    }
    this.waiting.clear();
    try {
      this.child.stdin.end();
    } catch { /* 已关闭 */ }
    const term = setTimeout(() => {
      try { this.child.kill("SIGTERM"); } catch { /* 已退出 */ }
      const kill = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* 已退出 */ }
      }, 2000);
      kill.unref();
    }, 3000);
    term.unref();
  }
}

// —— 会话注册表：同一时刻最多 1 个深度会话（本地单模型串行），空闲 10 分钟自动回收 ——
export const DEEP_SYSTEM =
  "你运行在 CortxtOS 本地工作台的「深度模式」，工作目录就是知识库 vault，可以调用完整工具集实际做事。\n" +
  "规则：\n" +
  "1) 涉及用户笔记/知识库/历史沉淀的问题，先用 kb_search 检索再回答，并引用命中的文件路径；查不到就如实说明，不要编造。\n" +
  "2) 超过两步的任务，先调用 update_plan 建立计划，每完成一步更新状态后再继续。\n" +
  "3) bash 与 vault 外写入会弹出用户确认卡片，被拒绝时不要重试同一命令，改用只读手段或说明原因。\n" +
  "4) 可以调用 run_headless_task 把自包含的批量工作委派给无人值守子会话。\n" +
  "5) 用中文 Markdown 回答，先结论后展开；不要粘贴超长原始输出，做提炼。";

interface DeepSession {
  pi: PiSession;
  skillName: string; // 本会话加载的技能名（空串=不加载技能）；技能变更需重启会话
}

let current: DeepSession | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * 空闲回收判定（导出供单测）：以 pi 最近一次真实输出的空闲时长为准，而不是“上次派发 prompt 的时间”。
 * - 本轮进行中 / 有确认卡片待应答：不回收（多步任务单轮可远超 10 分钟，早期版本正是在长任务中途误杀了会话）；
 * - 静默超过 hardMs（默认 3 个周期）：视为卡死，无论状态一律回收，避免挂着本地大模型的子进程无人释放。
 */
export function shouldRecycle(idleMs: number, busy: boolean, softMs = IDLE_MS, hardMs = IDLE_MS * 3): boolean {
  if (idleMs > hardMs) return true;
  return !busy && idleMs > softMs;
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    if (current && shouldRecycle(current.pi.idleMs(), current.pi.busy())) stopCurrent();
  }, 60_000);
  sweeper.unref();
}

/** spawn 深度会话；技能与当前会话一致且存活则复用，否则按新技能重启（幂等） */
export function startDeepSession(config: CortxtosConfig, packageRoot: string, skillName?: string): PiSession {
  const skill = (skillName ?? "").trim().replace(/[^\w-]/g, "").slice(0, 64); // 仅允许字母数字/下划线/连字符（技能目录名集），防路径穿越
  if (current && current.pi.alive() && current.skillName === skill) return current.pi;
  if (current) current.pi.dispose();
  const extPaths = ["chat-guard", "planner", "kb-search", "spawn-agent"].map((n) => join(packageRoot, "extensions", `${n}.ts`));
  const skillDir = skill.length > 0 ? join(packageRoot, "skills", skill) : undefined;
  const pi = new PiSession(config, packageRoot, {
    skillDir: skillDir && existsSync(join(skillDir, "SKILL.md")) ? skillDir : undefined,
    extensions: extPaths.filter((p) => existsSync(p)),
    appendSystemPrompt: DEEP_SYSTEM,
  });
  current = { pi, skillName: skill };
  ensureSweeper();
  return pi;
}

/** 取会话：sessionId 为空表示“当前会话”（页面刷新后前端靠此恢复连接）；只读不续命 */
export function getDeepSession(sessionId: string): PiSession | null {
  if (!current || !current.pi.alive()) return null;
  if (sessionId && current.pi.sessionId !== sessionId) return null;
  return current.pi;
}

export function stopCurrent(): void {
  if (!current) return;
  current.pi.dispose();
  current = null;
}

/** 当前会话已加载的技能名（无会话/未选技能为空串）；前端据此判断选中的技能是否需重启会话 */
export function currentSkill(): string {
  return current?.skillName ?? "";
}

// CortxtOS 本地 Web 仪表盘（cortxtos serve）：零依赖 node:http，复用 searchHybrid / gatherChecks / vault 读取
// 只绑定 127.0.0.1：本机回环，数据不出机器；路径参数一律 resolve 后校验必须在 vault 内
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CortxtosConfig } from "./config.ts";
import { gatherChecks } from "./doctor.ts";
import { listMarkdown, parseFrontmatter, vaultDir, writeNote } from "./vault.ts";
import type { NoteSource, NoteType } from "./vault.ts";
import { searchHybrid, formatHits } from "./search.ts";
import { makeEmbedder } from "./embed.ts";
import { readIndexMeta, reindexAll, dirtyNoteCount } from "./vecstore.ts";
import { migrateVault } from "./migrate.ts";
import { inboxCommand } from "./launchd.ts";
import { pipelineModel } from "./tier.ts";
import {
  startDeepSession,
  getDeepSession,
  stopCurrent,
  currentSkill,
  translatePiEvent,
  type PiSession,
  type UiRequest,
} from "./agent-session.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML_PATH = join(PACKAGE_ROOT, "web", "index.html");

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
};

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

function text(res: import("node:http").ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/** vault 内安全解析：越界（.. 穿越、绝对路径）一律返回 null */
function withinVault(root: string, raw: string): string | null {
  if (!raw) return null;
  const p = resolve(root, raw.replace(/^\/+/, ""));
  return p === root || p.startsWith(root + sep) ? p : null;
}

/** 上传文件名消毒：只留 basename，去控制字符/路径符号，限长 */
export function sanitizeUploadName(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/"));
  const cleaned = base.replace(/[\u0000-\u001f\u007f/:*?"<>|]/g, "").replace(/^\.+/g, "").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "uploaded.bin";
}

const UPLOAD_ALLOWED = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".wav", ".m4a", ".mp3", ".ogg", ".flac", ".aac", ".aiff", ".webm"]);
const MAX_UPLOAD = 50 * 1048576;

async function readBody(req: import("node:http").IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("请求体超限（50MB）");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function jsonBody(res: import("node:http").ServerResponse, code: number, obj: Record<string, unknown>): void {
  json(res, code, obj);
}

/** 无人值守管道运行状态（serve 进程内存里，单实例串行，同 launchd 设计） */
interface PipelineState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  lines: string[]; // 输出尾部滑动窗口
}
const pipeline: PipelineState = { running: false, startedAt: null, finishedAt: null, exitCode: null, lines: [] };

/** 对话流式代理占用标记：本地 Ollama 单模型串行，与管道互斥排队 */
let chatRunning = false;

// —— JobPilot 求职工作台（方案 A：同机子服务 + iframe 内嵌）——
// 零依赖 node:http 本机服务（127.0.0.1:4318），数据同样不出机器；目录可用 CORTXTOS_JP_HOME 覆盖
const JP_HOME = process.env.CORTXTOS_JP_HOME ?? join(homedir(), "WorkBuddy/2026-11-06-19-14-22/jobpilot");
const JP_PORT = Number(process.env.CORTXTOS_JP_PORT ?? "4318");
const JP_URL = `http://127.0.0.1:${JP_PORT}`;
let jpChild: ReturnType<typeof spawn> | null = null;
let jpStartError = "";

async function jpAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${JP_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 按需拉起 jobpilot：已在运行则复用；目录缺失/启动失败返回原因（serve 启动与前端进入页面都会调用，幂等） */
async function ensureJobpilot(): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (await jpAlive()) return { ok: true, already: true };
  if (!existsSync(join(JP_HOME, "server.js"))) {
    jpStartError = `未找到 jobpilot 目录：${JP_HOME}（可设 CORTXTOS_JP_HOME 覆盖）`;
    return { ok: false, error: jpStartError };
  }
  jpStartError = "";
  jpChild = spawn(process.execPath, [join(JP_HOME, "server.js")], {
    env: { ...process.env, PORT: String(JP_PORT) },
    stdio: "ignore",
    detached: false,
  });
  jpChild.on("exit", () => { jpChild = null; });
  jpChild.on("error", (e) => { jpStartError = e.message; jpChild = null; });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await jpAlive()) return { ok: true };
  }
  jpStartError = "jobpilot 启动超时（5s）";
  return { ok: false, error: jpStartError };
}

function runPipeline(config: CortxtosConfig): { started: boolean; reason?: string } {
  if (pipeline.running) return { started: false, reason: "管道已在运行（单实例串行）" };
  const cmd = inboxCommand(config, PACKAGE_ROOT);
  const child = spawn("/bin/zsh", ["-lc", cmd], { env: { ...process.env, CORTXTOS_HEADLESS: "1" } });
  pipeline.running = true;
  pipeline.startedAt = new Date().toISOString();
  pipeline.finishedAt = null;
  pipeline.exitCode = null;
  pipeline.lines = [];
  const push = (buf: Buffer): void => {
    for (const l of buf.toString("utf8").split("\n")) {
      if (l.trim().length === 0) continue;
      pipeline.lines.push(l);
      if (pipeline.lines.length > 400) pipeline.lines.splice(0, pipeline.lines.length - 400);
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  const killer = setTimeout(() => { if (child.kill("SIGKILL")) push(Buffer.from("\n❌ 管道超时（>15min），已强制终止")); }, 15 * 60_000);
  child.on("close", (code) => {
    clearTimeout(killer);
    pipeline.running = false;
    pipeline.finishedAt = new Date().toISOString();
    pipeline.exitCode = code;
  });
  return { started: true };
}

interface NoteEntry {
  path: string; title: string; tags: string[]; created: string; type: string; source: string; mtime: string; size: number;
}

// —— 任务清单（todos.md 持久化在 vault 根，纯 Markdown checkbox 格式，本地优先、可被检索索引）——
const TODOS_FILE = "todos.md";
const TODO_RE = /^\s*-\s*\[([ xX])\]\s+(.*)$/;

interface TodoItem {
  text: string; done: boolean; prio: string; added: string;
}

function parseTodos(raw: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const line of raw.split("\n")) {
    const m = TODO_RE.exec(line);
    if (!m) continue;
    // 尾部元数据：（P1 · 添加 2026-11-06）或（添加 …）或（完成 …）
    let text = m[2]!.trim(), prio = "p2", added = "";
    const mm = text.match(/（(?:([^·）]+)\s*·\s*)?(完成|添加)\s*([0-9T:-]+)）\s*$/);
    if (mm) {
      if (mm[1]) prio = mm[1].trim().toLowerCase();
      added = mm[3]!;
      text = text.slice(0, mm.index).trim();
    }
    out.push({ text, done: m[1]!.toLowerCase() === "x", prio, added });
  }
  return out;
}

function renderTodos(items: TodoItem[]): string {
  return "# 任务清单\n\n" + items.map((t) => {
    const meta = [t.prio === "p1" ? "P1" : null, t.added ? `添加 ${t.added.slice(0, 10)}` : null].filter(Boolean).join(" · ");
    return `- [${t.done ? "x" : " "}] ${t.text}${meta ? `（${meta}）` : ""}`;
  }).join("\n") + "\n";
}

async function listNotes(root: string): Promise<NoteEntry[]> {
  const out: NoteEntry[] = [];
  for (const dir of ["notes", "daily"]) {
    for (const file of await listMarkdown(join(root, dir))) {
      const textBody = await readFile(file, "utf8");
      const fm = parseFrontmatter(textBody);
      const s = await stat(file);
      out.push({
        path: file.slice(root.length + 1),
        title: fm?.title ?? basename(file, ".md"),
        tags: fm?.tags ?? [],
        created: fm?.created ?? "",
        type: fm?.type ?? "note",
        source: fm?.source ?? "",
        mtime: s.mtime.toISOString(),
        size: s.size,
      });
    }
  }
  out.sort((a, b) => (b.created || b.mtime).localeCompare(a.created || a.mtime));
  return out;
}

async function listInbox(root: string): Promise<Array<{ name: string; size: number; mtime: string }>> {
  const dir = join(root, "inbox");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const s = await stat(join(dir, e.name));
    out.push({ name: e.name, size: s.size, mtime: s.mtime.toISOString() });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// —— 智能体（对话页 🤖 模式）：Ollama tool-calling 循环，白名单工具与同源 API 行为一致 ——
// 安全裁剪沿用无人值守策略：只开放检索/读写笔记/待办，不含 bash 等系统命令
const AGENT_MAX_TURNS = 5; // 单次提问最多模型往返轮数（含工具执行）
const TOOL_RESULT_MAX = 6000; // 工具结果回喂模型的截断上限，防单篇笔记撑爆 16k 上下文

const AGENT_SYSTEM =
  "你是 CortxtOS 本地工作台的智能体，可以调用本地工具实际做事：\n" +
  "- kb_search：混合检索知识库（关键字+语义），返回标题/路径/摘要\n" +
  "- read_note：按 vault 相对路径读取笔记全文\n" +
  "- list_notes：列出知识库全部笔记\n" +
  "- list_todos：读取待办清单\n" +
  "- save_note：把内容保存为新笔记\n" +
  "规则：凡涉及笔记/知识库/任务的问题，必须先调用工具取事实再回答，并引用来源路径；查不到就如实说明，不要编造；仅在用户明确要求保存/建笔记时才用 save_note。用中文 Markdown 回答，先结论后展开。";

/** Ollama /api/chat 的 tools 声明（OpenAI function 格式） */
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "kb_search",
      description: "混合检索（关键字+语义）本地知识库笔记，返回命中标题、相对路径与摘要片段",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词" },
          limit: { type: "integer", description: "最多返回条数，默认 5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "读取一篇笔记的 Markdown 全文（相对路径来自 kb_search 或 list_notes 的结果）",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "vault 相对路径，如 notes/xxx.md" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "列出知识库 notes/ 与 daily/ 下全部笔记（路径、标题、类型、日期）",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "读取工作台待办任务清单（todos.md），含完成状态与优先级",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_note",
      description: "把 Markdown 内容保存为知识库新笔记（仅在用户明确要求时使用）",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "笔记标题" },
          body: { type: "string", description: "Markdown 正文" },
          tags: { type: "string", description: "逗号分隔标签，如 ai,kb" },
        },
        required: ["title", "body"],
      },
    },
  },
];

/** 前端展示用的工具中文名 */
export const AGENT_TOOL_LABELS: Record<string, string> = {
  kb_search: "🔍 检索知识库",
  read_note: "📖 读取笔记",
  list_notes: "🗂️ 列出笔记",
  list_todos: "☑️ 读取待办清单",
  save_note: "✍️ 写入笔记",
};

/** 工具执行器（导出供单测）：参数一律视为模型输出的不可信输入，路径过 withinVault 窄门 */
export async function execAgentTool(config: CortxtosConfig, name: string, args: Record<string, unknown>): Promise<string> {
  const root = vaultDir(config);
  switch (name) {
    case "kb_search": {
      const query = String(args.query ?? "").trim().slice(0, 200);
      if (!query) return "kb_search 需要非空 query";
      const limit = Math.max(1, Math.min(Number(args.limit) || 5, 10));
      const r = await searchHybrid(config, { query, limit }, makeEmbedder(config));
      const body = formatHits(r.hits);
      return r.note ? `${r.note}\n\n${body}` : body;
    }
    case "read_note": {
      const p = withinVault(root, String(args.path ?? ""));
      if (p === null || !p.endsWith(".md")) return `路径非法：只支持 vault 内的 .md 文件（收到 ${String(args.path ?? "").slice(0, 100)}）`;
      if (!existsSync(p)) return `笔记不存在：${String(args.path ?? "").slice(0, 100)}`;
      const body = await readFile(p, "utf8");
      return body.slice(0, 12000);
    }
    case "list_notes": {
      const notes = await listNotes(root);
      if (notes.length === 0) return "知识库为空（notes/ 与 daily/ 下暂无笔记）";
      return notes.slice(0, 50).map((n) => `${n.path} | ${n.title} | ${n.type} | ${(n.created || n.mtime).slice(0, 10)}`).join("\n");
    }
    case "list_todos": {
      const file = join(root, TODOS_FILE);
      const raw = existsSync(file) ? await readFile(file, "utf8") : "";
      const items = parseTodos(raw);
      if (items.length === 0) return "待办清单为空";
      return items.map((t) => `- [${t.done ? "x" : " "}] ${t.text}${t.prio === "p1" ? "（P1）" : ""}`).join("\n");
    }
    case "save_note": {
      const title = String(args.title ?? "").trim().slice(0, 120);
      const body = String(args.body ?? "").trim().slice(0, 20000);
      if (!title) return "save_note 需要非空 title";
      const tags = String(args.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8);
      const path = await writeNote(config, {
        dir: "notes",
        frontmatter: { title, tags, created: new Date().toISOString(), source: "manual" as NoteSource, type: "note" as NoteType },
        body: body || "（无正文）",
      });
      return `已保存笔记：${path.slice(root.length + 1)}（重建索引后可被语义检索）`;
    }
    default:
      return `未知工具：${name}（允许：kb_search/read_note/list_notes/list_todos/save_note）`;
  }
}

/** 智能体主循环：流式透传 content，解析 tool_calls 执行后回喂，直至模型不再调工具 */
async function runAgentChat(
  config: CortxtosConfig,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  message: string,
  history: Array<{ role: string; content: string }>,
): Promise<void> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: AGENT_SYSTEM },
    ...history,
    { role: "user", content: message },
  ];
  chatRunning = true;
  let headSent = false;
  const ensureHead = (): void => {
    if (!headSent) { headSent = true; res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" }); }
  };
  const emit = (o: Record<string, unknown>): void => { ensureHead(); res.write(JSON.stringify(o) + "\n"); };
  let closed = false;
  req.on("close", () => { closed = true; });
  try {
    for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
      const upstream = AbortSignal.timeout(120_000);
      let resp: Response;
      try {
        resp = await fetch(`${config.ollama.baseUrl}/api/chat`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: pipelineModel(config), stream: true, think: false, tools: AGENT_TOOLS, messages, options: { num_ctx: 16384 } }),
          signal: upstream,
        });
      } catch (e) {
        const err = `连不上本地 Ollama（${config.ollama.baseUrl}）：${e instanceof Error ? e.message : String(e)}`;
        if (!headSent) json(res, 502, { error: err }); else emit({ error: err });
        return;
      }
      if (!resp.ok || !resp.body) {
        const detail = await resp.text().catch(() => "");
        const err = `Ollama /api/chat HTTP ${resp.status}：${detail.slice(0, 200) || "无响应体"}`;
        if (!headSent) json(res, 502, { error: err }); else emit({ error: err });
        return;
      }
      ensureHead();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let contentAcc = "";
      const calls: Array<{ function: { name: string; arguments: string } }> = [];
      const onAbort = (): void => { reader.cancel().catch(() => {}); };
      req.on("aborted", onAbort); upstream.addEventListener("abort", onAbort);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line) as {
                message?: { content?: string; tool_calls?: Array<{ index?: number; function?: { index?: number; name?: string; arguments?: unknown } }> };
              };
              const piece = o.message?.content ?? "";
              if (piece) { contentAcc += piece; emit({ content: piece }); }
              // tool_calls 归并：Ollama ≥0.40 带 function.index，对象参数每块整段重发 → 按 index 覆盖式归并；
              // 无 index 的旧格式：带 name 视为新调用，增量 arguments 拼到当前调用
              for (const tc of o.message?.tool_calls ?? []) {
                const name = typeof tc.function?.name === "string" ? tc.function.name : "";
                const raw = typeof tc.function?.arguments === "string"
                  ? tc.function.arguments
                  : tc.function?.arguments !== undefined ? JSON.stringify(tc.function.arguments) : "";
                const idx = typeof tc.function?.index === "number" ? tc.function.index : typeof tc.index === "number" ? tc.index : undefined;
                if (idx !== undefined) {
                  while (calls.length <= idx) calls.push({ function: { name: "", arguments: "" } });
                  const c = calls[idx]!;
                  if (name) c.function.name = name;
                  if (raw) {
                    // 对象参数整段到达（{…}）→ 覆盖；字符串增量 → 拼接
                    if (raw.startsWith("{")) c.function.arguments = raw;
                    else c.function.arguments += raw;
                  }
                } else if (name) calls.push({ function: { name, arguments: raw } });
                else if (calls.length > 0 && raw) calls[calls.length - 1]!.function.arguments += raw;
              }
            } catch { /* 忽略半截行 */ }
          }
        }
      } finally {
        req.removeListener("aborted", onAbort);
        upstream.removeEventListener("abort", onAbort);
      }
      const realCalls = calls.filter((c) => c.function.name);
      if (realCalls.length === 0) { emit({ done: true }); return; }
      if (closed || res.writableEnded) return;
      // 参数先解析：回喂 Ollama 的 assistant.tool_calls.arguments 必须是 JSON 对象（非字符串），执行也用解析后的值
      const prepared = realCalls.map((c) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch { /* 参数非法 JSON → 空参数，工具自报缺参 */ }
        return { name: c.function.name, args };
      });
      messages.push({
        role: "assistant",
        content: contentAcc,
        tool_calls: prepared.map((p) => ({ function: { name: p.name, arguments: p.args } })),
      });
      for (const p of prepared) {
        emit({ tool: p.name, args: p.args });
        let result: string;
        try {
          result = await execAgentTool(config, p.name, p.args);
        } catch (e) {
          result = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
        }
        emit({ tool_result: p.name, preview: result.slice(0, 200) });
        messages.push({ role: "tool", tool_name: p.name, content: result.slice(0, TOOL_RESULT_MAX) });
        if (closed || res.writableEnded) return;
      }
    }
    emit({ error: `已达单次提问最大工具轮数（${AGENT_MAX_TURNS}），请换个更具体的问题重试` });
    emit({ done: true });
  } finally {
    chatRunning = false;
    if (headSent) res.end();
  }
}

/** 深度会话占用检查：只有真正在跑一轮时才与快速模式/管道互斥（本地单模型串行） */
function deepBusyTurn(): boolean {
  return deepTurn;
}

// —— 深度模式（二期 RPC 嵌入）：一个 pi --mode rpc 长驻子进程当智能体运行时，事件翻译后 NDJSON 推给浏览器 ——
let deepSink: ((ev: Record<string, unknown>) => void) | null = null; // 当前事件出口（最近一次 prompt 的 res）
let deepSettled: (() => void) | null = null; // 本轮 agent_settled 的唤醒钩子
let deepWired: PiSession | null = null;
let deepTurn = false;

/** 事件/确认请求只接线一次（start 幂等复用同一会话） */
function wireDeep(pi: PiSession): void {
  if (deepWired === pi) return;
  deepWired = pi;
  pi.onEvent((o) => {
    const ev = translatePiEvent(o);
    if (ev) deepSink?.(ev);
    if (o.type === "agent_settled") deepSettled?.();
  });
  pi.onUiRequest((req: UiRequest) => {
    if (req.method === "confirm" || req.method === "select" || req.method === "input" || req.method === "editor") {
      deepSink?.({ ui_request: req });
    } else if (req.method === "notify") {
      deepSink?.({ system: String(req.message ?? "") });
    } else if (req.method === "setStatus" && req.statusText) {
      deepSink?.({ system: String(req.statusText) });
    }
  });
  pi.onExit(() => {
    deepSink?.({ error: "深度会话进程已退出（模型不可用或崩溃），重新点击「深度」即可重开" });
    deepSettled?.();
    deepWired = null;
    stopCurrent();
  });
}

/** 占用检查：快速对话、无人值守管道、深度轮次三者共用一把本地模型锁 */
function modelBusy(): string | null {
  if (chatRunning) return "快速对话进行中";
  if (pipeline.running) return "无人值守管道进行中";
  if (deepTurn) return "深度会话上一轮还在进行中";
  return null;
}

export async function startServer(config: CortxtosConfig, port = 8787): Promise<void> {
  const root = vaultDir(config);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = url.pathname;

      if (route === "/") {
        text(res, 200, await readFile(INDEX_HTML_PATH, "utf8"), "text/html; charset=utf-8");
        return;
      }
      if (route === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (route === "/api/jp" && req.method === "POST") {
        const r = await ensureJobpilot();
        jsonBody(res, 200, { ...r, url: JP_URL });
        return;
      }
      if (route === "/api/jp") {
        const alive = await jpAlive();
        json(res, 200, { enabled: existsSync(join(JP_HOME, "server.js")), running: alive, url: JP_URL, path: JP_HOME, error: alive ? "" : jpStartError });
        return;
      }
      if (route === "/api/status") {
        const checks = await gatherChecks(config);
        const meta = readIndexMeta();
        json(res, 200, { checks, index: meta, dirty: dirtyNoteCount(), vault: root });
        return;
      }
      if (route === "/api/notes") {
        json(res, 200, await listNotes(root));
        return;
      }
      if (route === "/api/inbox") {
        json(res, 200, await listInbox(root));
        return;
      }
      if (route === "/api/note") {
        const p = withinVault(root, url.searchParams.get("path") ?? "");
        if (p === null || !p.endsWith(".md")) { json(res, 400, { error: "非法路径" }); return; }
        const body = await readFile(p, "utf8");
        json(res, 200, { path: p.slice(root.length + 1), content: body, frontmatter: parseFrontmatter(body) });
        return;
      }
      if (route === "/raw") {
        // inbox 原始文件预览（PDF/图片/音频直接交给浏览器渲染）
        const p = withinVault(root, url.searchParams.get("path") ?? "");
        if (p === null || !existsSync(p)) { text(res, 404, "not found"); return; }
        const body = await readFile(p);
        res.writeHead(200, { "content-type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream" });
        res.end(body);
        return;
      }
      if (route === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) { json(res, 400, { error: "q 不能为空" }); return; }
        const started = Date.now();
        const r = await searchHybrid(config, { query: q, limit: Number(url.searchParams.get("limit") ?? 8) }, makeEmbedder(config));
        json(res, 200, { ...r, ms: Date.now() - started });
        return;
      }
      if (route === "/api/note" && req.method === "POST") {
        const b = JSON.parse((await readBody(req, 1048576)).toString("utf8")) as { title?: string; tags?: string; body?: string; dir?: string; type?: string; source?: string };
        const title = (b.title ?? "").trim();
        if (!title) { jsonBody(res, 400, { error: "title 不能为空" }); return; }
        const path = await writeNote(config, {
          dir: b.dir === "daily" ? "daily" : "notes",
          frontmatter: {
            title,
            tags: (b.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
            created: new Date().toISOString(),
            source: (b.source || "manual") as NoteSource,
            type: (b.type || "note") as NoteType,
          },
          body: (b.body ?? "").trim() || "（待补充正文）",
        });
        jsonBody(res, 200, { ok: true, path: path.slice(root.length + 1) });
        return;
      }
      if (route === "/api/upload" && req.method === "POST") {
        const name = sanitizeUploadName(url.searchParams.get("name") ?? "");
        const ext = extname(name).toLowerCase();
        if (!UPLOAD_ALLOWED.has(ext)) { jsonBody(res, 400, { error: `不允许的文件类型 ${ext || "(无后缀)"}，支持 PDF/图片/音频` }); return; }
        const buf = await readBody(req, MAX_UPLOAD);
        if (buf.length === 0) { jsonBody(res, 400, { error: "空文件" }); return; }
        const dir = join(root, "inbox");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), buf); // 同名直接覆盖（重传场景）
        jsonBody(res, 200, { ok: true, name, size: buf.length });
        return;
      }
      if (route === "/api/pipeline") {
        if (req.method === "POST") {
          if (deepTurn) { jsonBody(res, 409, { ok: false, running: true, reason: "深度会话进行中（本地单模型串行）" }); return; }
          const r = runPipeline(config);
          jsonBody(res, r.started ? 202 : 409, { ok: r.started, running: true, reason: r.reason });
          return;
        }
        json(res, 200, pipeline);
        return;
      }
      if (route === "/api/logs") {
        const which = url.searchParams.get("name") ?? "inbox";
        if (!["inbox", "reindex"].includes(which)) { json(res, 400, { error: "未知日志" }); return; }
        const tail = Number(url.searchParams.get("tail") ?? 60);
        const read = async (p: string): Promise<string> => {
          if (!existsSync(p)) return "";
          const t = await readFile(p, "utf8");
          return t.split("\n").slice(-tail).join("\n");
        };
        jsonBody(res, 200, {
          out: await read(join(root, "workflows", `launchd-${which}.log`)),
          err: await read(join(root, "workflows", `launchd-${which}.err.log`)),
        });
        return;
      }
      if (route === "/api/migrate" && req.method === "POST") {
        const b = JSON.parse((await readBody(req, 65536)).toString("utf8")) as { dryRun?: boolean };
        const r = await migrateVault(config, b.dryRun !== false);
        jsonBody(res, 200, { ok: true, scanned: r.scanned, migrated: r.migrated, skipped: r.skipped.length, dryRun: b.dryRun !== false });
        return;
      }
      if (route === "/api/reindex" && req.method === "POST") {
        const started = Date.now();
        try {
          const s = await reindexAll(config, makeEmbedder(config));
          json(res, 200, { ok: true, ...s, ms: Date.now() - started });
        } catch (e) {
          json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      // —— 深度模式：代理 pi RPC 会话（长驻子进程，能力 = 命令执行/文件读写/规划/技能/压缩/MCP）——
      if (route === "/api/agent/start" && req.method === "POST") {
        if (chatRunning || pipeline.running) { json(res, 409, { error: `本地模型忙：${modelBusy() ?? "进行中"}，请等它结束再开启深度模式` }); return; }
        let skill = "";
        try { skill = String((JSON.parse((await readBody(req, 65536)).toString("utf8")).skill ?? "").slice(0, 64)); } catch { /* 无请求体 */ }
        try {
          const pi = startDeepSession(config, PACKAGE_ROOT, skill);
          wireDeep(pi);
          // 回显生效的技能名（注册表里已做字符集清洗，非法字符会被丢弃），而不是原始入参
          json(res, 200, { ok: true, sessionId: pi.sessionId, skill: currentSkill(), model: pipelineModel(config) });
        } catch (e) {
          json(res, 500, { error: `深度会话启动失败：${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }
      if (route === "/api/agent") {
        const pi = getDeepSession("");
        json(res, 200, { active: pi !== null, sessionId: pi?.sessionId ?? "", skill: currentSkill(), running: deepTurn, model: pipelineModel(config) });
        return;
      }
      if (route === "/api/agent/prompt" && req.method === "POST") {
        const b = JSON.parse((await readBody(req, 1048576)).toString("utf8")) as { sessionId?: string; message?: string };
        const message = (b.message ?? "").trim().slice(0, 8000);
        const pi = getDeepSession(b.sessionId ?? "");
        if (!pi) { json(res, 404, { error: "深度会话不存在或已被回收（空闲 10 分钟），请重新点击「深度」开启" }); return; }
        if (!message) { json(res, 400, { error: "message 不能为空" }); return; }
        const busy = modelBusy();
        if (busy) { json(res, 409, { error: busy }); return; }
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        const send = (o: Record<string, unknown>): void => {
          if (!res.writableEnded) res.write(JSON.stringify(o) + "\n");
        };
        deepTurn = true;
        deepSink = send;
        // 浏览器断连（res close）只摘出口，不杀 pi 进程（深度会话要能续话）
        // 注：不能用 req.on("close")——Node 把请求体读完就会 emit 该事件，会过早取消出口
        res.on("close", () => { if (deepSink === send) deepSink = null; });
        let settle: (() => void) | null = null;
        const settled = new Promise<void>((r) => { settle = r; });
        deepSettled = () => { settle?.(); };
        const watchdog = setTimeout(() => { send({ error: "本轮深度任务超过 20 分钟，已断开事件流（pi 仍在后台运行，可刷新后继续追问）" }); settle?.(); }, 20 * 60_000);
        try {
          const r = await pi.command("prompt", { message }, 60_000);
          if (!r.success) {
            send({ error: `提示词未被接受：${r.error ?? "未知原因"}` });
            send({ done: true });
            return;
          }
          const disposition = String((r.data as Record<string, unknown> | undefined)?.disposition ?? "");
          if (disposition === "handled") { send({ done: true }); return; } // 扩展命令吃掉本轮，不会启动 agent 循环
          pi.noteTurnStart(); // 本轮已开跑：多步任务单轮可远超 10 分钟，空闲回收不得在此期间杀进程
          await settled;
        } catch (e) {
          send({ error: e instanceof Error ? e.message : String(e) });
          send({ done: true });
        } finally {
          clearTimeout(watchdog);
          pi.noteTurnEnd(); // 事件流已交回，不再阻止后续的空闲回收
          if (deepSink === send) deepSink = null;
          deepSettled = null;
          deepTurn = false;
          if (!res.writableEnded) res.end();
        }
        return;
      }
      if (route === "/api/agent/ui-response" && req.method === "POST") {
        const b = JSON.parse((await readBody(req, 65536)).toString("utf8")) as { sessionId?: string; id?: string; confirmed?: boolean; value?: string; cancelled?: boolean };
        const pi = getDeepSession(b.sessionId ?? "");
        if (!pi) { json(res, 404, { error: "深度会话不存在或已回收" }); return; }
        if (!b.id) { json(res, 400, { error: "id 不能为空" }); return; }
        pi.respondUi(b.id, { confirmed: b.confirmed, value: b.value, cancelled: b.cancelled });
        json(res, 200, { ok: true });
        return;
      }
      if (route === "/api/agent/stop" && req.method === "POST") {
        stopCurrent();
        deepWired = null;
        json(res, 200, { ok: true });
        return;
      }
      if (route === "/api/skills") {
        const dir = join(PACKAGE_ROOT, "skills");
        const out: Array<{ name: string; description: string }> = [];
        if (existsSync(dir)) {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const f = join(dir, e.name, "SKILL.md");
            if (!existsSync(f)) continue;
            const raw = await readFile(f, "utf8");
            const m = /^description:\s*(.+)$/m.exec(raw);
            out.push({ name: e.name, description: (m?.[1] ?? raw.split("\n").slice(1, 2).join("")).trim().slice(0, 200) });
          }
        }
        json(res, 200, out);
        return;
      }
      // —— AI 对话：流式代理本地 Ollama /api/chat，NDJSON 透传，数据不出机器；agent 模式额外跑 tool-calling 循环 ——
      if (route === "/api/chat" && req.method === "POST") {
        if (deepBusyTurn()) { json(res, 409, { error: "深度模式本轮进行中（本地单模型串行），请等它结束或用快速模式" }); return; }
        if (chatRunning) { json(res, 409, { error: "已有对话在进行中（本地单模型串行，与管道/检索互斥排队）" }); return; }
        const b = JSON.parse((await readBody(req, 1048576)).toString("utf8")) as { message?: string; history?: Array<{ role: string; content: string }>; agent?: boolean };
        const message = (b.message ?? "").trim().slice(0, 8000);
        if (!message) { json(res, 400, { error: "message 不能为空" }); return; }
        const history = (Array.isArray(b.history) ? b.history : [])
          .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
        if (b.agent === true) { await runAgentChat(config, req, res, message, history); return; }
        const system = "你是 CortxtOS 本地工作台的 AI 助手。用中文、Markdown 格式简洁回答；优先给出结论再展开；不确定的内容明说，不要编造。若用户询问本地知识库/笔记内容，而你无法直接读取，请告知用户在「AI 对话」页右上方开启 🤖智能体 模式，开启后助手可自主检索知识库与待办。";
        const upstream = AbortSignal.timeout(180_000);
        let resp: Response;
        try {
          resp = await fetch(`${config.ollama.baseUrl}/api/chat`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: pipelineModel(config), stream: true, think: false, messages: [{ role: "system", content: system }, ...history, { role: "user", content: message }], options: { num_ctx: 16384 } }),
            signal: upstream,
          });
        } catch (e) {
          json(res, 502, { error: `连不上本地 Ollama（${config.ollama.baseUrl}）：${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        if (!resp.ok || !resp.body) {
          const detail = await resp.text().catch(() => "");
          json(res, 502, { error: `Ollama /api/chat HTTP ${resp.status}：${detail.slice(0, 200) || "无响应体"}` });
          return;
        }
        chatRunning = true;
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        const onAbort = (): void => { reader.cancel().catch(() => {}); };
        req.on("aborted", onAbort); upstream.addEventListener("abort", onAbort);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const o = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
                const piece = o.message?.content ?? "";
                if (piece) res.write(JSON.stringify({ content: piece }) + "\n");
              } catch { /* 忽略半截行 */ }
            }
          }
        } finally {
          req.removeListener("aborted", onAbort);
          chatRunning = false;
          res.end();
        }
        return;
      }
      // —— 任务清单：GET 读 / POST 整表替换 / DELETE 删除 ——
      if (route === "/api/todos") {
        const file = join(root, TODOS_FILE);
        if (req.method === "GET") {
          const raw = existsSync(file) ? await readFile(file, "utf8") : "";
          json(res, 200, parseTodos(raw));
          return;
        }
        if (req.method === "POST") {
          const b = JSON.parse((await readBody(req, 65536)).toString("utf8")) as { text?: string; done?: boolean; prio?: string };
          const text = (b.text ?? "").trim().slice(0, 500);
          if (!text) { json(res, 400, { error: "text 不能为空" }); return; }
          const raw = existsSync(file) ? await readFile(file, "utf8") : "";
          const items = parseTodos(raw);
          items.push({ text, done: !!b.done, prio: b.prio === "p1" ? "p1" : "p2", added: new Date().toISOString().slice(0, 10) });
          await mkdir(root, { recursive: true });
          await writeFile(file, renderTodos(items), "utf8");
          json(res, 200, { ok: true, count: items.length });
          return;
        }
        if (req.method === "DELETE") {
          const idx = Number(url.searchParams.get("i") ?? -1);
          const raw = existsSync(file) ? await readFile(file, "utf8") : "";
          const items = parseTodos(raw);
          if (idx < 0 || idx >= items.length) { json(res, 400, { error: "序号越界" }); return; }
          items.splice(idx, 1);
          await writeFile(file, renderTodos(items), "utf8");
          json(res, 200, { ok: true, count: items.length });
          return;
        }
        if (req.method === "PUT") {
          const b = JSON.parse((await readBody(req, 65536)).toString("utf8")) as { items?: Array<{ text?: string; done?: boolean; prio?: string; added?: string }> };
          const items = (b.items ?? []).map((t) => ({ text: (t.text ?? "").trim().slice(0, 500), done: !!t.done, prio: t.prio === "p1" ? "p1" : "p2", added: t.added ?? "" })).filter((t) => t.text);
          await mkdir(root, { recursive: true });
          await writeFile(file, renderTodos(items), "utf8");
          json(res, 200, { ok: true, count: items.length });
          return;
        }
        json(res, 405, { error: "方法不允许" });
        return;
      }
      text(res, 404, "not found");
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`🌐 CortxtOS 仪表盘已启动：http://127.0.0.1:${port}  （Ctrl-C 停止；仅本机可访问）`);
    // 求职工作台子服务随后拉起（失败不影响主服务，进入页面时会按需重试）
    void ensureJobpilot().then((r) => {
      console.log(r.ok ? `💼 JobPilot 求职工作台已就绪：${JP_URL}` : `⚠️ JobPilot 未启动：${r.error ?? "未知原因"}`);
    });
  });
  const shutdown = (): void => {
    stopCurrent();
    if (jpChild) { try { jpChild.kill("SIGTERM"); } catch { /* 已退出 */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

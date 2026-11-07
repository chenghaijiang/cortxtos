// cortxtos doctor：环境自检（票 01 验收项；票 09 纳入 embedding 模型与索引状态）
// 检查 Node/Pi/Ollama/模型/内存选档/whisper/vault/launchd，输出 ✅⚠️❌
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findWhisperModel } from "./asr.ts";
import { CONFIG_PATH, indexPath, loadConfig, vaultRoot } from "./config.ts";
import type { CortxtosConfig } from "./config.ts";

export interface CheckResult {
  level: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

const MARK = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;

function compareVersion(min: string, current: string): number {
  const a = min.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function checkNode(): CheckResult {
  const v = process.versions.node;
  const ok = compareVersion("22.19.0", v) >= 0;
  return {
    level: ok ? "ok" : "fail",
    label: `Node.js >= 22.19`,
    detail: ok ? `v${v}` : `v${v} 过低，请 nvm install 22`,
  };
}

function checkPi(): CheckResult {
  const r = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (r.error != null || r.status !== 0) {
    return { level: "fail", label: "Pi CLI", detail: "未安装或不可执行：curl -fsSL https://pi.dev/install.sh | sh" };
  }
  return { level: "ok", label: "Pi CLI", detail: (r.stdout ?? "").trim() };
}

async function checkOllama(baseUrl: string): Promise<{ tags: string[]; result: CheckResult }> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      return { tags: [], result: { level: "fail", label: "Ollama API", detail: `HTTP ${resp.status}` } };
    }
    const payload = (await resp.json()) as { models?: Array<{ name?: string }> };
    const tags = (payload.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    return { tags, result: { level: "ok", label: "Ollama API", detail: `${baseUrl} 可达，${tags.length} 个模型` } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { tags: [], result: { level: "fail", label: "Ollama API", detail: `${baseUrl} 不可达（${msg}），请启动 Ollama` } };
  }
}

function checkModel(tags: string[]): CheckResult {
  const exact = tags.some((t) => t === "qwen3.8:27b");
  const variant = tags.some((t) => t.startsWith("qwen3.8"));
  if (exact) return { level: "ok", label: "主模型 qwen3.8:27b", detail: "已拉取" };
  if (variant) return { level: "warn", label: "主模型 qwen3.8:27b", detail: "存在 qwen3.8 变体但非默认 tag，请核对 cortxtos.json 档位表" };
  return { level: "fail", label: "主模型 qwen3.8:27b", detail: "缺失：ollama pull qwen3.8:27b" };
}

function checkEmbeddingModel(tags: string[], model: string): CheckResult {
  if (tags.includes(model)) return { level: "ok", label: `embedding ${model}`, detail: "已拉取（语义检索可用）" };
  return { level: "warn", label: `embedding ${model}`, detail: `未拉取：kb_search 自动退回关键字检索；ollama pull ${model} 后跑 cortxtos reindex 启用语义` };
}

// 索引状态懒加载 vecstore（node:sqlite）：旧 Node 环境下 import 失败也不拖垮 doctor 其余检查
async function checkIndex(): Promise<CheckResult> {
  try {
    const { dirtyNoteCount, readIndexMeta } = await import("./vecstore.ts");
    const meta = readIndexMeta();
    if (meta === null) {
      return { level: "warn", label: "向量索引", detail: `未建立（${indexPath()} 不存在）：cortxtos reindex 或等夜间重建；当前检索走文件版关键字` };
    }
    const dirty = dirtyNoteCount();
    return {
      level: "ok",
      label: "向量索引",
      detail: `上次重建 ${meta.builtAt}，${meta.fileCount} 篇 / ${meta.chunkCount} 块（dim ${meta.dim}）${dirty > 0 ? `；重建后又有 ${dirty} 篇写入，下次重建摄取` : ""}`,
    };
  } catch (e) {
    return { level: "warn", label: "向量索引", detail: `无法读取：${e instanceof Error ? e.message : String(e)}` };
  }
}

function checkMemory(): CheckResult {
  const r = spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" });
  const bytes = Number.parseInt((r.stdout ?? "").trim(), 10);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { level: "warn", label: "统一内存", detail: "无法读取 hw.memsize" };
  }
  const gb = Math.round(bytes / 1024 / 1024 / 1024);
  if (gb >= 36) {
    return { level: "ok", label: `统一内存 ${gb}GB`, detail: "命中 ≥36GB 档：建议 ollama pull qwen3.8:27b-mlx（Apple Silicon 更快）" };
  }
  if (gb >= 24) {
    return { level: "ok", label: `统一内存 ${gb}GB`, detail: "命中 24~35GB 档：建议 qwen3.8:27b-iq4_xs；注意 TUI 与 watcher 排队（MAX_LOADED_MODELS=1）" };
  }
  return { level: "warn", label: `统一内存 ${gb}GB`, detail: "<24GB：27B 模型紧张，考虑 14B/9B 级并在 cortxtos.json 覆盖档位表" };
}

function checkOnPath(binary: string, label: string, hint: string, missingLevel: "warn" | "fail"): CheckResult {
  const r = spawnSync("which", [binary], { encoding: "utf8" });
  const found = r.status === 0 && (r.stdout ?? "").trim().length > 0;
  return { level: found ? "ok" : missingLevel, label, detail: found ? (r.stdout ?? "").trim() : `未找到，${hint}` };
}

function checkWhisperModel(asrModel: string): CheckResult {
  const found = findWhisperModel(asrModel);
  if (found === null) {
    return { level: "warn", label: "whisper 模型文件", detail: `未就位，音频管道优雅跳过；从 huggingface.co/ggerganov/whisper.cpp 下载 ggml-${asrModel}-q5_0.bin 放入 ~/.cortxtos/models/` };
  }
  return { level: "ok", label: "whisper 模型文件", detail: found };
}

function checkVault(vault: string): CheckResult {
  if (!existsSync(vault)) {
    return { level: "warn", label: "vault 目录", detail: `${vault} 不存在，等票 02 的 cortxtos init 创建` };
  }
  const missing = ["inbox", "notes", "daily", "workflows"].filter((d) => !existsSync(join(vault, d)));
  if (missing.length > 0) {
    return { level: "warn", label: "vault 目录", detail: `缺少分区：${missing.join(", ")}` };
  }
  return { level: "ok", label: "vault 目录", detail: vault };
}

function checkLaunchd(): CheckResult {
  const r = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.includes("com.cortxtos"));
  if (lines.length === 0) {
    return { level: "warn", label: "launchd 任务", detail: "com.cortxtos.* 未挂载（票 02/05 交付挂载）" };
  }
  return { level: "ok", label: "launchd 任务", detail: `${lines.length} 个已挂载` };
}

/** 汇总全部检查项（runDoctor 打印与 Web /api/status 共用同一数据源） */
export async function gatherChecks(config: CortxtosConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(checkNode());
  results.push(checkPi());
  const { tags, result: ollamaResult } = await checkOllama(config.ollama.baseUrl);
  results.push(ollamaResult);
  if (ollamaResult.level === "ok") {
    results.push(checkModel(tags));
    results.push(checkEmbeddingModel(tags, config.tiers.embedding.model));
  }
  results.push(checkMemory());
  results.push(checkOnPath("pdftotext", "poppler pdftotext（PDF 管道依赖）", "brew install poppler（票 05 需要）", "warn"));
  results.push(checkOnPath("whisper-cli", "whisper.cpp（音频管道依赖）", "brew install whisper-cpp（票 08 前可用）", "warn"));
  results.push(checkWhisperModel(config.asr.model));
  results.push(checkVault(vaultRoot(config)));
  results.push(await checkIndex());
  results.push(checkLaunchd());
  return results;
}

export async function runDoctor(): Promise<number> {
  const { config, created } = loadConfig();
  if (created) {
    console.log(`ℹ️  首次运行：已生成默认配置 ${CONFIG_PATH}`);
  }
  const results = await gatherChecks(config);

  console.log("\ncortxtos doctor —— 工作台环境自检\n");
  for (const r of results) {
    console.log(`${MARK[r.level]} ${r.label.padEnd(28, " ")} ${r.detail}`);
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\n${fails === 0 && warns === 0 ? "🟢 全绿" : "体检完成"}：${results.length} 项检查，${fails} 失败，${warns} 警告`);
  return fails;
}

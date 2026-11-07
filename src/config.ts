// cortxtos 配置模块：加载/生成 cortxtos.json（DESIGN.md §5.1 档位表）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TierName = "fast" | "balanced" | "heavy" | "vision" | "embedding";

export interface Tier {
  model: string;
  fallback?: TierName[];
}

export interface CortxtosConfig {
  vaultPath: string;
  ollama: {
    baseUrl: string;
    maxLoadedModels: number;
  };
  tiers: Record<TierName, Tier>;
  asr: {
    engine: string;
    model: string;
  };
}

/** 配置目录：CORTXTOS_CONFIG 环境变量可指向任意路径覆盖 */
export const CONFIG_DIR = join(homedir(), ".cortxtos");
export const CONFIG_PATH = process.env.CORTXTOS_CONFIG ?? join(CONFIG_DIR, "cortxtos.json");

// 向量索引缓存（票 09）：放 vault 外，可整体删除重建，无数据主权损失
export const INDEX_DIR = join(CONFIG_DIR, "index");
/** 索引库路径：每次调用时读 env（测试可指向临时库） */
export function indexPath(): string {
  return process.env.CORTXTOS_INDEX_DB ?? join(INDEX_DIR, "vault.db");
}
/** 脏标记清单：跟着索引库走（同一目录），记录重建后新写入的笔记 */
export function dirtyIndexPath(): string {
  return indexPath() + ".dirty";
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultConfig(): CortxtosConfig {
  // fast 档当前沿用 27B（与 balanced 同模型）；qwen3.8 家族小杯 tag 在票 05 定档后替换
  const mainModel = "qwen3.8:27b";
  return {
    vaultPath: "~/cortxt-vault",
    ollama: { baseUrl: "http://localhost:11434", maxLoadedModels: 1 },
    tiers: {
      fast: { model: mainModel, fallback: ["balanced"] },
      balanced: { model: mainModel, fallback: ["heavy"] },
      heavy: { model: mainModel, fallback: [] },
      vision: { model: mainModel, fallback: ["balanced"] },
      embedding: { model: "qwen3-embedding:0.6b" },
    },
    asr: { engine: "whisper.cpp", model: "large-v3" },
  };
}

/** 读取配置；文件不存在时写出默认配置并返回（doctor 首跑生成） */
export function loadConfig(): { config: CortxtosConfig; created: boolean } {
  if (!existsSync(CONFIG_PATH)) {
    const config = defaultConfig();
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    return { config, created: true };
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<CortxtosConfig>;
  // 浅合并：缺字段用默认值补，避免旧配置升级后崩
  const config: CortxtosConfig = {
    ...defaultConfig(),
    ...parsed,
    ollama: { ...defaultConfig().ollama, ...(parsed.ollama ?? {}) },
    tiers: { ...defaultConfig().tiers, ...(parsed.tiers ?? {}) },
    asr: { ...defaultConfig().asr, ...(parsed.asr ?? {}) },
  };
  return { config, created: false };
}

export function vaultRoot(config: CortxtosConfig): string {
  return expandHome(config.vaultPath);
}

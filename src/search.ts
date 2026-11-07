// kb-search 检索核心（票 03 文件版关键字；票 09 叠加语义通道）：notes/ + daily/ 全本地
// 不依赖 Pi 运行时，CLI（cortxtos search）与 extension tool 共用
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CortxtosConfig } from "./config.ts";
import { listMarkdown, parseFrontmatter, stripFrontmatter, vaultDir } from "./vault.ts";
import { semanticSearch } from "./vecstore.ts";
import type { EmbedFn } from "./embed.ts";

export interface SearchOptions {
  query: string;
  tags?: string[];
  type?: string;
  source?: string;
  days?: number; // 近 N 天（按 created 过滤，实现"上周"这类时间语义）
  limit?: number;
}

export interface SearchHit {
  path: string; // vault 相对路径（模型与人 alike）
  absPath: string;
  title: string;
  tags: string[];
  created: string;
  type: string;
  score: number;
  snippets: string[];
  via: Array<"keyword" | "semantic">; // 票 09：命中方式标注
}

const SEARCH_DIRS = ["notes", "daily"] as const;
const MAX_SNIPPETS = 3;

function termsOf(query: string): string[] {
  // 英文按空白切；中文整串做子串匹配，另补 2~4 字滑窗提高召回
  const raw = query.toLowerCase().split(/[\s,，。？?!！]+/).filter(Boolean);
  const terms = new Set<string>(raw);
  for (const t of raw) {
    if (/[\u4e00-\u9fff]/.test(t) && t.length > 4) {
      for (const w of [2, 3, 4]) {
        for (let i = 0; i + w <= t.length; i++) terms.add(t.slice(i, i + w));
      }
    }
  }
  return [...terms];
}

function lineHits(text: string, term: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.toLowerCase().includes(term)) {
      const t = line.trim();
      out.push(t.length > 120 ? t.slice(0, 60) + " … " + t.slice(-50) : t);
      if (out.length >= MAX_SNIPPETS) break;
    }
  }
  return out;
}

export async function searchVault(config: CortxtosConfig, options: SearchOptions): Promise<SearchHit[]> {
  const root = vaultDir(config);
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const terms = termsOf(options.query);
  const cutoff = options.days !== undefined ? Date.now() - options.days * 86400_000 : undefined;
  const wantTags = options.tags?.map((t) => t.toLowerCase()).filter(Boolean);

  const hits: SearchHit[] = [];
  for (const dir of SEARCH_DIRS) {
    for (const file of await listMarkdown(join(root, dir))) {
      const text = await readFile(file, "utf8");
      const fm = parseFrontmatter(text);
      const title = fm?.title ?? file.split("/").pop()!.replace(/\.md$/, "");
      const tags = fm?.tags ?? [];

      if (wantTags && wantTags.length > 0 && !wantTags.some((t) => tags.map((x) => x.toLowerCase()).includes(t))) continue;
      if (options.type !== undefined && fm?.type !== options.type) continue;
      if (options.source !== undefined && fm?.source !== options.source) continue;
      if (cutoff !== undefined) {
        const created = Date.parse(fm?.created ?? "");
        if (Number.isFinite(created) && created < cutoff) continue;
      }

      let score = 0;
      const snippets: string[] = [];
      const body = stripFrontmatter(text); // 只在正文打分：避免 “ty” 这类语法窗口误 hit frontmatter 键名（票 09 噪声修正）
      const titleLc = title.toLowerCase();
      const bodyLc = body.toLowerCase();
      for (const term of terms) {
        if (titleLc.includes(term)) score += 5;
        if (tags.some((t) => t.toLowerCase().includes(term))) score += 3;
        if (titleLc === term) score += 4;
        const occurrences = bodyLc.split(term).length - 1;
        if (occurrences > 0) score += Math.min(occurrences, 4);
        if (snippets.length < MAX_SNIPPETS) {
          for (const s of lineHits(body, term)) if (!snippets.includes(s)) snippets.push(s);
        }
      }
      if (score === 0) continue;
      hits.push({
        path: relative(root, file),
        absPath: file,
        title,
        tags,
        created: fm?.created ?? "",
        type: fm?.type ?? "note",
        score,
        snippets: snippets.slice(0, MAX_SNIPPETS),
        via: ["keyword"],
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.created.localeCompare(a.created));
  return hits.slice(0, limit);
}

export type SearchMode = "hybrid" | "keyword-only";

export interface HybridResult {
  hits: SearchHit[];
  mode: SearchMode;
  note?: string; // 退回原因等只读提示，不影响命中结果
}

/** 票 09 混合检索：两通道倒数排名融合（RRF，score = Σ 1/(60+rank)）——
 * 单通道霸榜不再挤掉另一通道的高位命中，双命中自然置顶；无索引/嵌入服务不可用时无缝退回文件版 */
export async function searchHybrid(config: CortxtosConfig, options: SearchOptions, embed: EmbedFn): Promise<HybridResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const pool = Math.min(limit * 3, 20); // 融合前扩候选池
  const keyword = await searchVault(config, { ...options, limit: pool });

  let sem;
  try {
    sem = await semanticSearch(config, options.query, pool, embed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { hits: keyword.slice(0, limit), mode: "keyword-only", note: `语义通道不可用，已退回关键字检索（${msg}）` };
  }
  if (sem === null) {
    return { hits: keyword.slice(0, limit), mode: "keyword-only", note: "向量索引未建：当前为文件版关键字检索（cortxtos reindex 或等夜间重建后可启用语义）" };
  }

  const root = vaultDir(config);
  const cutoff = options.days !== undefined ? Date.now() - options.days * 86400_000 : undefined;
  const wantTags = options.tags?.map((t) => t.toLowerCase()).filter(Boolean);

  const fused = new Map<string, { hit: SearchHit; rrf: number }>();
  keyword.forEach((h, i) => {
    const entry = { hit: { ...h, via: [...h.via] }, rrf: 1 / (60 + i) };
    fused.set(h.path, entry);
  });
  sem.forEach((s, j) => {
    // 语义命中同样过 frontmatter 过滤，两个通道行为一致
    if (wantTags && wantTags.length > 0 && !wantTags.some((t) => s.tags.map((x) => x.toLowerCase()).includes(t))) return;
    if (options.type !== undefined && s.type !== options.type) return;
    if (options.source !== undefined && s.source !== options.source) return;
    if (cutoff !== undefined) {
      const created = Date.parse(s.created);
      if (Number.isFinite(created) && created < cutoff) return;
    }
    const existing = fused.get(s.path);
    if (existing !== undefined) {
      if (!existing.hit.via.includes("semantic")) existing.hit.via.push("semantic");
      existing.rrf += 1 / (60 + j); // 双命中：两通道排名分相加，自然置顶
      return;
    }
    fused.set(s.path, {
      hit: {
        path: s.path,
        absPath: join(root, s.path),
        title: s.title,
        tags: s.tags,
        created: s.created,
        type: s.type,
        score: Math.max(1, Math.round(10 - s.distance * 5)), // L2 距离映射成可视分值
        snippets: s.snippet.length > 0 ? [s.snippet] : [],
        via: ["semantic"],
      },
      rrf: 1 / (60 + j),
    });
  });

  const hits = [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf || b.hit.created.localeCompare(a.hit.created))
    .slice(0, limit)
    .map((x) => x.hit);
  return { hits, mode: "hybrid" };
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "未找到匹配笔记。可尝试更换关键词、放宽 tags/时间过滤，或确认笔记是否在 notes/ 或 daily/ 下。";
  return hits
    .map(
      (h, i) =>
        `#${i + 1} [${h.via.map((v) => (v === "keyword" ? "关键字" : "语义")).join("+")}] [score ${h.score}] ${h.title}\n路径: ${h.path} | type: ${h.type} | tags: [${h.tags.join(", ")}] | created: ${h.created}\n${h.snippets.map((s) => `  > ${s}`).join("\n")}`,
    )
    .join("\n\n");
}

// 向量索引（票 09）：sqlite-vec 单文件存 vault 外缓存目录（~/.cortxtos/index/），定时全量重建、可删除重建
// node:sqlite（Node ≥22 内置）+ allowExtension；维度以 embedding 实测输出为准，建库时写进 meta
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import type { CortxtosConfig } from "./config.ts";
import { dirtyIndexPath, indexPath } from "./config.ts";
import { listMarkdown, parseFrontmatter, stripFrontmatter, vaultDir } from "./vault.ts";
import type { EmbedFn } from "./embed.ts";

const require = createRequire(import.meta.url);

export const CHUNK_MAX_CHARS = 600;
export const MAX_CHUNKS_PER_FILE = 24;
const INDEX_DIRS = ["notes", "daily"] as const;

/** 段落切块：按空行分段贪心合批至 ~600 字；超长段落硬切；块头带标题提升语义锚定 */
export function splitChunks(title: string, body: string, maxChars = CHUNK_MAX_CHARS): string[] {
  const paragraphs = body
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^#+\s*$/.test(p));
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) pieces.push(p);
    else for (let i = 0; i < p.length; i += maxChars) pieces.push(p.slice(i, i + maxChars));
  }
  if (pieces.length === 0) return [title].filter(Boolean);
  const merged: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur.length > 0 && cur.length + p.length + 1 > maxChars) {
      merged.push(cur);
      cur = p;
    } else {
      cur = cur.length > 0 ? `${cur}\n${p}` : p;
    }
  }
  if (cur.length > 0) merged.push(cur);
  return merged.map((m) => `${title}\n${m}`);
}

interface ChunkRow {
  path: string;
  title: string;
  tags: string;
  created: string;
  type: string;
  source: string;
  ord: number;
  text: string;
}

async function collectChunks(config: CortxtosConfig): Promise<ChunkRow[]> {
  const root = vaultDir(config);
  const rows: ChunkRow[] = [];
  for (const dir of INDEX_DIRS) {
    for (const file of await listMarkdown(join(root, dir))) {
      const text = await readFile(file, "utf8");
      const fm = parseFrontmatter(text);
      const title = fm?.title ?? file.split("/").pop()!.replace(/\.md$/, "");
      const chunks = splitChunks(title, stripFrontmatter(text)).slice(0, MAX_CHUNKS_PER_FILE);
      chunks.forEach((c, ord) =>
        rows.push({
          path: relative(root, file),
          title,
          tags: (fm?.tags ?? []).join(","),
          created: fm?.created ?? "",
          type: fm?.type ?? "note",
          source: fm?.source ?? "",
          ord,
          text: c,
        }),
      );
    }
  }
  return rows;
}

function loadVec(db: DatabaseSync): void {
  const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
  db.loadExtension(sqliteVec.getLoadablePath());
}

/** 向量 → BLOB：必须取 .buffer（直接 Buffer.from(Float32Array) 会按 array-like 每元素 1 字节，维度全错） */
function vecBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function openDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { allowExtension: true });
}

export interface ReindexSummary {
  files: number;
  chunks: number;
  dim: number;
  builtAt: string;
  seconds: number;
}

/** 全量重建：临时库建好后原子替换——失败留痕不污染旧索引；成功后清空脏标记 */
export async function reindexAll(config: CortxtosConfig, embed: EmbedFn): Promise<ReindexSummary> {
  const started = Date.now();
  const rows = await collectChunks(config);
  const vectors = rows.length > 0 ? await embed(rows.map((r) => r.text)) : [];
  const dim = vectors[0]?.length ?? 0;
  if (vectors.length !== rows.length) throw new Error(`向量数量(${vectors.length})与文本块(${rows.length})不一致`);

  const dbPath = indexPath();
  const builtAt = new Date().toISOString();
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const db = openDb(tmp);
  try {
    loadVec(db);
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE chunks(path TEXT NOT NULL, title TEXT NOT NULL, tags TEXT NOT NULL,
        created TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL);
    `);
    if (dim > 0) db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}])`);
    const insChunk = db.prepare("INSERT INTO chunks (path, title, tags, created, type, source, ord, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    // vec0 拒接绑定参数作 rowid（"Only integers are allowed for primary key"）；两表同序插入，自增 rowid 天然 1..n 对齐
    const insVec = dim > 0 ? db.prepare("INSERT INTO vec_chunks (embedding) VALUES (?)") : null;
    db.exec("BEGIN");
    for (const [i, r] of rows.entries()) {
      insChunk.run(r.path, r.title, r.tags, r.created, r.type, r.source, r.ord, r.text);
      insVec?.run(vecBlob(vectors[i]!));
    }
    db.exec("COMMIT");
    const insMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insMeta.run("built_at", builtAt);
    insMeta.run("dim", String(dim));
    insMeta.run("chunk_count", String(rows.length));
    insMeta.run("file_count", String(new Set(rows.map((r) => r.path)).size));
  } finally {
    db.close();
  }
  renameSync(tmp, dbPath); // POSIX 原子替换，旧索引要么完好要么被新版顶替
  rmSync(dirtyIndexPath(), { force: true });
  return { files: new Set(rows.map((r) => r.path)).size, chunks: rows.length, dim, builtAt, seconds: Math.round((Date.now() - started) / 1000) };
}

export interface IndexMeta {
  builtAt: string;
  dim: number;
  chunkCount: number;
  fileCount: number;
}

/** 读索引元信息（doctor/检索前置探测）；库不存在返回 null */
export function readIndexMeta(): IndexMeta | null {
  const dbPath = indexPath();
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const get = (key: string): string | undefined =>
      (db!.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
    const builtAt = get("built_at");
    if (builtAt === undefined) return null;
    return { builtAt, dim: Number(get("dim") ?? 0), chunkCount: Number(get("chunk_count") ?? 0), fileCount: Number(get("file_count") ?? 0) };
  } catch {
    return null; // 半截库/损坏按未建索引处理，下次重建覆盖
  } finally {
    db?.close();
  }
}

export interface SemanticHit {
  path: string;
  title: string;
  tags: string[];
  created: string;
  type: string;
  source: string;
  distance: number;
  snippet: string;
}

/** KNN 语义检索：无库返回 null（调用方退回文件版）；Ollama 不可达等异常照抛由调用方降级 */
export async function semanticSearch(config: CortxtosConfig, query: string, k: number, embed: EmbedFn): Promise<SemanticHit[] | null> {
  const dbPath = indexPath();
  if (!existsSync(dbPath)) return null;
  const meta = readIndexMeta();
  if (meta === null || meta.chunkCount === 0) return null;
  const [qvec] = await embed([query]);
  if (qvec === undefined || qvec.length !== meta.dim) {
    throw new Error(`查询向量维度 ${qvec?.length ?? 0} 与索引维度 ${meta.dim} 不符：模型变更后可删 ${dbPath} 重建`);
  }
  const db = openDb(dbPath);
  try {
    loadVec(db);
    const knn = db
      .prepare("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance")
      .all(vecBlob(qvec), k) as Array<{ rowid: number; distance: number }>;
    const getChunk = db.prepare("SELECT path, title, tags, created, type, source, text FROM chunks WHERE rowid = ?");
    const out: SemanticHit[] = [];
    for (const { rowid, distance } of knn) {
      const row = getChunk.get(rowid) as { path: string; title: string; tags: string; created: string; type: string; source: string; text: string } | undefined;
      if (row === undefined) continue;
      out.push({
        path: row.path,
        title: row.title,
        tags: row.tags.length > 0 ? row.tags.split(",") : [],
        created: row.created,
        type: row.type,
        source: row.source,
        distance,
        snippet: row.text.split("\n").slice(1).join(" ").trim().slice(0, 120),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** 脏标记统计（doctor 用）：上次重建之后新写入的笔记数 */
export function dirtyNoteCount(): number {
  const p = dirtyIndexPath();
  if (!existsSync(p)) return 0;
  try {
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    return new Set(lines).size;
  } catch {
    return 0;
  }
}

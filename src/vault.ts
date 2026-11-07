// cortxtos vault：目录初始化 + note frontmatter schema（DESIGN.md §4，票 02）
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CortxtosConfig } from "./config.ts";
import { dirtyIndexPath, expandHome } from "./config.ts";

export const VAULT_SUBDIRS = ["inbox", "notes", "daily", "workflows"] as const;

export type NoteSource = "inbox-pdf" | "inbox-image" | "manual" | "reflect" | "audio" | "video";
export type NoteType = "note" | "summary" | "log" | "workflow-output";

export interface NoteFrontmatter {
  title: string;
  tags: string[];
  created: string; // ISO-8601
  source: NoteSource;
  type: NoteType;
}

export function vaultDir(config: CortxtosConfig): string {
  return expandHome(config.vaultPath);
}

/** 幂等创建 vault 四分区 */
export async function ensureVault(config: CortxtosConfig): Promise<string[]> {
  const root = vaultDir(config);
  const created: string[] = [];
  for (const sub of VAULT_SUBDIRS) {
    const p = join(root, sub);
    if (!existsSync(p)) {
      await mkdir(p, { recursive: true });
      created.push(p);
    }
  }
  return created;
}

function dumpFrontmatter(fm: NoteFrontmatter): string {
  const tags = fm.tags.length > 0 ? fm.tags.join(", ") : "";
  return [
    "---",
    `title: ${fm.title}`,
    `tags: [${tags}]`,
    `created: ${fm.created}`,
    `source: ${fm.source}`,
    `type: ${fm.type}`,
    "---",
    "",
  ].join("\n");
}

/** 解析最小 frontmatter 子集（只认 schema 五字段）；无 frontmatter 返回 null */
export function parseFrontmatter(text: string): NoteFrontmatter | null {
  if (!text.startsWith("---")) return null;
  const lines = text.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0 || end > 30) return null;
  const get = (key: string): string | undefined =>
    lines.slice(1, end).find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const title = get("title");
  const source = get("source");
  const type = get("type");
  if (title === undefined || source === undefined || type === undefined) return null;
  const rawTags = get("tags") ?? "";
  const tags = rawTags
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { title, tags, created: get("created") ?? "", source: source as NoteSource, type: type as NoteType };
}

export function hasFrontmatter(text: string): boolean {
  return parseFrontmatter(text) !== null;
}

/** 去掉 frontmatter，返回正文（检索正文打分与索引切块共用，避免元数据噪声） */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  const rest = text.slice(end + 4);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

/** 递归收集目录下全部 .md（检索与索引共用） */
export async function listMarkdown(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMarkdown(p)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** 钩子（票 09 转正）：笔记写入后追记脏标记；仍保持“重建才生效”语义——夜间 reindex 摄取并清空 */
export function onNoteWritten(absolutePath: string): void {
  try {
    mkdirSync(dirname(dirtyIndexPath()), { recursive: true });
    appendFileSync(dirtyIndexPath(), `${absolutePath}\n`, "utf8");
  } catch {
    // 索引标记失败绝不影响笔记写入本身
  }
}

function slugify(title: string): string {
  const s = title
    .trim()
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.length > 0 ? s.slice(0, 60) : "untitled";
}

export interface WriteNoteInput {
  dir: string; // 相对 vault 根的子目录，如 "notes" 或 "notes/编程"
  frontmatter: NoteFrontmatter;
  body: string;
}

/** 唯一笔记写入口：schema 落盘 + 防覆盖文件名 + on_note_written 钩子 */
export async function writeNote(config: CortxtosConfig, input: WriteNoteInput): Promise<string> {
  const root = vaultDir(config);
  const dirAbs = join(root, input.dir);
  await mkdir(dirAbs, { recursive: true });
  const base = slugify(input.frontmatter.title);
  let path = join(dirAbs, `${base}.md`);
  // 防覆盖：同名则追加时间戳后缀
  if (existsSync(path)) {
    const stamp = input.frontmatter.created.replace(/[-:T]/g, "").slice(0, 14);
    path = join(dirAbs, `${base}-${stamp}.md`);
  }
  await writeFile(path, dumpFrontmatter(input.frontmatter) + input.body.trimEnd() + "\n", "utf8");
  onNoteWritten(path);
  return path;
}

/** 追加到 daily/YYYY-MM-DD.md（票 06 /reflect 复用同一写入路径与钩子） */
export async function appendDaily(config: CortxtosConfig, section: string): Promise<string> {
  const root = vaultDir(config);
  const day = new Date().toISOString().slice(0, 10);
  const path = join(root, "daily", `${day}.md`);
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const fm: NoteFrontmatter = {
      title: `每日沉淀 ${day}`,
      tags: ["daily"],
      created: new Date().toISOString(),
      source: "reflect",
      type: "log",
    };
    await writeFile(path, dumpFrontmatter(fm) + "\n", "utf8");
  }
  await appendFile(path, `\n${section.trimEnd()}\n`, "utf8");
  onNoteWritten(path);
  return path;
}

export async function readNote(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function fileMtimeIso(path: string): Promise<string> {
  const s = await stat(path);
  return s.mtime.toISOString();
}

export function noteFileNameFromPath(path: string): string {
  return basename(path, ".md");
}

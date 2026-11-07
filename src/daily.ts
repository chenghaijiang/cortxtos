// daily 沉淀文件（票 06）：daily/YYYY-MM-DD.md 追加式写入，type: log / source: reflect
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CortxtosConfig } from "./config.ts";
import { vaultDir } from "./vault.ts";

/** 本地时区的 YYYY-MM-DD（"今天"按用户手表，不按 UTC） */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function timeKey(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface DailyAppendResult {
  path: string; // vault 相对路径
  created: boolean; // 本次是否新建了当日文件
}

/**
 * 把一段 markdown 条目追加到当日 daily 文件。
 * 文件不存在则按 frontmatter schema 新建；存在则只追加新节，绝不覆盖旧条目。
 * 单用户手动触发场景用简单 read-modify-write；若未来出现并发写入方，再上变更队列。
 */
export async function appendDaily(config: CortxtosConfig, markdown: string, now = new Date()): Promise<DailyAppendResult> {
  const key = dateKey(now);
  const rel = join("daily", `${key}.md`);
  const abs = join(vaultDir(config), "daily", `${key}.md`);
  await mkdir(join(vaultDir(config), "daily"), { recursive: true });
  const section = `## ${timeKey(now)} 沉淀\n\n${markdown.trim()}\n`;
  const existing = await readFile(abs, "utf8").catch(() => null);
  if (existing === null) {
    const front = [
      "---",
      `title: 每日沉淀 ${key}`,
      "tags: [daily, reflect]",
      `created: ${now.toISOString()}`,
      "source: reflect",
      "type: log",
      "---",
      "",
      `# ${key}`,
      "",
      "",
    ].join("\n");
    await writeFile(abs, front + section, "utf8");
    return { path: rel, created: true };
  }
  await writeFile(abs, existing.replace(/\s+$/, "") + "\n\n" + section, "utf8");
  return { path: rel, created: false };
}

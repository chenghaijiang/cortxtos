// 存量笔记 migration（票 02）：为无 frontmatter 的 .md 补齐 schema 五字段
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CortxtosConfig } from "./config.ts";
import { hasFrontmatter, noteFileNameFromPath, onNoteWritten, vaultDir } from "./vault.ts";

async function collectMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await collectMarkdown(p)));
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  } catch {
    /* 目录不存在视为无存量 */
  }
  return out;
}

function titleFromContent(text: string, path: string): string {
  const heading = text.split("\n").find((l) => l.startsWith("# "));
  if (heading != null) return heading.slice(2).trim();
  return noteFileNameFromPath(path);
}

export interface MigrateResult {
  scanned: number;
  migrated: string[];
  skipped: string[];
}

/** 只动 notes/ 与 daily/；dry-run 不写文件 */
export async function migrateVault(config: CortxtosConfig, dryRun: boolean): Promise<MigrateResult> {
  const root = vaultDir(config);
  const files = [...(await collectMarkdown(join(root, "notes"))), ...(await collectMarkdown(join(root, "daily")))];
  const result: MigrateResult = { scanned: files.length, migrated: [], skipped: [] };
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (hasFrontmatter(text)) {
      result.skipped.push(file);
      continue;
    }
    const mtime = (await stat(file)).mtime.toISOString();
    const header = [
      "---",
      `title: ${titleFromContent(text, file)}`,
      "tags: []",
      `created: ${mtime}`,
      "source: manual",
      "type: note",
      "---",
      "",
    ].join("\n");
    if (!dryRun) {
      await writeFile(file, header + text, "utf8");
      onNoteWritten(file);
    }
    result.migrated.push(relative(root, file));
  }
  return result;
}

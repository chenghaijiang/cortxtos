#!/usr/bin/env node
// cortxtos CLI 入口（Node >=22.18 原生 type stripping，直接运行 .ts）
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runDoctor } from "../src/doctor.ts";
import { loadConfig } from "../src/config.ts";
import { ensureVault, writeNote } from "../src/vault.ts";
import type { NoteSource, NoteType } from "../src/vault.ts";
import { writePlists } from "../src/launchd.ts";
import { indexPath } from "../src/config.ts";
import { migrateVault } from "../src/migrate.ts";
import { formatHits, searchHybrid, searchVault } from "../src/search.ts";
import { makeEmbedder } from "../src/embed.ts";
import { reindexAll } from "../src/vecstore.ts";
import { startServer } from "../src/server.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "doctor": {
    const fails = await runDoctor();
    process.exitCode = fails > 0 ? 1 : 0;
    break;
  }
  case "init": {
    const { config, created } = loadConfig();
    console.log(created ? `ℹ️  已生成默认配置并初始化` : `ℹ️  使用现有配置`);
    const dirs = await ensureVault(config);
    console.log(dirs.length > 0 ? `📁 创建分区：${dirs.join(", ")}` : "📁 vault 四分区已就绪（幂等，未改动）");
    const plists = await writePlists(config, PACKAGE_ROOT);
    console.log(`📄 生成 launchd 模板：\n   ${plists.join("\n   ")}`);
    console.log(`
挂载（用户确认后执行；卸载用 launchctl bootout gui/$UID/<label>）：
  mkdir -p ~/Library/LaunchAgents
  cp ${plists[0]} ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cortxtos.inbox.plist
  cp ${plists[1]} ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cortxtos.reindex.plist`);
    break;
  }
  case "note": {
    // 用法：cortxtos note add --title "T" --tags a,b [--type note] [--source manual] [--dir notes/子目录]
    if (process.argv[3] !== "add") {
      console.log('用法：cortxtos note add --title "标题" --tags a,b [--body "正文"] [--type note] [--source manual] [--dir notes]');
      process.exitCode = 1;
      break;
    }
    const { config } = loadConfig();
    const path = await writeNote(config, {
      dir: flag("dir", "notes"),
      frontmatter: {
        title: flag("title", "untitled"),
        tags: flag("tags", "").split(",").map((t) => t.trim()).filter(Boolean),
        created: new Date().toISOString(),
        source: flag("source", "manual") as NoteSource,
        type: flag("type", "note") as NoteType,
      },
      body: flag("body", "（待补充正文）"),
    });
    console.log(`✍️  已写入 ${path}`);
    break;
  }
  case "migrate": {
    const { config } = loadConfig();
    const dryRun = hasFlag("dry-run");
    const r = await migrateVault(config, dryRun);
    console.log(`${dryRun ? "[dry-run] " : ""}扫描 ${r.scanned} 篇，补齐 ${r.migrated.length} 篇，跳过已有 frontmatter ${r.skipped.length} 篇`);
    for (const m of r.migrated) console.log(`  ${dryRun ? "将补齐" : "已补齐"}：${m}`);
    break;
  }
  case "search": {
    // 用法：cortxtos search "关键词" [--tags a,b] [--type note] [--source inbox-pdf] [--days 14] [--limit 5] [--no-sem 只走关键字通道]
    const query = process.argv[3] ?? "";
    if (query.length === 0) {
      console.log('用法：cortxtos search "关键词" [--tags a,b] [--type note] [--source inbox-pdf] [--days 14] [--limit 5] [--no-sem]');
      process.exitCode = 1;
      break;
    }
    const { config } = loadConfig();
    const tagsArg = flag("tags", "");
    const opts = {
      query,
      tags: tagsArg.length > 0 ? tagsArg.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      type: hasFlag("type") ? flag("type", "") : undefined,
      source: hasFlag("source") ? flag("source", "") : undefined,
      days: hasFlag("days") ? Number(flag("days", "14")) : undefined,
      limit: hasFlag("limit") ? Number(flag("limit", "5")) : undefined,
    };
    if (hasFlag("no-sem")) {
      console.log(formatHits(await searchVault(config, opts)));
      break;
    }
    const started = Date.now();
    const r = await searchHybrid(config, opts, makeEmbedder(config));
    if (r.note !== undefined) console.log(`ℹ️  ${r.note}`);
    console.log(formatHits(r.hits));
    console.log(`\n（${r.mode === "hybrid" ? "语义+关键字混合" : "文件版关键字"}，耗时 ${((Date.now() - started) / 1000).toFixed(2)}s）`);
    break;
  }
  case "reindex": {
    // 夜间 launchd 任务入口：全量重建向量索引（sqlite-vec，存 vault 外缓存目录）
    const { config } = loadConfig();
    try {
      const s = await reindexAll(config, makeEmbedder(config));
      console.log(`🔨 索引重建完成：${s.files} 篇笔记 → ${s.chunks} 个文本块（dim ${s.dim}，用时 ${s.seconds}s）→ ${indexPath()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`❌ 索引重建失败（旧索引保留完好，日志留痕）：${msg}`);
      process.exitCode = 1;
    }
    break;
  }
  case "serve": {
    // 本地 Web 仪表盘：只绑 127.0.0.1，数据不出机器
    const { config } = loadConfig();
    const port = Number(flag("port", "8787"));
    await startServer(config, port);
    break;
  }
  case "help":
  default: {
    console.log(`cortxtos —— CortxtOS 工作台 CLI

用法：
  cortxtos doctor                      环境自检（Node / Pi / Ollama / 模型 / 内存选档 / whisper / vault / launchd）
  cortxtos init                        初始化 vault 四分区 + launchd plist（票 02）
  cortxtos note add --title T ...      按 schema 写一篇笔记（演示/脚本入口）
  cortxtos migrate [--dry-run]         存量笔记补 frontmatter
  cortxtos search "关键词"              知识库检索（语义+关键字混合，无索引自动退回文件版；kb_search tool 的 CLI 形态）
  cortxtos reindex                     向量索引全量重建（夜间 launchd 同源入口，票 09）
  cortxtos serve [--port 8787]         本地 Web 仪表盘（仅 127.0.0.1：检索/笔记/inbox/状态）
  cortxtos help                        本帮助`);
    break;
  }
}

// launchd plist 生成（票 02）：只渲染文件，不自动 bootstrap —— 挂载指令打印给用户
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CortxtosConfig } from "./config.ts";
import { pipelineModel } from "./tier.ts";
import { vaultDir } from "./vault.ts";

const PLIST_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>`;

/** 无人值守管道的完整命令串（launchd plist 与 Web UI 手动触发共用，两条路径行为一致） */
export function inboxCommand(config: CortxtosConfig, packageRoot: string): string {
  const skill = join(packageRoot, "skills", "inbox-process");
  return headlessCommand(config, `使用 inbox-process 流程：处理 inbox/ 中尚未处理的文件；若无新文件，直接结束，不要做其他事情`, skill);
}

/** 任意提示词的无人值守 pi -p 命令串（深度会话委派子任务共用同一套 PATH/模型/skill 组装与窄门） */
export function headlessCommand(config: CortxtosConfig, prompt: string, skill?: string): string {
  const vault = vaultDir(config);
  const model = pipelineModel(config);
  const pathPrefix = `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`;
  const skillArg = skill ? ` --skill ${JSON.stringify(skill)}` : "";
  return `export PATH=${JSON.stringify(pathPrefix)}:$PATH && cd ${JSON.stringify(vault)} && CORTXTOS_HEADLESS=1 OLLAMA_MAX_LOADED_MODELS=1 pi${skillArg} --model ${JSON.stringify(model)} -p ${JSON.stringify(prompt)}`;
}

/** inbox watcher：文件落入 inbox → 冷启动 pi -p 处理
 * 档位（票 05/07）：会话模型用 vision 档静态解析（混合管道需覆盖图片；qwen3.8 原生多模态，
 * PDF 摘要同会话不损失——fast 档要求由 SKILL 以提示约束）；vision 缺失沿 fallback 链降级 balanced
 * skill 显式加载不依赖自动发现
 * launchd 跑的 zsh 是非交互壳，不读 .zshrc（nvm 在那里初始化）——PATH 必须显式注入：
 * 当前 node 的 dirname（pi 作为全局 npm 包同目录）+ /opt/homebrew/bin（pdftotext） */
export function inboxPlist(config: CortxtosConfig, packageRoot: string): string {
  const vault = vaultDir(config);
  const command = inboxCommand(config, packageRoot);
  return `${PLIST_HEADER}
\t<key>Label</key>\n\t<string>com.cortxtos.inbox</string>
\t<key>ProgramArguments</key>\n\t<array>
\t\t<string>/bin/zsh</string>\n\t\t<string>-lc</string>\n\t\t<string>${command}</string>
\t</array>
\t<key>WatchPaths</key>\n\t<array>\n\t\t<string>${vault}/inbox</string>\n\t</array>
\t<key>RunAtLoad</key>\n\t<false/>
\t<key>ThrottleInterval</key>\n\t<integer>30</integer>
\t<key>StandardOutPath</key>\n\t<string>${vault}/workflows/launchd-inbox.log</string>
\t<key>StandardErrorPath</key>\n\t<string>${vault}/workflows/launchd-inbox.err.log</string>
</dict>
</plist>
`;
}

/** 夜间全量重建索引（票 09）：直接绕 node 绝对路径跑 CLI，不需 pi；失败痕迹落 err 日志，
 * 旧索引保留完好（重建是临时库原子替换）；doctor 显示上次成功重建时间供人工察觉 */
export function reindexPlist(config: CortxtosConfig, packageRoot: string): string {
  const vault = vaultDir(config);
  const node = process.execPath;
  const command = `${JSON.stringify(node)} ${JSON.stringify(join(packageRoot, "bin", "cortxtos.ts"))} reindex`;
  return `${PLIST_HEADER}
\t<key>Label</key>\n\t<string>com.cortxtos.reindex</string>
\t<key>ProgramArguments</key>\n\t<array>
\t\t<string>/bin/zsh</string>\n\t\t<string>-lc</string>\n\t\t<string>${command}</string>
\t</array>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Hour</key>
\t\t<integer>3</integer>
\t\t<key>Minute</key>
\t\t<integer>0</integer>
\t</dict>
\t<key>RunAtLoad</key>\n\t<false/>
\t<key>StandardOutPath</key>\n\t<string>${vault}/workflows/launchd-reindex.log</string>
\t<key>StandardErrorPath</key>\n\t<string>${vault}/workflows/launchd-reindex.err.log</string>
</dict>
</plist>
`;
}

export async function writePlists(config: CortxtosConfig, packageRoot: string): Promise<string[]> {
  const outDir = join(packageRoot, "launchd");
  await mkdir(outDir, { recursive: true });
  const paths = [
    join(outDir, "com.cortxtos.inbox.plist"),
    join(outDir, "com.cortxtos.reindex.plist"),
  ];
  await writeFile(paths[0]!, inboxPlist(config, packageRoot), "utf8");
  await writeFile(paths[1]!, reindexPlist(config, packageRoot), "utf8");
  return paths;
}

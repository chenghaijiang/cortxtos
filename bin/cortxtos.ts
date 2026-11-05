#!/usr/bin/env node
// cortxtos CLI 入口（Node >=22.18 原生 type stripping，直接运行 .ts）
import { runDoctor } from "../src/doctor.ts";

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "doctor": {
    const fails = await runDoctor();
    process.exitCode = fails > 0 ? 1 : 0;
    break;
  }
  case "init": {
    console.log("cortxtos init：vault 初始化属票 02 交付范围（见 .scratch/cortxtos/issues/02-*.md）。");
    console.log("当前可先运行 cortxtos doctor 查看环境就绪度。");
    process.exitCode = 1;
    break;
  }
  case "help":
  default: {
    console.log(`cortxtos —— CortxtOS 工作台 CLI

用法：
  cortxtos doctor    环境自检（Node / Pi / Ollama / 模型 / 内存选档 / whisper / vault / launchd）
  cortxtos init      初始化 vault 与 launchd（票 02，待实现）
  cortxtos help      本帮助`);
    break;
  }
}

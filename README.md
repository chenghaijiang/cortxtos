# CortxtOS

基于 [Pi Agent Harness](https://github.com/earendil-works/pi) 的**本地优先个人 AI 工作台**：深度知识库管理 + 事件驱动自动化工作流 + 全本地多模态路由（Ollama）。

设计定稿见 [DESIGN.md](./DESIGN.md)，实施工单见 `.scratch/cortxtos/issues/`。

## 前置要求

- macOS（当前仅适配本机 Apple Silicon）
- Node.js ≥ 22.19（`nvm install 22`）
- Pi CLI（`curl -fsSL https://pi.dev/install.sh | sh`）
- Ollama 运行中，主模型已拉取：`ollama pull qwen3.8:27b`（48GB 内存建议 `-mlx` 变体）

## 快速开始

```bash
# 1. 环境自检（首跑自动生成 ~/.cortxtos/cortxtos.json）
node bin/cortxtos.ts doctor

# 2. 把 cortxtos 装进 Pi（本地分发）
pi install .

# 3. 在知识库目录启动 Pi，敲 /cortxtos 验证 package 已加载
cd ~/cortxt-vault && pi
```

## CLI

| 命令 | 说明 | 状态 |
|------|------|------|
| `cortxtos doctor` | 自检 Node/Pi/Ollama/模型/内存选档/whisper/vault/launchd，❌ 时非零退出 | ✅ 票 01 |
| `cortxtos init` | 建 vault 四分区 + launchd plist | 🚧 票 02 |

## 配置

`~/.cortxtos/cortxtos.json`（或 `CORTXTOS_CONFIG` 指定路径）：档位表 `fast/balanced/heavy/vision/embedding` + fallback 链 + vault 路径 + ASR。全部默认指向本地 Ollama；接入云端 provider 只改此文件不改代码。

Pi 侧的 Ollama 接入在 `~/.pi/agent/models.json` 配置 OpenAI 兼容端点（`http://localhost:11434/v1`，dummy apiKey）。

## 安全

无人值守自动化会话（print/json 模式）只允许白名单工具，禁用 bash/edit——由 `session-guard` extension 实施（票 04）。处理任意 inbox 文件前该票必须先完成，残余风险与窄门策略见 DESIGN.md §7。

## FAQ

- **`git clone` GitHub 超时**：本机 TLS/HTTP2 握手受扰时，用一次性环境变量降级协议：
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 git clone ...`（不改动全局配置）
- **`node bin/cortxtos.ts` 报未知语法**：确认 `node -v` ≥ 22.18（原生 TypeScript type stripping）
- **watcher 与 TUI 抢模型**：Ollama 固定 `OLLAMA_MAX_LOADED_MODELS=1`，异步任务排队是设计行为

## License

MIT

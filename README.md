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

## 本地启动（从零跑起来）

```bash
# 0. 安装依赖（sqlite-vec + typescript；Node ≥ 22.19 自带原生 TS type stripping，无需构建步骤）
npm install

# 1. 确认 Ollama 服务在跑（doctor 会检查，也可手动验证）
curl -s http://localhost:11434/api/tags   # 返回模型 JSON 即正常
# 未启动时：打开 Ollama 应用，或 `ollama serve`

# 2. 环境自检：Node / Pi / Ollama / 模型 / whisper / vault / launchd 共 12 项
node bin/cortxtos.ts doctor
# 首跑自动生成 ~/.cortxtos/cortxtos.json；若有 ❌ 按提示修复（如 ollama pull 缺的模型）

# 3. 启动本地 Web 仪表盘（前台运行，Ctrl-C 停止；加 & 或 nohup 可后台）
node bin/cortxtos.ts serve            # 默认端口 8787，可 --port 换端口
# 浏览器打开 http://127.0.0.1:8787 —— 总览/知识库/收集箱管道/维护 四页面
```

### 一键启停脚本（推荐）

不想记上面的步骤，用控制脚本 `scripts/cortxtos-ctl.sh`，一个命令搞定 start/stop/restart/status/log（后台运行、自动写 PID 与日志、内含 nvm 环境修复）：

```bash
./scripts/cortxtos-ctl.sh start        # 后台拉起仪表盘（含自动拉起 JobPilot）
./scripts/cortxtos-ctl.sh status       # 运行状态 / PID / 端口 / HTTP 探测 / 最近日志
./scripts/cortxtos-ctl.sh log          # 实时跟踪日志（Ctrl-C 退出，不影响服务）
./scripts/cortxtos-ctl.sh restart      # 先停再起
./scripts/cortxtos-ctl.sh stop         # 优雅关停（连带 SIGTERM JobPilot 子进程）
# 换端口：各命令后加 --port 9000（PID/日志按端口隔离存于 ~/.cortxtos/）
```

不用 Web 界面时，CLI 也可直接完成全部操作：`search` 检索、`note add` 写笔记、`reindex` 重建索引（见下方 CLI 表）。
首次初始化 vault 分区与 launchd 定时任务用 `node bin/cortxtos.ts init`。

## 停止服务

首选一键脚本（与上面启动配对）：

```bash
./scripts/cortxtos-ctl.sh stop         # 优雅关停仪表盘（连带 SIGTERM 关停 JobPilot 子进程）
./scripts/cortxtos-ctl.sh status       # 确认已停（显示 ⚪ 未运行）
```

手动方式（直接跑 `node … serve` 时）：

```bash
# 1. 前台运行的仪表盘：直接 Ctrl-C（会一并 SIGTERM 关停自动拉起的 JobPilot 子进程）

# 2. 后台运行（&/nohup）时，按端口找到进程再停：
lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill          # 优雅关停（SIGTERM，触发同样的 shutdown）
# 关不掉时再强杀：lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill -9

# 3. 卸载 launchd 定时任务（inbox watcher / 夜间 reindex，init 时挂载的那两个）：
launchctl bootout gui/$(id -u)/com.cortxtos.inbox
launchctl bootout gui/$(id -u)/com.cortxtos.reindex
# 重新启用：cp 对应 plist 到 ~/Library/LaunchAgents/ 后 launchctl bootstrap gui/$(id -u) <plist>（见 init 输出）
```

> 说明：`serve` 只监听 `127.0.0.1`，停主服务不影响 vault 数据与向量索引（均为磁盘文件）；Ollama 是独立服务，如需关闭用 `osascript -e 'quit app "Ollama"'` 或 `pkill ollama`。

### JobPilot 求职工作台（随 serve 自动拉起）

`cortxtos serve` 启动后会自动按需拉起 JobPilot 子服务（实现见 `src/server.ts` 的 `ensureJobpilot()`）：

- **拉起时机**：主服务 listen 后立即探测 `http://127.0.0.1:4318/api/health`；已在运行则复用，否则用当前 node 进程 spawn `jobpilot/server.js` 子进程，最多轮询 5s 等待就绪。前端进入求职页面时也会再调一次（幂等按需重试）。
- **本体目录**：默认 `~/WorkBuddy/2026-11-06-19-14-22/jobpilot`，环境变量可覆盖：
  `CORTXTOS_JP_HOME`（目录）、`CORTXTOS_JP_PORT`（端口，默认 4318）。
- **失败不阻塞**：目录缺失/启动超时只在控制台打 `⚠️ JobPilot 未启动：<原因>`，主仪表盘不受影响。
- **生命周期**：JobPilot 是 serve 的子进程，Ctrl-C 停主服务时会 SIGTERM 一并关停；也可脱离主服务独立跑：`node server.js` 或 `./start.sh`。
- **访问方式**：仪表盘内 iframe 内嵌，或直接浏览器开 http://127.0.0.1:4318；同样是零依赖 `node:http` 只绑 127.0.0.1，数据不出机器。

## CLI

| 命令 | 说明 | 状态 |
|------|------|------|
| `cortxtos doctor` | 自检 Node/Pi/Ollama/模型/内存选档/whisper/vault/launchd，❌ 时非零退出 | ✅ 票 01 |
| `cortxtos init` | 建 vault 四分区 + launchd plist（仅生成，bootstrap 指令打印给用户） | ✅ 票 02 |
| `cortxtos note add` | 按 frontmatter schema 写一篇笔记进 vault | ✅ 票 02 |
| `cortxtos migrate` | 给存量无 frontmatter 的 Markdown 补五字段（支持 `--dry-run`） | ✅ 票 02 |
| `cortxtos search` | 知识库检索：语义+关键字混合命中（输出标注命中方式），tag/type/source/近 N 天过滤；无索引自动退回文件版 | ✅ 票 03/09 |
| `cortxtos reindex` | 向量索引全量重建（本地 embedding 模型；夜间 launchd 任务同源入口） | ✅ 票 09 |
| `cortxtos serve` | 本地 Web 仪表盘（仅 127.0.0.1）：检索/笔记阅读/inbox 预览/doctor 状态/一键重建 | ✅ |

Pi 会话内命令：`/cortxtos` 自检、`/reflect [聚焦方向]` 会话蒸馏沉淀进 daily/（票 06）。

## Web 仪表盘（cortxtos serve）

`cortxtos serve [--port 8787]` 后浏览器打开 `http://127.0.0.1:8787`：侧边导航——**工作台**（doctor 自检与总览）、**AI 对话**（快速/深度双模式智能体，见下节）、**知识库**（混合检索 + 阅读 + 新建笔记）、**任务**（待办清单）、**自动化**（收集箱管道 + launchd 日志）、**求职工作台**、**环境与协作**、**设置**（重建索引 + 存量迁移 dry-run）。
检索命中以 **Markdown 预览**呈现：摘要就地渲染富文本（标题/列表/代码/表格/引用块），检索词黄色高亮；每条命中可点「👁 Markdown 预览」原地展开整篇笔记，也可点开底部阅读面板看全文。
零依赖 `node:http`，**只绑定 127.0.0.1**（本机回环，数据不出机器）；后端直接复用 `searchHybrid` / `gatherChecks` / vault 读取，与 CLI、launchd 管道共享同一数据源。

## AI 对话：快速 / 深度双模式智能体

对话页顶部三态模式条：**纯对话**（Ollama 直连流式）| **🤖 快速**（本地 tool-calling 循环，5 个白名单工具：`kb_search`/`read_note`/`list_notes`/`list_todos`/`save_note`）| **🧠 深度**（代理一个 pi RPC 会话）。三者共用同一个本地模型，**串行互斥**（同时只有一个在跑，抢用返回 409）；模式条旁的状态点提示「启动中 / 就绪 / 推理中 / 等待确认」。

| 能力 | 快速模式 | 深度模式 |
|------|----------|----------|
| 命令执行 | ❌ | ✅ `bash`，浏览器确认卡片后执行 |
| 文件读写 | 只读笔记 + 保存笔记 | ✅ pi 原生 `read/write/edit/bash`，vault 内自主、越界确认 |
| 任务规划 | ❌ | ✅ `update_plan` 工具 + 独立规划面板（进度条 + 勾选步骤） |
| 子 agent 协作 | ❌ | ✅ `run_headless_task` 把批量活委派给无人值守会话（最小版） |
| 定时调度 | — | ✅ launchd 双 plist（inbox watcher + 夜间 reindex），属管道而非对话内能力 |
| 上下文压缩与记忆 | 10 条历史窗口 | ✅ pi 长驻 session + 自动 compaction（事件流提示「上下文压缩中」） |
| 技能加载 | ❌ | ✅ `GET /api/skills` 下拉，选中后以 `pi --skill skills/<name>` 加载（切换会重启会话） |
| worktree 隔离 | ❌ | ❌（vault 不是 git 仓库，无适用对象；将来 `git init` 后另行设计） |
| MCP 插件扩展 | ❌ | ✅ 由 pi 承载，沿用其侧 MCP 配置，本仓库不重造 |

### 深度模式的运行方式

`POST /api/agent/start` 让 serve 拉起 `pi --mode rpc --provider ollama --model <管道模型> --approve` 长驻子进程（cwd = vault，注入 PATH 与 `OLLAMA_MAX_LOADED_MODELS=1`），走 JSONL 双向协议：stdin 写命令、stdout 收事件（`src/agent-session.ts`）。

- **严格 LF 分帧**：手写 Buffer 缓冲按 `0x0A` 切分（Node `readline` 会在 U+2028/U+2029 断行，文档明令禁用）；命令按自增 id 与 `response` 记录关联。
- **单会话 + 空闲回收**：本地单模型不并发，同一时刻最多一个深度会话；空闲 10 分钟自动 dispose；serve 退出钩子里一并 kill。
- **断连不杀进程**：浏览器关掉页面只是摘掉事件出口，回来用同一 sessionId 续聊，会话记忆仍在 pi 侧。
- **事件翻译表**（`translatePiEvent`，纯函数可单测）：`text_delta → {content}`、`tool_execution_start/end → {tool,args}/{tool_result,preview,ok}`、`update_plan → {plan}`、`compaction_* / auto_retry_* → {system}`、`agent_settled → {done}`、进程异常退出 → `{error}`。
- 冷启动是分钟级（17GB 模型加载），故状态点必须区分「启动中」与「推理中」。

### 确认卡片（chat-guard）

`extensions/chat-guard.ts` 在 `tool_call` 拦截器里问用户（RPC 模式下 `ctx.ui.confirm` 自动转成 `extension_ui_request` 发到 stdout，阻塞等前端 `extension_ui_response`）：

1. `bash` **一律确认**；命中 `rm/sudo/mkfs/dd/chmod -R/:(){/kill/reboot/shutdown/git push/launchctl` 时标题升级为「⚠ 高危命令确认」；
2. `write`/`edit` 只在路径解析到 vault 之外才确认（vault 内是笔记本来的，模型自主）；
3. `read`/`ls`/`glob`/`grep` 与本仓库自带低风险工具（`kb_search`、`update_plan`、inbox 管道工具）直接放行，不刷屏；
4. 未知工具（含 MCP 外部能力）默认确认——宁可多问一次。

卡片存在期间 composer 显示「等待你的确认」；**前端 120s 无人点击自动取消，pi 侧 300s 超时自动按拒绝 resolve**，宁拒绝不误放行。被拒时工具结果为 `{block: true, reason}`，模型收到原因后改其他方式或如实说明。无人值守的 launchd 管道继续走 `session-guard` 的无条件白名单，两套安全策略互不干扰。

### 规划面板与技能

多步任务先 `update_plan` 建计划，每完成一步提交全量状态：前端渲染独立规划卡片（原地刷新），后端全量写 `vault/workflows/plan-YYYYMMDD-HHmm.md`（Markdown checkbox，可被 kb_search 检索、断电可恢复）。技能下拉读 `GET /api/skills`（扫 `skills/*/SKILL.md` 的 name+description），选中的技能在 `/api/agent/start` 时以 `--skill skills/<name>` 传给 pi（同一会话内技能不变则复用，变更则重启）；未选中技能时新目录仍由 pi 自动发现。

端到端验收脚本：`python3 scripts/e2e-deep.py "<提示词>" allow|deny|none`（自动应答确认卡片并打印完整 NDJSON 事件流）。

## 向量索引（票 09，二期）

kb_search 无感升级语义检索：问「上次那篇讲上下文压缩的」（不记得关键词）也能命中。

- **存储**：sqlite-vec 单文件索引在 vault 外缓存目录 `~/.cortxtos/index/vault.db`，可随时整体删除重建，无数据主权损失；笔记是真相源，索引只是派生物。
- **更新策略**：定时全量而非增量——`com.cortxtos.reindex` 每日 03:00 launchd 重建；新写入笔记由 `on_note_written()` 钩子记脏标记，重建后生效（doctor 可见）。
- **数据不出机器**：embedding 走本地 Ollama `qwen3-embedding:0.6b`；未拉模型/未建索引时检索自动退回文件版关键字通道，不硬依赖。
- **失败留痕**：重建先写临时库再原子替换，旧索引不受影响；告警痕迹在 `vault/workflows/launchd-reindex.*.log`，doctor 显示上次成功重建时间与待重建笔记数。

## 配置

`~/.cortxtos/cortxtos.json`（或 `CORTXTOS_CONFIG` 指定路径）：档位表 `fast/balanced/heavy/vision/embedding` + fallback 链 + vault 路径 + ASR。全部默认指向本地 Ollama；接入云端 provider 只改此文件不改代码。

Pi 侧的 Ollama 接入在 `~/.pi/agent/models.json` 配置 OpenAI 兼容端点（`http://localhost:11434/v1`，dummy apiKey）。

## 安全：无人值守窄门（票 04）

无人值守会话（`pi -p`/json 模式，或 `CORTXTOS_HEADLESS=1`）由 `extensions/session-guard.ts` 实施双保险：

1. **清单裁剪**：`session_start` 时 `setActiveTools(["read", "write", "kb_search", "list_inbox", "extract_pdf", "transcribe_audio", "archive_inbox"])`——bash/edit 对模型不可见，无从选中；
2. **调用拦截**：`tool_call` 事件对白名单外工具返回 `{block: true, reason}`，防漏网调用，进程不崩。

inbox 管道工具（票 05/07/08：PDF 抽文、图片视觉解读、whisper 音频转写、归档）自身再把路径锁死在 `vault/inbox` 内（路径穿越拒绝、抽取/转写走受控 `execFileSync` 不经 shell），纳入白名单不扩大爆炸半径；抽取正文按数据处理，SKILL.md 明文禁止执行文档内诱导指令。

交互 TUI 会话完全不受影响（`ctx.mode === "tui"` 时守卫不介入）。Web 深度会话是第三种形态：不当作无人值守（因为有人盯着屏幕），改用 `extensions/chat-guard.ts` 的确认闸门——bash 每次都问、越界写入才问、拒绝即 block，详见「AI 对话：快速 / 深度双模式智能体」一节。

**已知残余风险**（接受，见 DESIGN.md §7）：白名单内的 read/write 仍可被恶意 inbox 文件中的 prompt injection 诱导读写 vault 内文件——爆炸半径被约束在 vault 之内（无 shell、无网络工具、无 edit）；纵深防御留给票 05 的路径约束与后续审计日志。

## FAQ

- **`git clone` GitHub 超时**：本机 TLS/HTTP2 握手受扰时，用一次性环境变量降级协议：
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 git clone ...`（不改动全局配置）
- **`node bin/cortxtos.ts` 报未知语法**：确认 `node -v` ≥ 22.18（原生 TypeScript type stripping）
- **watcher 与 TUI 抢模型**：Ollama 固定 `OLLAMA_MAX_LOADED_MODELS=1`，异步任务排队是设计行为
- **launchd 报 `command not found: pi`**：launchd 起的 zsh 是非交互壳，不读 `.zshrc`（nvm 在那里初始化）；inbox plist 已改为显式注入 `PATH=<node bin 目录>:/opt/homebrew/bin`，重新 `cortxtos init` 生成即可
- **`brew install` 报 `undefined method '[]' for nil`（load_tab）**：brew 进程版本与 bottle 元数据格式不匹配，先 `brew update` 再重装
- **深度模式 500「启动失败」**：`pi --mode rpc` 依赖本机 pi CLI 与 `~/.pi/agent/models.json` 里的 Ollama provider；先用 `pi --list-models` 确认模型可达，或用 `CORTXTOS_PI=/path/to/pi` 指定可执行文件（serve 默认在 `node` 同目录与 `PATH` 里找 `pi`）
- **深度模式 409**：本地单模型串行，快速对话或 inbox 管道正在跑；等它结束再开启（反向也成立：深度本轮未收尾前，快速对话与管道会被拒）

## License

MIT

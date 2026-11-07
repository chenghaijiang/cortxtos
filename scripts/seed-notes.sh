#!/bin/bash
# 票 09 验收素材：批量补笔记至 ≥30 篇（主题多样，供语义 vs 关键字对比评测）
set -e
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh && nvm use 22.23.4 >/dev/null

count=$(find ~/cortxt-vault/notes ~/cortxt-vault/daily -name "*.md" | wc -l | tr -d ' ')
echo "当前笔记数：$count"

add() { # add <title> <tags> <body>
  node bin/cortxtos.ts note add --title "$1" --tags "$2" --body "$3" >/dev/null
}

add "上下文窗口压缩实验记录" "llm,context" "测试超过三十二轮对话后对早期轮次做摘要压缩，保留最近八轮原文。压缩后任务成功率从百分之六十一提升到百分之八十九，成本下降约四成。结论：滚动摘要比一次性截断更稳，丢失的信息可以在知识库检索里补回来。"
add "向量数据库选型备忘" "rag,index" "对比了本地可跑的几种方案：sqlite-vec 单文件零运维最适合个人工作台；LanceDB 列式存储适合大数据量；chroma 原型快但长期维护存疑。个人知识库规模在万篇以内，用 sqlite-vec 加定时全量重建完全够用，不需要增量同步的复杂度。"
add "RAG 分块策略笔记" "rag,chunking" "按标题和空行分段，块大小三百到六百字符之间召回质量最好。太短丢上下文，太长稀释语义密度。给每个块前置文档标题可以显著提升「这篇讲什么的」类查询的命中率，等于给向量加了个语义锚。"
add "香蕉奶昔配方" "food" "香蕉一根，牛奶两百毫升，一小勺蜂蜜，破壁机三十秒。冷冻香蕉口感更像奶昔，夏天可以加几块冰块。打久了会分层，尽快喝完。"
add "全麦欧包失败复盘" "food,baking" "含水量过高导致面团粘手整形困难，二发时间不足组织太密。下次记录：水温控制在三十四度，折叠时每二十分钟一次共三次，烤箱提前二百度预热，石板要一起预热。"
add "酸种面包培养日志" "food,baking" "第五天开始有明显气泡和酒香味，弃种比例一比一继续喂。面粉换了黑全麦产气更旺。预计本周可以做第一锅，目标含水量七成五。"
add "季度财务分析要点" "finance,work" "本季度营收环比增长十二个百分点，毛利率持平在四成一。增长主要来自企业订阅业务，续费率百分之九十三。下季度风险点：获客成本上升明显，CAC 回收期从八个月拉长到十一个月，需要观察渠道结构变化。"
add "会议纪要：产品例会" "work,meeting" "讨论了搜索改版排期，共识是先做混合检索再评估纯语义替换成本。设计侧希望本周给出空状态和加载态的规范文案。遗留问题：移动端离线缓存策略未定，需要客户端同学下周给方案。"
add "k8s 滚动升级踩坑" "devops" "maxUnavailable 设成百分之五十导致流量高峰期容量骤减。回滚姿势：kubectl rollout undo 只回 Deployment 模板，ConfigMap 变更要单独 apply。健康检查探针超时过短会误杀慢启动的 JVM 服务，initialDelaySeconds 要给足。"
add " cervical spine 康复计划" "health" "每天两次米字操，久坐四十五分钟强制起身。游泳姿势优先蛙泳，避免抬头蝶泳。枕头高度压到一拳，显示器上沿与视线齐平。两周复评一次，疼痛不减要拍核磁。"
add "颈椎康复第 21 天自评" "health" "低头久坐后酸痛发作频率从每天降到每周两三次，游泳坚持了六次。靠墙站立收下巴训练有效。复查建议仍是改善用机姿势为主，热敷辅助。"
add "家用 NAS 组网记录" "homelab,network" "软路由旁挂一台四盘位 NAS，万兆内网直连剪辑机。备份策略三二一：三份数据两种介质一份异地。照片库走 Immich，AI 识别全部本地跑 OpenCL 加速，不上传任何云端。"
add "Homelab 电费估算" "homelab" "NAS 待机十八瓦，软路由十二瓦，工作站每天开机四小时。全年合计约一百五十度电，按峰谷平均电价合每月三十元出头，比云存储三年回本快。"
add "SGLang 与 vLLM 吞吐对比" "llm,inference" "同一台 M4 机器模拟测了两种框架的本地推理服务：vLLM 显存管理成熟但 Apple 平台支持一般，MLX-LM 生态在苹果芯片上更快。个人工作台并发低，选型主要看稳定性与维护成本。"
add "Ollama 模型固定内存技巧" "llma,ollama" "OLLAMA_KEEP_ALIVE 设成模型常驻避免冷启动，但内存有限时要把 MAX_LOADED_MODELS 压到一，防止两变大模型同时驻留内存交换区。无人值守管道跑完就卸载，人机对话时才热着。"
add "个人知识管理心法" "pkms" "笔记是写给未来的自己看的邮件，标题要包含场景而不是主题。「上下文压缩」不如「为什么对话超过三十轮就变笨」。标签宁缺毋滥，超过十五个标签等于没有标签。每季度做一次归档修剪。"
add "Markdown 前置元数据规范" "pkms,schema" "统一五字段：title、tags、created、source、type。source 记录素材从哪来（手动、PDF、图片、音频、会话沉淀），type 记录笔记形态。历史笔记用迁移脚本按规则补齐，新笔记必须走统一写入口。"
add "Lanchd 定时任务运维笔记" "macos,devops" "WatchPaths 触发型任务排查三步：看 err 日志、launchctl print 状态、kickstart 手动触发复现。非交互 shell 不读 rc 文件，PATH 必须在命令里显式导出。ThrottleInterval 防抖对崩溃循环很重要。"
add " espresso 手冲参数记录" "food,coffee" "豆子：埃塞日晒。粉水比一比十五，水温九十度，研磨中细。闷蒸四十秒，总萃取两分十秒。偏酸就提水温到九十二度或延长闷蒸，苦感重则降研磨细度前先试水温。"
add "无人值守管道的安全边界" "security,agent" "工具白名单窄门原则：只给读写和检索类工具，禁用 bash 和 edit。路径锁死在收集箱目录内，任何越界解析直接拒绝。把外部文档正文当数据而不是指令，提示注入防御写进流程规范。"

count=$(find ~/cortxt-vault/notes ~/cortxt-vault/daily -name "*.md" | wc -l | tr -d ' ')
echo "补齐后笔记数：$count"

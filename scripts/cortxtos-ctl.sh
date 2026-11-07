#!/bin/bash
# CortxtOS 一键启动/停止控制脚本
#   用法：scripts/cortxtos-ctl.sh <start|stop|restart|status|log> [--port 8787]
#   - start   后台拉起 Web 仪表盘（nohup），写 PID 与日志，随主服务自动拉起 JobPilot 子服务
#   - stop    按 PID 优雅关停（SIGTERM，触发 server.ts 里的 shutdown：一并 SIGTERM JobPilot）
#   - restart 先停再起
#   - status  显示运行状态、PID、端口、健康探测、最近日志
#   - log     实时跟踪日志（Ctrl-C 退出跟踪，不影响服务）
# 约定：PID/日志放在 ~/.cortxtos/ 下；Node ≥22.19 原生跑 .ts，无构建步骤。
set -e
cd "$(dirname "$0")/.."

# ---- 参数解析 ----
CMD="${1:-}"
shift || true
PORT="8787"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-8787}"; shift 2 ;;
    *) shift ;;
  esac
done

RUN_DIR="${CORTXTOS_HOME:-$HOME/.cortxtos}"
PID_FILE="$RUN_DIR/serve.$PORT.pid"
LOG_FILE="$RUN_DIR/serve.$PORT.log"
URL="http://127.0.0.1:$PORT"

# ---- 确保 node 在 PATH（launchd/非交互壳不读 .zshrc 的教训同样适用于本脚本）----
ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
      # shellcheck disable=SC1091
      source "$HOME/.nvm/nvm.sh" && nvm use 22.23.4 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1
    fi
  fi
  command -v node >/dev/null 2>&1 || { echo "❌ 未找到 node，请安装 Node ≥22.19 或配置 nvm"; exit 1; }
}

# 返回正在监听的 PID（可能多个，空格分隔）；无则空
listening_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

alive() {
  # 优先看 PID 文件，其次看端口监听
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi
  fi
  [ -n "$(listening_pid)" ]
}

do_start() {
  ensure_node
  mkdir -p "$RUN_DIR"
  if alive; then
    echo "ℹ️  仪表盘已在运行（端口 $PORT），无需重复启动 → $URL"
    return 0
  fi
  echo "🚀 正在后台启动 cortxtos serve（端口 $PORT）…"
  nohup node bin/cortxtos.ts serve --port "$PORT" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  # 等待就绪（最多 ~8s）
  for _ in $(seq 1 32); do
    if curl -s --max-time 1 -o /dev/null "$URL" 2>/dev/null; then
      echo "✅ 已启动：$URL  （PID $(cat "$PID_FILE")，日志 $LOG_FILE）"
      echo "   停止：$0 stop --port $PORT"
      return 0
    fi
    sleep 0.25
  done
  echo "⚠️  启动未在预期时间内探测到端口，请查看日志：tail -n 40 $LOG_FILE"
  return 1
}

do_stop() {
  local pid=""
  [ -f "$PID_FILE" ] && pid="$(cat "$PID_FILE")"
  [ -z "$pid" ] && pid="$(listening_pid)"
  if [ -z "$pid" ]; then
    echo "ℹ️  没有正在运行的仪表盘（端口 $PORT）"
    rm -f "$PID_FILE" 2>/dev/null || true
    return 0
  fi
  echo "🛑 优雅关停（SIGTERM）：PID $pid"
  kill $pid 2>/dev/null || true
  # 等待退出（最多 ~5s）
  for _ in $(seq 1 20); do
    if ! alive; then
      rm -f "$PID_FILE" 2>/dev/null || true
      echo "✅ 已停止"
      return 0
    fi
    sleep 0.25
  done
  echo "⚠️  仍未退出，强制终止（SIGKILL）"
  kill -9 $pid 2>/dev/null || true
  rm -f "$PID_FILE" 2>/dev/null || true
  echo "✅ 已停止"
}

do_status() {
  if alive; then
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || listening_pid)"
    echo "🟢 运行中 · 端口 $PORT · PID ${pid:-?} · $URL"
    curl -s --max-time 2 -o /dev/null -w "   HTTP 探测：%{http_code}\n" "$URL/" 2>/dev/null || true
  else
    echo "⚪ 未运行（端口 $PORT）"
  fi
  [ -f "$LOG_FILE" ] && { echo "— 最近日志 —"; tail -n 8 "$LOG_FILE"; } || true
}

case "$CMD" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  log)
    [ -f "$LOG_FILE" ] || { echo "暂无日志：$LOG_FILE"; exit 0; }
    echo "📜 跟踪日志（Ctrl-C 退出，不影响服务）：$LOG_FILE"
    tail -f "$LOG_FILE"
    ;;
  *)
    cat <<EOF
CortxtOS 服务控制脚本

用法：$0 <命令> [--port 8787]

命令：
  start     后台启动 Web 仪表盘（自动拉起 JobPilot 子服务）
  stop      停止仪表盘（优雅关停，连带子进程）
  restart   先停再起
  status    查看运行状态 / PID / 端口 / 最近日志
  log       实时跟踪日志（Ctrl-C 退出）

示例：
  $0 start                    # 默认端口 8787
  $0 start --port 9000        # 换端口
  $0 status
  $0 stop
EOF
    exit 1
    ;;
esac

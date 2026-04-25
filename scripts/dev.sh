#!/usr/bin/env bash
# 一键起本地前后端：FastAPI :8080（不连真房间）+ Vite :5173（代理 /api 到本地）
# Ctrl-C 同时杀两边。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f venv/bin/activate ]]; then
  echo "找不到 venv/bin/activate，先 python3 -m venv venv && pip install -r requirements.txt"
  exit 1
fi

# 1) 后端后台跑
# shellcheck disable=SC1091
source venv/bin/activate
python monitor.py --port 8080 --no-listen &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 2) 前端前台跑（Ctrl-C 落到这里 → 触发 trap → 杀后端）
cd frontend
VITE_PROXY_TARGET=http://localhost:8080 exec npm run dev

#!/usr/bin/env bash
# 只起 Vite :5173，/api /ws /static 全代理到线上 blackbubu.us。
# 适合纯改前端不想拉本地后端的场景。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"
exec npm run dev -- --host

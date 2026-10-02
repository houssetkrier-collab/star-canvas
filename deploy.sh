#!/bin/sh
# 星彩绘图台 · 一键部署到 Cloudflare（macOS / Linux）
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js（https://nodejs.org，LTS 版本）"; exit 1; }
exec node tools/deploy.mjs "$@"

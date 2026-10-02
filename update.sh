#!/bin/sh
# 星彩绘图台 · 一键更新（macOS / Linux）：合并原作者 GitHub 上的新版本并部署
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js（https://nodejs.org，LTS 版本）"; exit 1; }
exec node tools/update.mjs "$@"

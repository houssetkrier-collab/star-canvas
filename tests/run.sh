#!/bin/bash
# 本地回归测试：假上游 + wrangler dev（本地 D1/R2）+ API 断言。不会访问真实上游、不消耗 Gems。
# 用法（仓库根目录）：bash tests/run.sh      需要 Node 18+，首次会通过 npx 下载 wrangler
# 已装 wrangler 可指定：WRANGLER_BIN=wrangler bash tests/run.sh
set -u
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false CI=1 NO_PROXY="127.0.0.1,localhost,${NO_PROXY:-}" no_proxy="127.0.0.1,localhost,${no_proxy:-}"
TMP=$(mktemp -d)
cp -r worker public migrations wrangler.jsonc "$TMP"/
printf 'APP_ACCESS_KEY=test-admin-key\n' > "$TMP/.dev.vars"
node tests/mock-upstream.js > "$TMP/mock.log" 2>&1 & MOCK=$!
( cd "$TMP" && ${WRANGLER_BIN:-npx -y wrangler@4} d1 migrations apply yesnai-studio --local > migr.log 2>&1 ) || { tail "$TMP/migr.log"; kill $MOCK; exit 1; }
( cd "$TMP" && exec ${WRANGLER_BIN:-npx -y wrangler@4} dev --port 8787 --ip 127.0.0.1 --var YESNAI_BASE:http://127.0.0.1:8790 > dev.log 2>&1 ) & DEV=$!
for i in $(seq 1 90); do sleep 1; curl -s -m 2 -o /dev/null 127.0.0.1:8787/api/session && break; done
node tests/worker.test.mjs; code=$?
kill $DEV $MOCK 2>/dev/null; pkill -P $DEV 2>/dev/null
[ -n "${KEEP_TMP:-}" ] && echo "保留临时目录：$TMP" || rm -rf "$TMP"   # KEEP_TMP=1 时保留，便于看 dev.log
exit $code

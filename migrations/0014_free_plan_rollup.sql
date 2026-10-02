-- 0014: 免费计划优化（D1 每天 500 万行读取额度）
-- 1) 统计页改读按天汇总表：原来每次打开统计页都要扫 7~30 天的全部请求日志（每天 1000 次请求时一次 18 万行）
CREATE TABLE IF NOT EXISTS stats_daily (
  date TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  account_id INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  gems REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model, account_id)
);
INSERT OR IGNORE INTO stats_daily(date,model,account_id,requests,ok,gems,duration_ms)
  SELECT substr(created_at,1,10), COALESCE(model,''), COALESCE(account_id,0), COUNT(*), COALESCE(SUM(ok),0), COALESCE(SUM(cost_gems),0), COALESCE(SUM(duration_ms),0)
  FROM request_logs GROUP BY 1,2,3;
-- 2) 「最近失败」只扫失败记录
CREATE INDEX IF NOT EXISTS request_logs_failed_idx ON request_logs(created_at DESC) WHERE ok=0;
-- 3) 广场「最热」排序走索引，不再全表排序
CREATE INDEX IF NOT EXISTS gallery_public_likes_idx ON gallery(public, like_count DESC, published_at DESC);

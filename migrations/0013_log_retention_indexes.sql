-- 0013: 日志定期清理所需索引（cron 按时间分批删除过期的重试记录 / 签到日志）
CREATE INDEX IF NOT EXISTS request_attempts_created_idx ON request_attempts(created_at);
CREATE INDEX IF NOT EXISTS daily_usage_date_idx ON daily_usage(usage_date);

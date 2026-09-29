-- 0011: 自动购买图包（默认关闭）——签到完成后按阈值补购 1 个图包
ALTER TABLE autocheckin_config ADD COLUMN autobuy_enabled INTEGER DEFAULT 0;
ALTER TABLE autocheckin_config ADD COLUMN autobuy_threshold INTEGER DEFAULT 8;

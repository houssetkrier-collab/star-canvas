-- 0012：审查修复——多槽签到按天集合 + 账号用户名唯一
ALTER TABLE accounts ADD COLUMN attempt_slots TEXT NOT NULL DEFAULT '[]';
ALTER TABLE accounts ADD COLUMN success_slots TEXT NOT NULL DEFAULT '[]';
-- 同名重复账号仅保留最早一条（唯一索引的前提；重复行本就是缺陷产生的冗余）
DELETE FROM accounts WHERE id NOT IN (SELECT MIN(id) FROM accounts GROUP BY username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

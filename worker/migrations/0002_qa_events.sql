-- 阈值再标定用的观测表（终审 I4）。只记当天、类型、top1 分数和时间，绝不存问题文本。
-- 隐私口径与 usage_log 一致。查询示例：SELECT day, type, count(*), avg(top1) FROM qa_events GROUP BY day, type;
CREATE TABLE IF NOT EXISTS qa_events (
  day TEXT,
  type TEXT,
  top1 REAL,
  at TEXT
);

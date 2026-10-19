-- Numbers each day's login budget rows. Counting today's rows read every one
-- of them: once the budget was spent, each refused request still read about
-- 200 rows, so about 25,000 junk requests a day could use up D1's Free plan
-- reads (5 million a day) and stop the whole bank until 00:00 UTC. With its
-- place in the day stored in the row, the check reads only the day's top row.
--
-- Dropped and recreated rather than altered: the table isn't bank data, isn't
-- backed up, and only today's rows matter. On the day this is applied, the
-- day's count starts again.
DROP TABLE login_budget;

CREATE TABLE login_budget (
  day TEXT NOT NULL,     -- UTC date, YYYY-MM-DD
  n   INTEGER NOT NULL,  -- its place in the day, from 1 up to the budget
  PRIMARY KEY (day, n)
) STRICT;

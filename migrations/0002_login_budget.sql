-- Daily budget for the requests anyone can send without logging in that write
-- to KV: the consent page (GET /authorize) and client registration (POST
-- /oauth/register). KV's Free plan allows 1,000 writes a day, and token
-- refreshes for connected apps need some of them, so these requests get at
-- most a fixed share per UTC day (issue #8). One row per request; nothing
-- reads the rows except the day's count.
CREATE TABLE login_budget (
  day TEXT NOT NULL  -- UTC date, YYYY-MM-DD
) STRICT;

CREATE INDEX login_budget_day ON login_budget (day);

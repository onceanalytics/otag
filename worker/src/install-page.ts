/**
 * The install page, served at /.
 *
 * It is an installation check and a set of queries to copy, not a dashboard.
 * Two numbers: how many events have arrived, and when the last one did. Adding
 * a third is how this becomes a dashboard, which is the paid product.
 *
 * The page is public: the event count is visible to anybody who opens the
 * endpoint's root.
 */

import type { Env } from './ingest';

interface Status {
  total: number;
  last: string | null;
  ready: boolean;
}

async function readStatus(db: D1Database): Promise<Status> {
  try {
    // A COUNT over the whole table. The page is opened by hand a few times,
    // not by traffic, so the read is cheap in practice.
    const row = await db
      .prepare('SELECT COUNT(*) AS total, MAX(created_at) AS last FROM events')
      .first<{ total: number; last: string | null }>();
    return { total: row?.total ?? 0, last: row?.last ?? null, ready: true };
  } catch {
    // Almost always the migration has not run yet.
    return { total: 0, last: null, ready: false };
  }
}

export async function installPage(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const status = await readStatus(env.DB);

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>otag</title>
<style>
  :root { --bg:#F6F3ED; --ink:#1F211D; --muted:#75786E; --border:#DFDACE; --live:#E09411; --teal:#145148; }
  * { box-sizing:border-box; margin:0; padding:0 }
  body { background:var(--bg); color:var(--ink); padding:48px 24px 96px;
         font:16px/1.6 ui-sans-serif,system-ui,sans-serif; -webkit-font-smoothing:antialiased }
  main { max-width:760px; margin:0 auto }
  h1 { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:34px; letter-spacing:-.02em }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.14em; color:var(--muted);
       margin:48px 0 14px; font-weight:600 }
  p { margin:0 0 14px; max-width:68ch }
  a { color:var(--teal) }
  pre { background:#fff; border:1px solid var(--border); border-radius:8px; padding:16px 18px;
        overflow-x:auto; font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; margin:0 0 16px }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
  .status { display:flex; align-items:center; gap:12px; margin:22px 0 8px;
            font:15px/1 ui-monospace,SFMono-Regular,Menlo,monospace }
  .dot { width:10px; height:10px; border-radius:50%; flex:none;
         background:${status.total > 0 ? 'var(--live)' : 'var(--border)'};
         box-shadow:${status.total > 0 ? '0 0 0 4px rgba(224,148,17,.18)' : 'none'} }
  .muted { color:var(--muted) }
  .note { border-left:2px solid var(--border); padding-left:16px; color:var(--muted); margin:0 0 16px }
</style>
</head><body><main>

<h1>otag</h1>
<p class="muted">Collecting into your own D1 database. Nothing else runs here.</p>

<div class="status"><span class="dot"></span>
${
  status.ready
    ? `<span>${status.total.toLocaleString('en-US')} events</span>
       <span class="muted">${status.last ? `last at ${status.last} UTC` : 'none yet'}</span>`
    : `<span>Database not initialised</span>`
}
</div>
${
  status.ready
    ? ''
    : `<p class="note">The <code>events</code> table is missing. Run
       <code>npx wrangler d1 migrations apply DB --remote</code> from the
       <code>worker</code> directory.</p>`
}

<h2>Add the script</h2>
<pre>&lt;script src="${origin}/script.js" defer&gt;&lt;/script&gt;</pre>
<p>One tag, on every page. It posts to <code>${origin}/t</code>, which it works
out from its own <code>src</code>, so there is nothing to configure.</p>
<p>The same tag on several sites is fine. Each event records the hostname it came
from as <code>site_id</code>, lowercased and without <code>www.</code> or a port,
so the sites separate themselves and nothing needs listing here.</p>

<h2>Read it with SQL</h2>
<p>Create an API token with <strong>D1 Read</strong> permission, and find the
database id under Workers &amp; Pages → D1 in the Cloudflare dashboard. Then:</p>
<pre>API=https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1

curl -X POST "$API/database/$DATABASE_ID/query" \\
  -H "Authorization: Bearer $D1_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"sql":"SELECT COUNT(*) FROM events"}'</pre>

<h2>Queries to start from</h2>
<pre>-- which sites are landing here
SELECT site_id, COUNT(*) AS events, MAX(created_at) AS last
FROM events GROUP BY site_id ORDER BY events DESC;

-- pageviews a day, last 30 days
SELECT date(created_at) AS day, COUNT(*) AS views
FROM events
WHERE event_name = 'page_view' AND is_bot = 0
  AND created_at &gt;= datetime('now', '-30 days')
GROUP BY day ORDER BY day;

-- top pages, for one site
SELECT page_path, COUNT(*) AS views
FROM events
WHERE site_id = 'example.com'
  AND event_name = 'page_view' AND is_bot = 0
  AND created_at &gt;= datetime('now', '-30 days')
GROUP BY page_path ORDER BY views DESC LIMIT 20;

-- where people came from, excluding your own pages
SELECT COALESCE(referrer, 'direct') AS source, COUNT(*) AS views
FROM events
WHERE event_name = 'page_view' AND is_bot = 0
  AND created_at &gt;= datetime('now', '-30 days')
GROUP BY source ORDER BY views DESC LIMIT 20;

-- what happened besides pageviews
SELECT event_name, COUNT(*) AS n
FROM events
WHERE is_bot = 0 AND created_at &gt;= datetime('now', '-30 days')
GROUP BY event_name ORDER BY n DESC;

-- visitors on one day
SELECT COUNT(DISTINCT visitor_hash) AS visitors
FROM events
WHERE is_bot = 0 AND date(created_at) = date('now');</pre>

<h2>What the data will not tell you</h2>
<p><strong>Visitor hashes rotate at UTC midnight.</strong> They are
<code>SHA-256(ip | user-agent | site | date | salt)</code>, so counting distinct
hashes works within one day and not across several. A 30-day
<code>COUNT(DISTINCT visitor_hash)</code> counts visitor-days, not people.</p>
<p><strong>There are no sessions.</strong> Events carry timestamps and a daily
identity; grouping them into visits is something a query does, and different
queries will disagree.</p>
<p><strong>Your sites do not share identities.</strong> The site is part of the
hash, so one person visiting two of them on the same day appears as two unrelated
hashes. Counting per site is exactly right; counting people across sites is not
something this data can do.</p>

<h2>Limits worth knowing before you query a lot</h2>
<p>On Cloudflare's free plan, going over the daily D1 read allowance blocks
every query on the account, <strong>including the insert on this endpoint</strong>.
Collection stops until 00:00 UTC. An agent looping thirty-day scans is the
quickest way there, so filter on <code>created_at</code> and select the columns
you need.</p>
<p class="muted">Free plan: 5,000,000 rows read and 100,000 rows written a day,
which is roughly 23,000 pageviews a day with the index this ships with. Above
that, Cloudflare's paid plan is $5 a month for the whole account.</p>

<h2>When you want reports instead of queries</h2>
<p><a href="https://onceanalytics.com">Once Analytics</a> reads this same
database. The <code>events</code> table is the same table, so upgrading points
a different worker at the data you already have.</p>

</main></body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

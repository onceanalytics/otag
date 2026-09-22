/**
 * The install page, served at /.
 *
 * An installation check and a set of queries to copy, not a dashboard. Two
 * numbers: how many events have arrived, and when the last one did. Adding a
 * third is how this becomes a dashboard, which is the paid product.
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
  const url = new URL(request.url);
  const origin = url.origin;
  const status = await readStatus(env.DB);

  // On workers.dev the script and its beacons are cross-site from the tracked
  // page, which is the pattern content blockers match. This is the default
  // state after a one-click deploy, so it is said here rather than in the docs.
  const isWorkersDev = url.hostname.endsWith('.workers.dev');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>otag</title>
<style>
  :root { --bg:#F6F3ED; --ink:#1F211D; --muted:#6B6E64; --border:#DFDACE;
          --code:#FBFAF7; --live:#E09411; --link:#145148; }
  * { box-sizing:border-box }
  body { margin:0 auto; padding:40px 20px 80px; max-width:800px; background:var(--bg);
         color:var(--ink); line-height:1.55; font-size:16px;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         -webkit-font-smoothing:antialiased }
  h1 { font-size:2em; margin:0 0 16px; padding-bottom:.3em; border-bottom:1px solid var(--border) }
  h2 { font-size:1.4em; margin:32px 0 16px; padding-bottom:.3em; border-bottom:1px solid var(--border) }
  p { margin:0 0 16px }
  a { color:var(--link) }
  code { background:rgba(31,33,29,.06); padding:.2em .4em; border-radius:6px; font-size:85%;
         font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
  pre { background:var(--code); border:1px solid var(--border); border-radius:6px;
        padding:16px; overflow:auto; line-height:1.45; font-size:85%;
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
  pre code { background:none; padding:0; font-size:100% }
  ul { margin:0 0 16px; padding-left:24px }
  li { margin:4px 0 }
  .status { display:flex; align-items:center; gap:10px; margin:0 0 24px; font-size:15px }
  .dot { width:10px; height:10px; border-radius:50%; flex:none;
         background:${status.total > 0 ? 'var(--live)' : 'var(--border)'} }
  .muted { color:var(--muted) }
  .note { border-left:4px solid var(--live); background:rgba(224,148,17,.08);
          padding:12px 16px; border-radius:0 6px 6px 0; margin:0 0 24px }
  .note.tip { border-left-color:var(--link); background:rgba(20,81,72,.06) }
  .note p:last-child { margin:0 }
  footer { margin-top:56px; padding-top:24px; border-top:1px solid var(--border);
           text-align:center; font-size:15px }
</style>
</head><body>

<h1>otag</h1>

${
  status.ready
    ? `<div class="status"><span class="dot"></span>
       <span>${status.total.toLocaleString('en-US')} events</span>
       <span class="muted">${status.last ? `last at ${status.last} UTC` : 'none yet'}</span>
       </div>`
    : `<div class="note"><p><strong>Database not initialised.</strong> The <code>events</code>
       table is missing. Run <code>npx wrangler d1 migrations apply DB --remote</code> from the
       <code>worker</code> directory.</p></div>`
}

${
  isWorkersDev
    ? `<div class="note tip"><p><strong>This is a <code>workers.dev</code> address.</strong>
       otag works best served from the domain it tracks: on a shared address the script and its
       requests are third-party, which is what content blockers match. Add a custom domain such
       as <code>analytics.yourdomain.com</code>, on a domain in your Cloudflare account.</p></div>`
    : ''
}

<h2>Add the script</h2>

<pre><code>&lt;script src="${origin}/script.js" defer&gt;&lt;/script&gt;</code></pre>

<p>One tag, on every page. It posts to <code>${origin}/t</code>, worked out from its own
<code>src</code>.</p>

<p>The same tag on several sites is fine. Each event records the hostname it came from as
<code>site_id</code>, lowercased and without <code>www.</code> or a port, so the sites separate
themselves.</p>

<h2>Read it with SQL</h2>

<p>Create an API token with <strong>D1 Read</strong> permission, and find the database id under
Workers &amp; Pages &rarr; D1 in the Cloudflare dashboard.</p>

<pre><code>API=https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1

curl -X POST "$API/database/$DATABASE_ID/query" \\
  -H "Authorization: Bearer $D1_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"sql":"SELECT COUNT(*) FROM events"}'</code></pre>

<h2>Queries</h2>

<pre><code>-- which sites are landing here
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
WHERE is_bot = 0 AND date(created_at) = date('now');</code></pre>

<h2>Limits</h2>

<ul>
  <li>Cloudflare's free plan allows 5,000,000 rows read and 100,000 rows written a day.
      Going over either blocks every D1 query on the account until 00:00 UTC,
      <strong>including the insert on this endpoint</strong>. Filter on
      <code>created_at</code>.</li>
  <li>100,000 rows written is about 23,000 pageviews a day with the index this ships with.
      Above that, Cloudflare's paid plan is $5 a month for the whole account.</li>
  <li><code>visitor_hash</code> rotates at 00:00 UTC, so
      <code>COUNT(DISTINCT visitor_hash)</code> counts people within one day and visitor-days
      across several.</li>
</ul>

<footer><a href="https://onceanalytics.com/">onceanalytics.com</a></footer>

</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

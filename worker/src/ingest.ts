/**
 * The write path: one POST in, one row out.
 *
 * Identity is the daily-rotating hash and nothing else. Once Analytics offers
 * four privacy modes and picks per site; here there is one, so there is no
 * setting to read and no lookup before the insert.
 */

import {
  normaliseHostname,
  generateVisitorHash,
  cleanReferrer,
  parseUserAgent,
  parseUtmParams,
  detectBot,
  redactSensitiveParams,
} from './utils';

const OPT_OUT_COOKIE = 'oa_optout';

/** Matches PRIVACY_MODES.DAILY in Once Analytics. Stored per event, so rows read correctly there. */
const PRIVACY_MODE_DAILY = 1;

export interface Env {
  DB: D1Database;
}

/**
 * otag's payload. `c`, the consent state, arrives on every event and is not
 * stored: with one privacy mode there is no decision for it to change.
 */
interface TrackingPayload {
  e: string;
  p: string;
  d?: string;
  r?: string;
  b?: Record<string, unknown>;
}

/**
 * The salt, cached for the life of the isolate.
 *
 * It is generated on first request rather than configured, which is what makes
 * the one-click deploy ask for nothing. `INSERT OR IGNORE` then re-read settles
 * the race when several requests arrive before any of them has written.
 */
let cachedSalt: string | null = null;

async function getSalt(db: D1Database): Promise<string> {
  if (cachedSalt) return cachedSalt;

  const existing = await db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .bind('hash_salt')
    .first<{ value: string }>();
  if (existing?.value) {
    cachedSalt = existing.value;
    return cachedSalt;
  }

  const fresh = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await db
    .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .bind('hash_salt', fresh)
    .run();

  const settled = await db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .bind('hash_salt')
    .first<{ value: string }>();
  cachedSalt = settled?.value ?? fresh;
  return cachedSalt;
}

export async function handleTrack(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin') || undefined;

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'POST required' }, 405, origin);
  }

  if ((request.headers.get('Cookie') || '').includes(`${OPT_OUT_COOKIE}=1`)) {
    return json({ ok: true, excluded: true }, 200, origin);
  }

  let payload: TrackingPayload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false }, 400, origin);
  }

  const { e: eventName, p: pagePath, d: pageHostname, r: referrer, b: eventData } = payload;
  if (!eventName || !pagePath) {
    return json({ ok: false }, 400, origin);
  }

  // The site is the website's own hostname, never the collector's. otag sends it
  // on every event as `d`, so pointing one endpoint at several sites separates
  // them with no configuration. The endpoint's own hostname is the fallback for
  // anything that is not otag and sends no `d`.
  //
  // Once Analytics resolves the same value, and refuses a hostname that is not
  // listed on one of its sites. There is no list here, so whatever arrives is
  // written: it is your account and your rows.
  const endpointHost = normaliseHostname(new URL(request.url).hostname);
  const siteId = normaliseHostname(pageHostname) || endpointHost;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const userAgent = request.headers.get('User-Agent') || '';
  const country = request.headers.get('CF-IPCountry') || null;

  const salt = await getSalt(env.DB);
  const visitorHash = await generateVisitorHash(ip, userAgent, siteId, salt);

  const ua = parseUserAgent(userAgent);
  const bot = detectBot(userAgent);

  // A referrer from one of the site's own pages is navigation, not a source.
  const ownHostnames = [siteId, endpointHost].filter(Boolean);

  // The path is stored as it arrived, with sensitive values redacted. Grouping
  // is a query-time decision, so a rule can change later and still apply to
  // everything already collected.
  const utm = parseUtmParams(pagePath);

  try {
    await env.DB.prepare(
      `INSERT INTO events (site_id, visitor_hash, event_name, page_path, referrer, country, browser, os, device, is_bot, privacy_mode, utm_source, utm_medium, utm_campaign, utm_term, utm_content, event_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        siteId,
        visitorHash,
        eventName,
        redactSensitiveParams(pagePath),
        referrer ? cleanReferrer(referrer, ownHostnames) : null,
        country,
        bot.isBot ? bot.botName : ua.browser,
        bot.isBot ? null : ua.os,
        bot.isBot ? null : ua.device,
        bot.isBot ? 1 : 0,
        PRIVACY_MODE_DAILY,
        utm.utmSource,
        utm.utmMedium,
        utm.utmCampaign,
        utm.utmTerm,
        utm.utmContent,
        eventName === 'page_view' || !eventData ? null : JSON.stringify(eventData)
      )
      .run();
  } catch (error) {
    // Most often this is the daily D1 limit on the free plan, which blocks
    // every query on the account including this insert. See the README.
    console.error('insert failed', error);
    return json({ ok: false }, 500, origin);
  }

  return json({ ok: true }, 200, origin);
}

export function handleOptOut(request: Request): Response {
  const isOptedOut = (request.headers.get('Cookie') || '').includes(`${OPT_OUT_COOKIE}=1`);

  if (request.method === 'POST') {
    const next = !isOptedOut;
    const cookie = next
      ? `${OPT_OUT_COOKIE}=1; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`
      : `${OPT_OUT_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
    return new Response(JSON.stringify({ optedOut: next }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ optedOut: isOptedOut }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function json(data: Record<string, unknown>, status: number, origin?: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}

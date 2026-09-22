/**
 * Shared ingest helpers.
 *
 * This file is the canonical copy. Once Analytics syncs it rather than keeping
 * its own, so a change to hashing, referrer cleaning or redaction lands in both
 * the open endpoint and the paid product at once.
 */

/**
 * A hostname reduced to the one string that names a site.
 *
 * Lowercased, without a port, without a leading `www.` and without a trailing
 * dot, so `WWW.Example.com:3000` and `example.com.` are the same site rather
 * than three. Returns "" for anything that is not a plausible hostname, which
 * matters because the value arrives from the page and goes straight into a
 * column people GROUP BY.
 */
export function normaliseHostname(hostname: string | null | undefined): string {
  if (!hostname) return '';
  const bare = hostname
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');

  if (!bare || bare.length > 253) return '';
  if (!/^[a-z0-9.\-_[\]:]+$/.test(bare)) return '';
  return bare;
}

/**
 * The daily-rotating visitor identity.
 *
 * `SHA-256(ip | user-agent | site | date | salt)`, first 16 hex characters.
 *
 * The site is in the hash on purpose: one person visiting two sites in the same
 * database on the same day gets two unrelated identities, so the sites cannot be
 * joined on `visitor_hash`. The date rotates it at UTC midnight and the salt is
 * what makes it irreversible.
 *
 * **The field order is part of the format.** Once Analytics derives the same
 * value from the same string, which is what lets a database move between them
 * without every visitor splitting in two. Changing the order here is a breaking
 * change there.
 */
export async function generateVisitorHash(
  ip: string,
  userAgent: string,
  siteId: string,
  salt: string
): Promise<string> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const data = `${ip}|${userAgent}|${siteId}|${today}|${salt}`;

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return hashHex.substring(0, 16); // First 16 chars is enough
}

/**
 * Clean and validate referrer
 * Strips query params and handles empty/same-site referrers
 */
/** www.example.com and example.com are the same site. */
function bareHost(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/**
 * Turns a raw referrer into a source, or null if it is not one.
 *
 * siteHostnames must be every hostname this instance tracks, so that a visitor
 * moving between pages of the site is not recorded as a source. Passing a
 * placeholder here means self-referrals are counted, and on a site with any
 * internal navigation they bury the real sources.
 */
export function cleanReferrer(referrer: string | null, siteHostnames: string[]): string | null {
  if (!referrer || referrer === '') return null;

  try {
    const refUrl = new URL(referrer);
    const host = bareHost(refUrl.hostname);

    if (siteHostnames.some(h => bareHost(h) === host)) return null;

    // hostname + path, no query, www normalised so one source is one row
    const path = refUrl.pathname === '/' ? '/' : refUrl.pathname.replace(/\/$/, '');
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Parse UTM parameters from a page path (e.g., "/page?utm_source=google&utm_medium=cpc")
 */
export function parseUtmParams(pagePath: string): {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
} {
  const queryIndex = pagePath.indexOf('?');
  if (queryIndex === -1) {
    return { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null };
  }

  const params = new URLSearchParams(pagePath.slice(queryIndex));
  return {
    utmSource: params.get('utm_source'),
    utmMedium: params.get('utm_medium'),
    utmCampaign: params.get('utm_campaign'),
    utmTerm: params.get('utm_term'),
    utmContent: params.get('utm_content'),
  };
}

/**
 * Sensitive query parameters that should be redacted for privacy
 * Values are replaced with REDACTED before storing
 */
const SENSITIVE_PARAMS = new Set([
  // Authentication/Sessions
  'session_id', 'sessionid', 'sid',
  'token', 'access_token', 'auth_token', 'api_token', 'refresh_token',
  'jwt', 'bearer', 'key', 'apikey', 'api_key',
  'code', // OAuth authorization codes

  // User Identifiers
  'user_id', 'userid', 'uid',
  'email', 'e-mail',
  'username', 'user',
  'phone', 'tel',

  // Security
  'password', 'pwd', 'pass',
  'secret', 'signature', 'sig',
  'csrf', 'csrf_token', 'nonce',
  'hash',

  // Payment/Financial
  'card', 'cc', 'credit_card',
  'cvv', 'cvc',
  'account', 'account_number',

  // Ad Platform Click IDs (can identify individuals)
  'fbclid',   // Facebook
  'gclid',    // Google Ads
  'msclkid',  // Microsoft Ads
  'li_fat_id', // LinkedIn
  'ttclid',   // TikTok
  'twclid',   // Twitter
  '_ga',      // Google Analytics user ID

  // Personal Data
  'ssn', 'dob', 'date_of_birth', 'address',
]);

/**
 * Redact sensitive query parameters from a page path
 * e.g., "/page?utm_source=google&session_id=abc123" -> "/page?utm_source=google&session_id=REDACTED"
 */
/**
 * Campaign and ad-click parameters, which already have their own columns and
 * their own tables in the dashboard. Left in the path they split one page into
 * a row per campaign: "/", "/?utm_source=google+maps", "/?utm_source=chatgpt.com".
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclsrc', 'wbraid', 'gbraid', 'li_fat_id', '_gl', 'ref', 'mc_cid', 'mc_eid',
]);
const TRACKING_PARAM_RE = /cl(?:k)?id$/i;

export function stripTrackingParams(pagePath: string): string {
  const q = pagePath.indexOf('?');
  if (q === -1) return pagePath;

  const params = new URLSearchParams(pagePath.slice(q + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || TRACKING_PARAM_RE.test(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return pagePath;

  const rest = params.toString();
  return rest ? `${pagePath.slice(0, q)}?${rest}` : pagePath.slice(0, q);
}

export function redactSensitiveParams(pagePath: string): string {
  const queryIndex = pagePath.indexOf('?');
  if (queryIndex === -1) {
    return pagePath;
  }

  const path = pagePath.slice(0, queryIndex);
  const queryString = pagePath.slice(queryIndex + 1);
  const params = new URLSearchParams(queryString);

  let hasRedactions = false;
  for (const key of params.keys()) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
      params.set(key, 'REDACTED');
      hasRedactions = true;
    }
  }

  if (!hasRedactions) {
    return pagePath;
  }

  const newQuery = params.toString();
  return newQuery ? `${path}?${newQuery}` : path;
}

/**
 * Known bots with friendly names (order matters - more specific first)
 */
const BOT_NAMES: Array<[string, string]> = [
  // Search engines
  ['googlebot', 'Googlebot'],
  ['bingbot', 'Bingbot'],
  ['yandexbot', 'Yandex'],
  ['baiduspider', 'Baidu'],
  ['duckduckbot', 'DuckDuckBot'],
  ['slurp', 'Yahoo Slurp'],
  ['applebot', 'Applebot'],
  // Social
  ['facebookexternalhit', 'Facebook'],
  ['linkedinbot', 'LinkedIn'],
  ['twitterbot', 'Twitter'],
  ['telegrambot', 'Telegram'],
  ['whatsapp', 'WhatsApp'],
  ['discordbot', 'Discord'],
  ['slackbot', 'Slack'],
  // SEO tools
  ['semrushbot', 'SEMrush'],
  ['ahrefsbot', 'Ahrefs'],
  ['mj12bot', 'Majestic'],
  ['dotbot', 'Moz'],
  ['petalbot', 'Petal'],
  ['bytespider', 'ByteDance'],
  // AI
  ['gptbot', 'GPTBot'],
  ['claudebot', 'ClaudeBot'],
  ['anthropic', 'Anthropic'],
  ['chatgpt', 'ChatGPT'],
  ['perplexity', 'Perplexity'],
  // HTTP clients
  ['curl', 'cURL'],
  ['wget', 'Wget'],
  ['python-requests', 'Python'],
  ['python-urllib', 'Python'],
  ['java/', 'Java'],
  ['httpclient', 'HTTPClient'],
  ['okhttp', 'OkHttp'],
  ['axios', 'Axios'],
  ['node-fetch', 'Node.js'],
  ['go-http-client', 'Go'],
  // Monitoring
  ['pingdom', 'Pingdom'],
  ['uptimerobot', 'UptimeRobot'],
  ['statuscake', 'StatusCake'],
  ['sitechecker', 'SiteChecker'],
  // Performance
  ['lighthouse', 'Lighthouse'],
  ['pagespeed', 'PageSpeed'],
  ['gtmetrix', 'GTmetrix'],
  ['webpagetest', 'WebPageTest'],
  // Automation
  ['headless', 'Headless'],
  ['phantomjs', 'PhantomJS'],
  ['selenium', 'Selenium'],
  ['puppeteer', 'Puppeteer'],
  ['playwright', 'Playwright'],
  ['cypress', 'Cypress'],
  // Generic patterns (last)
  ['spider', 'Spider'],
  ['crawler', 'Crawler'],
  ['scraper', 'Scraper'],
  ['bot', 'Bot'],
];

/**
 * Detect if user agent is a bot and return bot name if found
 */
export function detectBot(ua: string): { isBot: boolean; botName: string | null } {
  if (!ua) return { isBot: true, botName: 'Unknown' };
  const uaLower = ua.toLowerCase();

  for (const [pattern, name] of BOT_NAMES) {
    if (uaLower.includes(pattern)) {
      return { isBot: true, botName: name };
    }
  }

  return { isBot: false, botName: null };
}

/**
 * Parse user agent string to extract browser, OS, and device type
 */
export function parseUserAgent(ua: string): { browser: string; os: string; device: string } {
  const uaLower = ua.toLowerCase();

  // Detect browser
  let browser = 'Other';
  if (uaLower.includes('edg/') || uaLower.includes('edge/')) {
    browser = 'Edge';
  } else if (uaLower.includes('opr/') || uaLower.includes('opera')) {
    browser = 'Opera';
  } else if (uaLower.includes('chrome') && !uaLower.includes('chromium')) {
    browser = 'Chrome';
  } else if (uaLower.includes('safari') && !uaLower.includes('chrome')) {
    browser = 'Safari';
  } else if (uaLower.includes('firefox')) {
    browser = 'Firefox';
  } else if (uaLower.includes('msie') || uaLower.includes('trident')) {
    browser = 'IE';
  }

  // Detect OS
  let os = 'Other';
  if (uaLower.includes('iphone') || uaLower.includes('ipad')) {
    os = 'iOS';
  } else if (uaLower.includes('android')) {
    os = 'Android';
  } else if (uaLower.includes('mac os') || uaLower.includes('macos')) {
    os = 'macOS';
  } else if (uaLower.includes('windows')) {
    os = 'Windows';
  } else if (uaLower.includes('linux') && !uaLower.includes('android')) {
    os = 'Linux';
  } else if (uaLower.includes('cros')) {
    os = 'ChromeOS';
  }

  // Detect device type
  let device = 'Desktop';
  if (uaLower.includes('mobile') || uaLower.includes('iphone') || uaLower.includes('android')) {
    if (uaLower.includes('tablet') || uaLower.includes('ipad')) {
      device = 'Tablet';
    } else {
      device = 'Mobile';
    }
  }

  return { browser, os, device };
}

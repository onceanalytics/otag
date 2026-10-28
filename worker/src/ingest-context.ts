/**
 * Request context stored per event: in-app browser, city, language, a
 * datacenter flag, the network (ASN), the Cloudflare data center and the
 * connection's round-trip time. Also the time zone otag reports, checked
 * here so both workers accept the same values. Also the automation check that
 * reads the same request: a browser driven by a script, or one claiming to be
 * something else. And the one rule both apply to a click's parameters before
 * they are stored: link_url loses its query string and fragment.
 *
 * This file exists twice, byte for byte: in Once Analytics (src/ingest-context.ts)
 * and in otag (worker/src/ingest-context.ts). Both write the same events table,
 * so both must derive these columns the same way. A test in Once Analytics
 * compares the two copies.
 *
 * The raw user agent is never stored. Only what is derived from it here (an app
 * name) and in parseUserAgent (browser, os, device) reaches the database.
 */

/** The subset of `request.cf` this file reads. Absent outside Cloudflare (tests, local dev). */
export interface CfProperties {
  city?: string;
  asn?: number;
  asOrganization?: string;
  colo?: string;
  clientTcpRtt?: number;
}

export interface IngestContext {
  inApp: string | null;
  city: string | null;
  lang: string | null;
  dc: number | null;
  asn: number | null;
  colo: string | null;
  rtt: number | null;
}

/**
 * In-app browsers, by the token each app adds to the user agent. Order matters:
 * Messenger carries Facebook's FBAN/FB_IAB tokens too, so it is checked first.
 * A link opened from one of these apps usually arrives with no referrer, so
 * this is often the only trace of where the visit came from.
 */
const IN_APP: Array<[RegExp, string]> = [
  [/Instagram/, 'instagram'],
  [/MessengerForiOS|Orca-Android|MessengerLite|FBAN\/Messenger/, 'messenger'],
  [/FBAN\/|FBAV\/|FB_IAB\/|FB4A|FBIOS/, 'facebook'],
  [/WhatsApp/, 'whatsapp'],
  [/musical_ly|BytedanceWebview|TikTok/, 'tiktok'],
  [/LinkedInApp/, 'linkedin'],
  [/\bLine\/\d/, 'line'],
  [/Snapchat/, 'snapchat'],
  [/Pinterest\//, 'pinterest'],
  [/Twitter/, 'twitter'],
  [/MicroMessenger/, 'wechat'],
  [/Telegram/, 'telegram'],
];

export function detectInApp(ua: string): string | null {
  if (!ua) return null;
  for (const [pattern, name] of IN_APP) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

/**
 * The primary language subtag of the first Accept-Language entry, lowercased:
 * `pl-PL,pl;q=0.9,en;q=0.8` is `pl`. Browsers list the preferred language
 * first. Missing or unusable is null, which is itself a bot signal: real
 * browsers always send the header.
 */
export function primaryLanguage(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(',')[0].split(';')[0].trim().toLowerCase();
  const subtag = first.split('-')[0];
  return /^[a-z]{2,3}$/.test(subtag) ? subtag : null;
}

/**
 * Datacenter flag: 1 when the request came from a cloud or hosting network,
 * 0 when it did not, null when Cloudflare gave no network information.
 *
 * The heuristic is deliberately small and conservative. A short list of ASNs
 * for the large cloud and hosting providers, plus their organisation names to
 * catch the providers' other ASNs. People do not browse from these networks;
 * scanners, headless browsers and scripted traffic do. VPN exits hosted there
 * are flagged too, which is acceptable: the flag says where the request came
 * from, not that it was a bot.
 *
 * Deliberately not listed: Cloudflare (13335), Akamai (20940, 16625, 36183) and
 * Fastly (54113). iCloud Private Relay and Cloudflare WARP egress through them,
 * and those are real people on phones and laptops.
 */
const DATACENTER_ASNS = new Set<number>([
  16509, 14618,          // Amazon AWS
  15169, 396982, 19527,  // Google, Google Cloud
  8075,                  // Microsoft Azure
  14061,                 // DigitalOcean
  24940, 213230,         // Hetzner
  16276,                 // OVH
  63949,                 // Linode (Akamai Connected Cloud)
  20473,                 // Vultr (Choopa)
  31898,                 // Oracle Cloud
  45102,                 // Alibaba Cloud
  132203,                // Tencent Cloud
  12876,                 // Scaleway
  51167,                 // Contabo
  60781, 28753,          // Leaseweb
  9009,                  // M247
  212238,                // Datacamp (CDN77)
  46664,                 // VolumeDrive
  36352,                 // ColoCrossing
  // Bare-metal, VPS and crawler networks seen sending machine traffic
  // (BOT_TRAFFIC_SWEEP.md, tier 1a). A VPN or remote desktop hosted there
  // is possible; asn is stored, so an entry can be taken out later.
  18779,                 // EGIHosting
  262287, 396356,        // Latitude.sh
  26832,                 // Rica Web Services
  44486,                 // Synlinq
  62874,                 // Web2Objects
  11798,                 // Ace Data Centers
  214036,                // Ultahost
  214677,                // DeluxHost
  216139,                // Ironhost
  212341,                // CSN-Datacenters
  399275,                // Solid Systems
  140577,                // Ahrefs
  7941,                  // Internet Archive
  13238,                 // Yandex
  37963,                 // Alibaba (China)
  132510, 134543,        // China Mobile / China Unicom IDC
]);

const DATACENTER_ORGS =
  /amazon|\baws\b|google cloud|azure|digitalocean|hetzner|\bovh|linode|vultr|choopa|oracle|alibaba|tencent|scaleway|contabo|leaseweb|m247|datacamp|colocrossing/i;

export function isDatacenter(cf: CfProperties | undefined): number | null {
  if (!cf || (cf.asn === undefined && !cf.asOrganization)) return null;
  if (cf.asn !== undefined && DATACENTER_ASNS.has(Number(cf.asn))) return 1;
  if (cf.asOrganization && DATACENTER_ORGS.test(cf.asOrganization)) return 1;
  return 0;
}

/**
 * The network the request came from, as Cloudflare's autonomous system number.
 * Stored next to `dc` so a later, longer list of datacenter networks can be
 * applied to rows already collected: `dc` is decided once, at ingest. A
 * network, not a person: every customer of an ISP shares its number.
 */
export function asnOf(cf: CfProperties | undefined): number | null {
  const n = Number(cf?.asn);
  return cf?.asn !== undefined && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The Cloudflare data center that took the request, as its three-letter
 * airport code (WAW, FRA). One far from the visitor's country points to a
 * proxy or tunnel.
 */
export function coloOf(cf: CfProperties | undefined): string | null {
  return typeof cf?.colo === 'string' && /^[A-Z]{3}$/.test(cf.colo) ? cf.colo : null;
}

/**
 * The TCP round-trip time between the visitor and that data center, rounded
 * to 10 ms: coarse enough to say near or far, nothing finer. Null when
 * Cloudflare has none, which is common: an HTTP/3 (QUIC) connection is not
 * TCP and often has no value, or 0, which is treated as none too.
 */
export function rttOf(cf: CfProperties | undefined): number | null {
  const ms = cf?.clientTcpRtt;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms / 10) * 10 : null;
}

/**
 * The time zone otag reports (`z`), as the browser named it: Europe/Warsaw,
 * America/Argentina/Buenos_Aires, Etc/GMT+3, UTC. Anything that does not look
 * like an IANA zone name, or is longer than 64 characters, is null. The name
 * is not checked against a zone list: a browser newer than this file may
 * know a zone it does not.
 */
export function timeZoneOf(z: unknown): string | null {
  return typeof z === 'string' && z.length <= 64 && /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(z)
    ? z
    : null;
}

/** All seven columns for one request. */
export function ingestContext(request: Request): IngestContext {
  const cf = (request as unknown as { cf?: CfProperties }).cf;
  return {
    inApp: detectInApp(request.headers.get('User-Agent') || ''),
    city: typeof cf?.city === 'string' && cf.city ? cf.city : null,
    lang: primaryLanguage(request.headers.get('Accept-Language')),
    dc: isDatacenter(cf),
    asn: asnOf(cf),
    colo: coloOf(cf),
    rtt: rttOf(cf),
  };
}

/**
 * The operating system a user agent names, in the words Sec-CH-UA-Platform
 * uses. Null when it names none of them.
 */
function uaPlatform(ua: string): string | null {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}

/** The brands of a Sec-CH-UA header: `"Chromium";v="131"` is Chromium 131. */
function brands(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of header.matchAll(/"([^"]*)"\s*;\s*v\s*=\s*"([^"]*)"/g)) out.set(m[1], m[2]);
  return out;
}

/**
 * A user agent exactly as desktop and Android Chrome, Edge and Opera write it,
 * which is also the string scripts copy. In-app browsers, WebViews, Samsung
 * Internet and Chrome on iOS add tokens and do not match, so they are never
 * judged by the absence of client hints.
 */
const PLAIN_CHROMIUM_UA =
  /^Mozilla\/5\.0 \([^)]*\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)[\d.]* (?:Mobile )?Safari\/537\.36(?: (?:Edg|OPR)\/[\d.]+)?$/;

/**
 * A bot name when the request comes from a browser driven by a script, null
 * when nothing says so. Each check is about the browser contradicting itself,
 * so a real person in an ordinary browser never matches:
 *
 * - Webdriver: the page reported navigator.webdriver (otag sends `w: 1`).
 *   Puppeteer, Playwright and Selenium set it unless told not to.
 * - Headless: Sec-CH-UA lists HeadlessChrome. Old headless Chrome sends it
 *   even when the script replaced the User-Agent.
 * - Spoofed UA: the User-Agent says Chrome N but Sec-CH-UA says Chromium M;
 *   or Sec-CH-UA-Platform names another system than the User-Agent; or the
 *   User-Agent is a plain Chrome 90+ string and no Sec-CH-UA came at all
 *   (every Chromium browser sends it to an HTTPS endpoint, which /t always
 *   is). Chrome on Android asked for the desktop site says Linux in the
 *   User-Agent and Android in the hint, and is not counted as a mismatch.
 */
export function detectAutomation(request: Request, webdriver?: unknown): string | null {
  if (webdriver === 1 || webdriver === true) return 'Webdriver';
  const ua = request.headers.get('User-Agent') || '';
  const ch = request.headers.get('Sec-CH-UA');
  const b = ch ? brands(ch) : null;
  if (b?.has('HeadlessChrome')) return 'Headless';

  const chromeMajor = /Chrome\/(\d+)/.exec(ua)?.[1];
  const chromium = b?.get('Chromium');
  if (chromeMajor && chromium && chromium !== chromeMajor) return 'Spoofed UA';

  const hinted = request.headers.get('Sec-CH-UA-Platform')?.replace(/"/g, '').trim();
  const named = uaPlatform(ua);
  if (hinted && named && hinted !== 'Unknown') {
    const same = hinted === named
      || (hinted === 'Chromium OS' && named === 'Chrome OS')
      || (hinted === 'Android' && named === 'Linux');
    if (!same) return 'Spoofed UA';
  }

  const plain = PLAIN_CHROMIUM_UA.exec(ua);
  if (!ch && plain && Number(plain[1]) >= 90) return 'Spoofed UA';
  return null;
}

/**
 * A link's address without its query string or #fragment. The address says
 * where the link goes; the query is where sites put what a click should not
 * keep: account ids in a dashboard deep link, a prefilled mailto: subject,
 * utm_* tags on an internal link. mailto: and tel: keep their address, and a
 * relative link keeps its path. A link that was only a fragment or a query
 * ("#top", "?page=2") has no address left, and the result is empty.
 */
export function linkAddress(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Event parameters as they are stored: link_url cut to linkAddress, and
 * dropped when nothing is left. Done here rather than only in the browser
 * script, so pages still running a cached older script are covered too.
 * Everything else is kept as it arrived.
 */
export function storedEventData<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const url = (data as Record<string, unknown>).link_url;
  if (typeof url !== 'string') return data;
  const { link_url: _, ...rest } = data as Record<string, unknown>;
  const address = linkAddress(url);
  return (address ? { ...rest, link_url: address } : rest) as T;
}

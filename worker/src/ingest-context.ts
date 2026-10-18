/**
 * Request context stored per event: in-app browser, city, language and a
 * datacenter flag.
 *
 * This file exists twice, byte for byte: in Once Analytics (src/ingest-context.ts)
 * and in otag (worker/src/ingest-context.ts). Both write the same events table,
 * so both must derive these four columns the same way. A test in Once Analytics
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
}

export interface IngestContext {
  inApp: string | null;
  city: string | null;
  lang: string | null;
  dc: number | null;
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
]);

const DATACENTER_ORGS =
  /amazon|\baws\b|google cloud|azure|digitalocean|hetzner|\bovh|linode|vultr|choopa|oracle|alibaba|tencent|scaleway|contabo|leaseweb|m247|datacamp|colocrossing/i;

export function isDatacenter(cf: CfProperties | undefined): number | null {
  if (!cf || (cf.asn === undefined && !cf.asOrganization)) return null;
  if (cf.asn !== undefined && DATACENTER_ASNS.has(Number(cf.asn))) return 1;
  if (cf.asOrganization && DATACENTER_ORGS.test(cf.asOrganization)) return 1;
  return 0;
}

/** All four columns for one request. */
export function ingestContext(request: Request): IngestContext {
  const cf = (request as unknown as { cf?: CfProperties }).cf;
  return {
    inApp: detectInApp(request.headers.get('User-Agent') || ''),
    city: typeof cf?.city === 'string' && cf.city ? cf.city : null,
    lang: primaryLanguage(request.headers.get('Accept-Language')),
    dc: isDatacenter(cf),
  };
}

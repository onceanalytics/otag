/**
 * otag's collection endpoint.
 *
 * Four routes: serve the script, take the events, let a visitor opt out, and
 * show one page of installation instructions. Reading the data happens in SQL,
 * against the D1 database this writes to.
 */

import { handleTrack, handleOptOut, type Env } from './ingest';
import { OTAG_SCRIPT, OTAG_VERSION } from './otag.generated';
import { installPage } from './install-page';

export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }

    switch (url.pathname) {
      case '/t':
        return handleTrack(request, env);

      case '/script.js':
        // Identical bytes for every site: the script derives its endpoint from
        // its own src at runtime, so this response is a constant.
        return new Response(OTAG_SCRIPT, {
          headers: {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
            'X-Otag-Version': OTAG_VERSION,
          },
        });

      case '/optout':
        return handleOptOut(request);

      case '/':
        return installPage(request, env);

      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

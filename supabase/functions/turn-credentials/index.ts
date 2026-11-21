// turn-credentials — ICE servers (STUN + short-lived Cloudflare TURN) for a
// signed-in user, so sessions connect across different networks (mobile data,
// CGNAT, strict routers) where a direct peer-to-peer path is impossible.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   CLOUDFLARE_TURN_KEY_ID      Cloudflare dashboard → Realtime → TURN → key ID
//   CLOUDFLARE_TURN_API_TOKEN   that key's API token
// Without them (or if Cloudflare fails) the reply is STUN only, so clients
// still work on the same network.
//
// POST (signed-in user's token)  →  200 { iceServers, ttl, turn: boolean } | 401
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const TTL_SECONDS = 12 * 60 * 60;
const STUN = {urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  });
}

type IceServer = {urls: string | string[]; username?: string; credential?: string};

async function cloudflareTurn(): Promise<IceServer[] | null> {
  const keyId = Deno.env.get('CLOUDFLARE_TURN_KEY_ID');
  const token = Deno.env.get('CLOUDFLARE_TURN_API_TOKEN');
  if (!keyId || !token) return null;
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({ttl: TTL_SECONDS}),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!res.ok) {
    console.error(`cloudflare turn: HTTP ${res.status}`);
    return null;
  }
  const body = await res.json();
  const list: IceServer[] = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers ? [body.iceServers] : [];
  const out: IceServer[] = [];
  for (const s of list) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
      .filter((u): u is string => typeof u === 'string')
      // Port 53 is blocked or broken in some browsers / networks; 3478, 80 and 443 remain.
      .filter(u => !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    out.push(s.username ? {urls, username: s.username, credential: s.credential} : {urls});
  }
  return out.some(s => s.username) ? out : null;
}

async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+\.\S+\.\S+$/.test(auth)) return false;
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
      headers: {Authorization: auth, apikey},
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const user = await res.json();
    return typeof user?.id === 'string' && !user?.is_anonymous;
  } catch {
    return false;
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: CORS});
  if (req.method !== 'POST' && req.method !== 'GET') return json(405, {error: 'method_not_allowed'});
  // Only signed-in users (accounts and paired PCs) get relay credentials. The
  // gateway also lets the bare publishable key through, so check the user here.
  if (!(await signedIn(req))) return json(401, {error: 'unauthorized', message: 'Sign in first.'});
  let turn: IceServer[] | null = null;
  try {
    turn = await cloudflareTurn();
  } catch (err) {
    console.error(`cloudflare turn: ${err instanceof Error ? err.message : err}`);
  }
  if (!turn) return json(200, {iceServers: [STUN], ttl: TTL_SECONDS, turn: false});
  const hasStun = turn.some(s => (s.urls as string[]).some(u => u.startsWith('stun:')));
  return json(200, {iceServers: hasStun ? turn : [STUN, ...turn], ttl: TTL_SECONDS, turn: true});
});

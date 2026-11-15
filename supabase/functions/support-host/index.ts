// support-host — temporary identity for a PC that wants Remote Support.
//
// "Share this screen" works without an account on the PC being helped: this
// function creates a short-lived auth user + support_hosts row (2 h TTL,
// removed hourly by private.cleanup_support()). The PC then signs in with it,
// issues a 12-digit code (rpc issue_support_code) and waits for a helper.
//
// POST { name?: string }  →  200 { hostId, email, password, expiresAt }
//                             429 rate_limited (20 per IP per hour)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...CORS, 'Content-Type': 'application/json'},
  });
}

function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: CORS});
  if (req.method !== 'POST') return json(405, {error: 'method_not_allowed'});

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is fine.
  }
  const rawName = typeof body.name === 'string' ? body.name : '';
  const name = rawName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) || 'Windows PC';
  const clientKey =
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    req.headers.get('cf-connecting-ip') ||
    'unknown';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    {auth: {persistSession: false, autoRefreshToken: false}},
  );

  const {data: allowed, error: limitError} = await admin.rpc('register_support_host_attempt', {
    p_client_key: clientKey,
  });
  if (limitError) return json(500, {error: 'internal_error'});
  if (!allowed) {
    return json(429, {error: 'rate_limited', message: 'Too many support requests. Try again later.'});
  }

  const hostId = crypto.randomUUID();
  const email = `support-${hostId}@support.remote-pc.invalid`;
  const password = randomSecret();
  const {data: created, error: userError} = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: {role: 'support-host', host_id: hostId},
  });
  if (userError || !created.user) {
    return json(500, {error: 'internal_error', message: 'Could not create the support identity.'});
  }

  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const {error: insertError} = await admin.from('support_hosts').insert({
    id: hostId,
    agent_user_id: created.user.id,
    name,
    expires_at: expiresAt,
  });
  if (insertError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json(500, {error: 'internal_error', message: 'Could not register the support host.'});
  }

  return json(200, {hostId, email, password, expiresAt});
});

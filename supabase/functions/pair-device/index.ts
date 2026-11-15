// pair-device — claims a 6-digit pairing code for a PC.
//
// Called by the Windows agent before it has any identity, so JWT
// verification is off and the one-time code is the credential. On success
// the PC gets its own restricted Supabase auth user (device login) and a
// row in public.devices owned by the account that created the code.
//
// POST { code: "123456", name?: string, os?: string, version?: string }
//   200 { deviceId, ownerId, name, email, password }
//   400 bad_request | 401 invalid_or_expired_code | 429 rate_limited | 500
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

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
}

function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: CORS});
  if (req.method !== 'POST') return json(405, {error: 'method_not_allowed'});

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, {error: 'bad_request', message: 'Body must be JSON.'});
  }
  const code = clean(body.code, 6);
  if (!/^\d{6}$/.test(code)) {
    return json(400, {error: 'bad_request', message: 'The access code has 6 digits.'});
  }
  const name = clean(body.name, 64) || 'Windows PC';
  const os = clean(body.os, 32) || 'windows';
  const version = clean(body.version, 32) || null;
  const clientKey =
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    req.headers.get('cf-connecting-ip') ||
    'unknown';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    {auth: {persistSession: false, autoRefreshToken: false}},
  );

  // 1) Burn the code (single use, 5-minute TTL, per-IP failure limit).
  const {data: ownerId, error: claimError} = await admin.rpc('claim_pairing_code', {
    p_code: code,
    p_client_key: clientKey,
  });
  if (claimError || !ownerId) {
    const msg = claimError?.message ?? '';
    if (msg.includes('rate_limited')) {
      return json(429, {error: 'rate_limited', message: 'Too many attempts. Wait a few minutes.'});
    }
    return json(401, {
      error: 'invalid_or_expired_code',
      message: 'That code is invalid, expired or already used. Get a new one in the app.',
    });
  }

  // 2) Create the PC's own restricted login.
  const deviceId = crypto.randomUUID();
  const email = `device-${deviceId}@devices.remote-pc.invalid`;
  const password = randomSecret();
  const {data: created, error: userError} = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: {role: 'device', device_id: deviceId},
    user_metadata: {device_name: name},
  });
  if (userError || !created.user) {
    return json(500, {error: 'internal_error', message: 'Could not create the device login.'});
  }

  // 3) Register the computer for the code's owner.
  const {error: insertError} = await admin.from('devices').insert({
    id: deviceId,
    owner_id: ownerId,
    agent_user_id: created.user.id,
    name,
    os,
    agent_version: version,
    online: false,
  });
  if (insertError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json(500, {error: 'internal_error', message: 'Could not register the computer.'});
  }

  return json(200, {deviceId, ownerId, name, email, password});
});

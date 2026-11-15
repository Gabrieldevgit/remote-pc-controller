-- Remote PC Controller — Supabase backend.
--
-- Replaces the self-hosted relay:
--   * Auth      — app users sign in with Supabase Auth. Every paired PC gets
--                 its own restricted auth user (created by the pair-device
--                 Edge Function) recorded in devices.agent_user_id.
--   * Database  — devices, pairing codes, remote sessions, quick-action
--                 commands. RLS on everything; writes that need more than a
--                 row filter go through SECURITY DEFINER functions.
--   * Realtime  — postgres_changes on devices / remote_sessions /
--                 device_commands, and private broadcast channels
--                 "session:<uuid>" for WebRTC signaling (offer/answer/ICE).
--   * Storage   — private "screenshots" bucket, one folder per device.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- The PC's own auth identity; null once revoked.
  agent_user_id uuid unique references auth.users (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 64),
  os text not null default 'windows' check (char_length(os) <= 32),
  agent_version text check (char_length(agent_version) <= 32),
  online boolean not null default false,
  last_seen_at timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index devices_owner_idx on public.devices (owner_id);

create table private.pairing_codes (
  code text primary key check (code ~ '^[0-9]{6}$'),
  owner_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index pairing_codes_owner_idx on private.pairing_codes (owner_id);

create table private.pairing_failures (
  id bigint generated always as identity primary key,
  client_key text not null,
  created_at timestamptz not null default now()
);
create index pairing_failures_key_idx on private.pairing_failures (client_key, created_at);

create table public.remote_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  requester_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  state text not null default 'requested'
    check (state in ('requested', 'accepted', 'rejected', 'ended')),
  end_reason text check (char_length(end_reason) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index remote_sessions_device_idx on public.remote_sessions (device_id, created_at desc);
create index remote_sessions_requester_idx on public.remote_sessions (requester_id);

create table public.device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  requester_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  command text not null check (command in (
    'lock', 'shutdown', 'hibernate', 'restart', 'logoff',
    'volume_up', 'volume_down', 'mute', 'beep',
    'screenshot', 'process_list', 'process_kill', 'sysinfo'
  )),
  params jsonb not null default '{}'::jsonb
    check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 4096),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'expired')),
  result jsonb check (result is null or pg_column_size(result) <= 262144),
  error text check (char_length(error) <= 300),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index device_commands_device_idx on public.device_commands (device_id, created_at desc);
create index device_commands_requester_idx on public.device_commands (requester_id);

-- ---------------------------------------------------------------------------
-- Helpers (private, used by policies)
-- ---------------------------------------------------------------------------

create or replace function private.is_device_owner(p_device uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.devices d
    where d.id = p_device and d.owner_id = (select auth.uid())
  );
$$;

create or replace function private.is_device_agent(p_device uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.devices d
    where d.id = p_device and d.agent_user_id = (select auth.uid())
  );
$$;

-- A Realtime topic "session:<uuid>" is open to the session's requester and
-- to the device's agent while the session is not finished.
create or replace function private.can_use_session_topic(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_topic is null or p_topic !~ '^session:[0-9a-f-]{36}$' then
    return false;
  end if;
  v_id := substring(p_topic from 9)::uuid;
  return exists (
    select 1
    from public.remote_sessions s
    join public.devices d on d.id = s.device_id
    where s.id = v_id
      and s.state in ('requested', 'accepted')
      and (s.requester_id = (select auth.uid()) or d.agent_user_id = (select auth.uid()))
  );
end;
$$;

grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on function private.is_device_owner(uuid) to authenticated;
grant execute on function private.is_device_agent(uuid) to authenticated;
grant execute on function private.can_use_session_topic(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.devices enable row level security;
alter table public.remote_sessions enable row level security;
alter table public.device_commands enable row level security;
alter table private.pairing_codes enable row level security;
alter table private.pairing_failures enable row level security;

-- devices: owners read / rename / delete; the agent reads its own row.
-- Presence columns are written only through device_heartbeat().
create policy devices_select on public.devices for select to authenticated
  using (owner_id = (select auth.uid()) or agent_user_id = (select auth.uid()));
create policy devices_update_owner on public.devices for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy devices_delete_owner on public.devices for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.devices from anon, authenticated;
grant select, delete on public.devices to authenticated;
grant update (name) on public.devices to authenticated;

-- remote_sessions: the owner of an online device requests; both sides read;
-- the requester can only end; the agent accepts / rejects / ends.
create policy sessions_select on public.remote_sessions for select to authenticated
  using (requester_id = (select auth.uid()) or (select private.is_device_agent(device_id)));
create policy sessions_insert on public.remote_sessions for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and state = 'requested'
    and (select private.is_device_owner(device_id))
  );
create policy sessions_update_requester on public.remote_sessions for update to authenticated
  using (requester_id = (select auth.uid()))
  with check (requester_id = (select auth.uid()) and state = 'ended');
create policy sessions_update_agent on public.remote_sessions for update to authenticated
  using ((select private.is_device_agent(device_id)))
  with check ((select private.is_device_agent(device_id)) and state in ('accepted', 'rejected', 'ended'));

revoke all on public.remote_sessions from anon, authenticated;
grant select on public.remote_sessions to authenticated;
grant insert (device_id) on public.remote_sessions to authenticated;
grant update (state, end_reason, ended_at, updated_at) on public.remote_sessions to authenticated;

-- device_commands: owners queue and read; the agent reads and reports.
create policy commands_select on public.device_commands for select to authenticated
  using (requester_id = (select auth.uid()) or (select private.is_device_agent(device_id)));
create policy commands_insert on public.device_commands for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and status = 'pending'
    and (select private.is_device_owner(device_id))
  );
create policy commands_update_agent on public.device_commands for update to authenticated
  using ((select private.is_device_agent(device_id)))
  with check ((select private.is_device_agent(device_id)));

revoke all on public.device_commands from anon, authenticated;
grant select on public.device_commands to authenticated;
grant insert (device_id, command, params) on public.device_commands to authenticated;
grant update (status, result, error, completed_at) on public.device_commands to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger devices_touch before update on public.devices
  for each row execute function private.touch_updated_at();
create trigger sessions_touch before update on public.remote_sessions
  for each row execute function private.touch_updated_at();

-- Sessions may only be requested for an online device, and a finished
-- session can never be reopened.
create or replace function private.guard_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.devices d
      where d.id = new.device_id and d.online
        and d.last_seen_at > now() - interval '60 seconds'
    ) then
      raise exception 'device_offline' using errcode = 'P0001';
    end if;
  elsif old.state in ('rejected', 'ended') and new.state is distinct from old.state then
    raise exception 'session_finished' using errcode = 'P0001';
  end if;
  if new.state in ('rejected', 'ended') and new.ended_at is null then
    new.ended_at := now();
  end if;
  return new;
end;
$$;

create trigger sessions_guard before insert or update on public.remote_sessions
  for each row execute function private.guard_session();

-- Commands need an online device too.
create or replace function private.guard_command()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.devices d
    where d.id = new.device_id and d.online
      and d.last_seen_at > now() - interval '60 seconds'
  ) then
    raise exception 'device_offline' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger commands_guard before insert on public.device_commands
  for each row execute function private.guard_command();

-- Deleting a device revokes its agent identity immediately.
create or replace function private.revoke_device_agent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.agent_user_id is not null then
    delete from auth.users where id = old.agent_user_id;
  end if;
  return old;
end;
$$;

create trigger devices_revoke_agent after delete on public.devices
  for each row execute function private.revoke_device_agent();

revoke all on function private.touch_updated_at() from public, anon, authenticated;
revoke all on function private.guard_session() from public, anon, authenticated;
revoke all on function private.guard_command() from public, anon, authenticated;
revoke all on function private.revoke_device_agent() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- App: issue a one-time 6-digit pairing code (5 min, max 3 live per user).
create or replace function public.create_pairing_code()
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from private.pairing_codes p
  where p.expires_at < now() - interval '1 day' or p.used_at is not null;
  -- Keep at most 2 older live codes for this user (the new one makes 3).
  delete from private.pairing_codes p
  where p.owner_id = v_user and p.code in (
    select p2.code from private.pairing_codes p2
    where p2.owner_id = v_user
    order by p2.created_at desc offset 2
  );
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into private.pairing_codes (code, owner_id, expires_at)
      values (v_code, v_user, now() + interval '5 minutes');
      exit;
    exception when unique_violation then
      -- extremely rare collision: try another code
    end;
  end loop;
  return query select v_code, now() + interval '5 minutes';
end;
$$;

revoke all on function public.create_pairing_code() from public, anon;
grant execute on function public.create_pairing_code() to authenticated;

-- Edge Function (service_role only): burn a code and return its owner.
-- p_client_key identifies the caller (IP) for brute-force limiting.
create or replace function public.claim_pairing_code(p_code text, p_client_key text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  if (select count(*) from private.pairing_failures f
      where f.client_key = p_client_key and f.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  update private.pairing_codes p
  set used_at = now()
  where p.code = p_code and p.used_at is null and p.expires_at > now()
  returning p.owner_id into v_owner;
  if v_owner is null then
    insert into private.pairing_failures (client_key) values (left(coalesce(p_client_key, '?'), 128));
    delete from private.pairing_failures f where f.created_at < now() - interval '1 day';
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;
  return v_owner;
end;
$$;

revoke all on function public.claim_pairing_code(text, text) from public, anon, authenticated;
grant execute on function public.claim_pairing_code(text, text) to service_role;

-- Agent: heartbeat (marks the device online and refreshes metadata).
create or replace function public.device_heartbeat(
  p_name text default null,
  p_version text default null,
  p_capabilities jsonb default null
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  update public.devices d
  set online = true,
      last_seen_at = now(),
      agent_version = coalesce(left(p_version, 32), d.agent_version),
      capabilities = case
        when p_capabilities is not null and jsonb_typeof(p_capabilities) = 'object'
             and pg_column_size(p_capabilities) <= 4096
        then p_capabilities else d.capabilities end
  where d.agent_user_id = auth.uid()
  returning d.id into v_id;
  if v_id is null then
    raise exception 'device_not_found' using errcode = 'P0002';
  end if;
  -- Commands nobody picked up within a minute are stale.
  update public.device_commands c
  set status = 'expired', completed_at = now()
  where c.device_id = v_id and c.status = 'pending' and c.created_at < now() - interval '60 seconds';
  return v_id;
end;
$$;

-- Agent: going offline (graceful shutdown).
create or replace function public.device_offline()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.devices d set online = false where d.agent_user_id = auth.uid();
  update public.remote_sessions s
  set state = 'ended', end_reason = 'device_disconnected'
  from public.devices d
  where d.id = s.device_id and d.agent_user_id = auth.uid() and s.state in ('requested', 'accepted');
end;
$$;

revoke all on function public.device_heartbeat(text, text, jsonb) from public, anon;
revoke all on function public.device_offline() from public, anon;
grant execute on function public.device_heartbeat(text, text, jsonb) to authenticated;
grant execute on function public.device_offline() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter table public.devices replica identity full;
alter table public.remote_sessions replica identity full;
alter table public.device_commands replica identity full;
alter publication supabase_realtime add table public.devices, public.remote_sessions, public.device_commands;

-- Private broadcast channels "session:<uuid>" for WebRTC signaling.
create policy session_topic_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select private.can_use_session_topic(realtime.topic()))
  );
create policy session_topic_write on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and (select private.can_use_session_topic(realtime.topic()))
  );

-- ---------------------------------------------------------------------------
-- Storage: screenshots/<device_id>/<file>.png
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('screenshots', 'screenshots', false, 10485760, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

create or replace function private.folder_device(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;
grant execute on function private.folder_device(text) to authenticated;

create policy screenshots_agent_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'screenshots'
    and (select private.is_device_agent(private.folder_device(name)))
  );
create policy screenshots_read on storage.objects for select to authenticated
  using (
    bucket_id = 'screenshots'
    and (
      (select private.is_device_owner(private.folder_device(name)))
      or (select private.is_device_agent(private.folder_device(name)))
    )
  );
create policy screenshots_owner_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'screenshots'
    and (select private.is_device_owner(private.folder_device(name)))
  );

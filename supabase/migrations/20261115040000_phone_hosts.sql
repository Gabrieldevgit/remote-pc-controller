-- Round 5: the PC controls the phone.
--
-- A phone signed in to the Remote PC app can make itself available to the
-- same account's PCs (Remote PC Host). Both ends act as the same user, so
-- every row and topic here is owner-only.
--
--   phones          one row per phone that opted in; heartbeat via RPC
--   phone_sessions  a PC asking to control one of the owner's phones
--   phone:<uuid>    private Realtime broadcast topic for the WebRTC signaling
--                   (offer / answer / ICE) of an open phone session

-- Phones ---------------------------------------------------------------------------

create table public.phones (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 64),
  model text check (model is null or char_length(model) <= 80),
  android_version text check (android_version is null or char_length(android_version) <= 16),
  capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 2048),
  online boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index phones_owner_idx on public.phones (owner_id);
alter table public.phones enable row level security;

create policy phones_select on public.phones for select to authenticated
  using (owner_id = (select auth.uid()));
-- At most 20 phones per account (counted outside RLS to avoid recursion).
create or replace function private.phone_slots_left()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.phones p where p.owner_id = (select auth.uid())) < 20;
$$;
revoke all on function private.phone_slots_left() from public, anon;
grant execute on function private.phone_slots_left() to authenticated;

create policy phones_insert on public.phones for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.phone_slots_left()));
create policy phones_update on public.phones for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy phones_delete on public.phones for delete to authenticated
  using (owner_id = (select auth.uid()));

grant select, delete on public.phones to authenticated;
grant insert (name, model, android_version, capabilities) on public.phones to authenticated;
grant update (name, model, android_version, capabilities) on public.phones to authenticated;

-- Presence: the phone calls this every 20 s while it is available (and with
-- p_online = false when the user turns it off). Server time, owner only.
create function public.phone_heartbeat(p_phone uuid, p_online boolean default true)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.phones p
  set online = coalesce(p_online, true),
      last_seen_at = now()
  where p.id = p_phone and p.owner_id = (select auth.uid());
  if not found then
    raise exception 'not_owner' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.phone_heartbeat(uuid, boolean) from public, anon;
grant execute on function public.phone_heartbeat(uuid, boolean) to authenticated;

-- Sessions -------------------------------------------------------------------------

create table public.phone_sessions (
  id uuid primary key default gen_random_uuid(),
  phone_id uuid not null references public.phones (id) on delete cascade,
  requester_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_name text check (client_name is null or char_length(client_name) <= 80),
  state text not null default 'requested'
    check (state in ('requested', 'accepted', 'rejected', 'ended')),
  end_reason text check (end_reason is null or char_length(end_reason) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index phone_sessions_phone_idx on public.phone_sessions (phone_id, created_at desc);
create index phone_sessions_requester_idx on public.phone_sessions (requester_id);
alter table public.phone_sessions enable row level security;

create or replace function private.is_phone_owner(p_phone uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.phones p
    where p.id = p_phone and p.owner_id = (select auth.uid())
  );
$$;
revoke all on function private.is_phone_owner(uuid) from public, anon;
grant execute on function private.is_phone_owner(uuid) to authenticated;

create policy phone_sessions_select on public.phone_sessions for select to authenticated
  using ((select private.is_phone_owner(phone_id)));
create policy phone_sessions_insert on public.phone_sessions for insert to authenticated
  with check (requester_id = (select auth.uid()) and state = 'requested' and (select private.is_phone_owner(phone_id)));
create policy phone_sessions_update on public.phone_sessions for update to authenticated
  using ((select private.is_phone_owner(phone_id)))
  with check ((select private.is_phone_owner(phone_id)) and state in ('accepted', 'rejected', 'ended'));

grant select on public.phone_sessions to authenticated;
grant insert (phone_id, client_name) on public.phone_sessions to authenticated;
grant update (state, end_reason, ended_at, updated_at) on public.phone_sessions to authenticated;

-- A session can only be requested while the phone is online (heartbeat
-- under 60 s); finished sessions cannot be reopened.
create or replace function private.guard_phone_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.phones p
      where p.id = new.phone_id and p.online and p.last_seen_at > now() - interval '60 seconds'
    ) then
      raise exception 'phone_offline' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.state in ('rejected', 'ended') then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  if new.state in ('rejected', 'ended') and new.ended_at is null then
    new.ended_at := now();
  end if;
  return new;
end;
$$;
revoke all on function private.guard_phone_session() from public, anon, authenticated;
create trigger phone_sessions_guard before insert or update on public.phone_sessions
  for each row execute function private.guard_phone_session();

-- Realtime ---------------------------------------------------------------------------

create or replace function private.can_use_phone_topic(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_topic is null or p_topic !~ '^phone:[0-9a-f-]{36}$' then
    return false;
  end if;
  v_id := substring(p_topic from 7)::uuid;
  return exists (
    select 1 from public.phone_sessions s
    join public.phones p on p.id = s.phone_id
    where s.id = v_id and s.state in ('requested', 'accepted')
      and p.owner_id = (select auth.uid())
  );
end;
$$;
revoke all on function private.can_use_phone_topic(text) from public, anon;
grant execute on function private.can_use_phone_topic(text) to authenticated;

drop policy session_topic_read on realtime.messages;
drop policy session_topic_write on realtime.messages;
create policy session_topic_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      (select private.can_use_session_topic(realtime.topic()))
      or (select private.can_use_support_topic(realtime.topic()))
      or (select private.can_use_phone_topic(realtime.topic()))
    )
  );
create policy session_topic_write on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and (
      (select private.can_use_session_topic(realtime.topic()))
      or (select private.can_use_support_topic(realtime.topic()))
      or (select private.can_use_phone_topic(realtime.topic()))
    )
  );

alter table public.phones replica identity full;
alter table public.phone_sessions replica identity full;
alter publication supabase_realtime add table public.phones;
alter publication supabase_realtime add table public.phone_sessions;

-- Cleanup: finished phone sessions older than 30 days (hourly job).
create or replace function private.cleanup_support()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.users u
  using public.support_hosts h
  where h.agent_user_id = u.id and h.expires_at < now();
  delete from private.support_codes c where c.expires_at < now() - interval '1 day';
  delete from private.support_failures f where f.created_at < now() - interval '1 day';
  delete from private.support_host_creations c where c.created_at < now() - interval '1 day';
  delete from public.support_sessions s where s.ended_at < now() - interval '30 days';
  delete from public.remote_sessions s where s.ended_at < now() - interval '30 days';
  delete from public.device_commands c where c.completed_at < now() - interval '30 days';
  delete from public.phone_sessions s where s.ended_at < now() - interval '30 days';
  -- A session nobody answered within 2 minutes is over.
  update public.phone_sessions s set state = 'ended', end_reason = 'timeout'
  where s.state = 'requested' and s.created_at < now() - interval '2 minutes';
end;
$$;
revoke all on function private.cleanup_support() from public, anon, authenticated;

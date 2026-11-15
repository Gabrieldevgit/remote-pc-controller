-- Remote Support: let someone help on a PC with a one-time 12-digit code.
--
-- The PC being helped needs no account: the pair-free `support-host` Edge
-- Function gives it a temporary auth identity (support_hosts, 2 h TTL). It
-- issues a code; a signed-in helper redeems it, which creates a
-- support_sessions row. The person at the PC must click Allow (state
-- approved) before any screen is shared. Signaling uses the private
-- Realtime topic "support:<session id>".

create extension if not exists pg_cron with schema pg_catalog;

create table public.support_hosts (
  id uuid primary key default gen_random_uuid(),
  agent_user_id uuid not null unique references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);

create table private.support_codes (
  code text primary key check (code ~ '^[0-9]{12}$'),
  host_id uuid not null references public.support_hosts (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index support_codes_host_idx on private.support_codes (host_id);

create table private.support_failures (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index support_failures_user_idx on private.support_failures (user_id, created_at);

create table private.support_host_creations (
  id bigint generated always as identity primary key,
  client_key text not null,
  created_at timestamptz not null default now()
);
create index support_host_creations_key_idx on private.support_host_creations (client_key, created_at);

create table public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.support_hosts (id) on delete cascade,
  helper_id uuid not null references auth.users (id) on delete cascade,
  helper_email text check (char_length(helper_email) <= 320),
  host_name text check (char_length(host_name) <= 64),
  mode text not null default 'control' check (mode in ('control', 'view')),
  state text not null default 'requested'
    check (state in ('requested', 'approved', 'rejected', 'ended')),
  end_reason text check (char_length(end_reason) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index support_sessions_host_idx on public.support_sessions (host_id);
create index support_sessions_helper_idx on public.support_sessions (helper_id);

alter table public.support_hosts enable row level security;
alter table public.support_sessions enable row level security;
alter table private.support_codes enable row level security;
alter table private.support_failures enable row level security;
alter table private.support_host_creations enable row level security;

create or replace function private.is_support_host_agent(p_host uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.support_hosts h
    where h.id = p_host and h.agent_user_id = (select auth.uid()) and h.expires_at > now()
  );
$$;
revoke all on function private.is_support_host_agent(uuid) from public, anon;
grant execute on function private.is_support_host_agent(uuid) to authenticated;

-- support_hosts: only the host's own temporary identity can read it.
create policy support_hosts_select on public.support_hosts for select to authenticated
  using (agent_user_id = (select auth.uid()));
revoke all on public.support_hosts from anon, authenticated;
grant select on public.support_hosts to authenticated;

-- support_sessions: helper and host read; helper may only end, host may
-- approve / reject / end. Rows are created by redeem_support_code().
create policy support_sessions_select on public.support_sessions for select to authenticated
  using (helper_id = (select auth.uid()) or (select private.is_support_host_agent(host_id)));
create policy support_sessions_update on public.support_sessions for update to authenticated
  using (helper_id = (select auth.uid()) or (select private.is_support_host_agent(host_id)))
  with check (
    (helper_id = (select auth.uid()) and state = 'ended')
    or ((select private.is_support_host_agent(host_id)) and state in ('approved', 'rejected', 'ended'))
  );
revoke all on public.support_sessions from anon, authenticated;
grant select on public.support_sessions to authenticated;
grant update (state, end_reason, ended_at, updated_at) on public.support_sessions to authenticated;

create trigger support_sessions_touch before update on public.support_sessions
  for each row execute function private.touch_updated_at();

create or replace function private.guard_support_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.state in ('rejected', 'ended') and new.state is distinct from old.state then
    raise exception 'session_finished' using errcode = 'P0001';
  end if;
  if old.state = 'requested' and new.state = 'approved' then
    null; -- consent given
  elsif new.state = 'approved' and old.state <> 'approved' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  if new.state in ('rejected', 'ended') and new.ended_at is null then
    new.ended_at := now();
  end if;
  return new;
end;
$$;
revoke all on function private.guard_support_session() from public, anon, authenticated;
create trigger support_sessions_guard before update on public.support_sessions
  for each row execute function private.guard_support_session();

-- Host: issue a one-time 12-digit code (5 min). Older codes are dropped.
create or replace function public.issue_support_code()
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_host uuid;
  v_code text;
begin
  select h.id into v_host from public.support_hosts h
  where h.agent_user_id = auth.uid() and h.expires_at > now();
  if v_host is null then
    raise exception 'not_a_support_host' using errcode = '42501';
  end if;
  delete from private.support_codes c where c.host_id = v_host;
  loop
    v_code := lpad((floor(random() * 1000000000000))::bigint::text, 12, '0');
    begin
      insert into private.support_codes (code, host_id, expires_at)
      values (v_code, v_host, now() + interval '5 minutes');
      exit;
    exception when unique_violation then
    end;
  end loop;
  return query select v_code, now() + interval '5 minutes';
end;
$$;
revoke all on function public.issue_support_code() from public, anon;
grant execute on function public.issue_support_code() to authenticated;

-- Helper: redeem a code → a support session waiting for the host's consent.
create or replace function public.redeem_support_code(p_code text, p_mode text default 'control')
returns table (session_id uuid, host_name text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  v_host uuid;
  v_name text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if (select count(*) from private.support_failures f
      where f.user_id = v_user and f.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  update private.support_codes c set used_at = now()
  where c.code = v_code and c.used_at is null and c.expires_at > now()
  returning c.host_id into v_host;
  if v_host is null then
    insert into private.support_failures (user_id) values (v_user);
    delete from private.support_failures f where f.created_at < now() - interval '1 day';
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;
  select h.name into v_name from public.support_hosts h where h.id = v_host and h.expires_at > now();
  if v_name is null then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;
  insert into public.support_sessions (host_id, helper_id, helper_email, host_name, mode)
  values (v_host, v_user, left(auth.jwt() ->> 'email', 320), v_name,
          case when p_mode = 'view' then 'view' else 'control' end)
  returning id into v_id;
  return query select v_id, v_name;
end;
$$;
revoke all on function public.redeem_support_code(text, text) from public, anon;
grant execute on function public.redeem_support_code(text, text) to authenticated;

-- Edge Function (service_role): rate limit creation of temporary hosts.
create or replace function public.register_support_host_attempt(p_client_key text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from private.support_host_creations c
      where c.client_key = p_client_key and c.created_at > now() - interval '1 hour') >= 20 then
    return false;
  end if;
  insert into private.support_host_creations (client_key) values (left(coalesce(p_client_key, '?'), 128));
  return true;
end;
$$;
revoke all on function public.register_support_host_attempt(text) from public, anon, authenticated;
grant execute on function public.register_support_host_attempt(text) to service_role;

-- Realtime: "support:<id>" topics for the helper and the host while open.
create or replace function private.can_use_support_topic(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_topic is null or p_topic !~ '^support:[0-9a-f-]{36}$' then
    return false;
  end if;
  v_id := substring(p_topic from 9)::uuid;
  return exists (
    select 1 from public.support_sessions s
    join public.support_hosts h on h.id = s.host_id
    where s.id = v_id and s.state in ('requested', 'approved')
      and (s.helper_id = (select auth.uid()) or h.agent_user_id = (select auth.uid()))
  );
end;
$$;
revoke all on function private.can_use_support_topic(text) from public, anon;
grant execute on function private.can_use_support_topic(text) to authenticated;

drop policy session_topic_read on realtime.messages;
drop policy session_topic_write on realtime.messages;
create policy session_topic_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      (select private.can_use_session_topic(realtime.topic()))
      or (select private.can_use_support_topic(realtime.topic()))
    )
  );
create policy session_topic_write on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and (
      (select private.can_use_session_topic(realtime.topic()))
      or (select private.can_use_support_topic(realtime.topic()))
    )
  );

alter table public.support_sessions replica identity full;
alter publication supabase_realtime add table public.support_sessions;

-- Hourly cleanup: expired temporary hosts (and their logins), old codes and
-- rate-limit rows, finished session rows older than 30 days.
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
end;
$$;
revoke all on function private.cleanup_support() from public, anon, authenticated;

select cron.schedule('remote-pc-cleanup', '17 * * * *', $$select private.cleanup_support()$$);

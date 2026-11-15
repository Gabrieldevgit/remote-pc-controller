-- Remote PC Controller core data model.
-- The mobile and desktop clients use only the publishable key. The relay owns
-- host tokens and writes host presence via a server-side service credential.

create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 64),
  platform text not null default 'windows' check (platform in ('windows', 'macos', 'linux')),
  device_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, display_name)
);

create table public.device_shares (
  device_id uuid not null references public.devices(id) on delete cascade,
  grantee_id uuid not null references auth.users(id) on delete cascade,
  permission text not null default 'control' check (permission in ('view', 'control')),
  created_at timestamptz not null default now(),
  primary key (device_id, grantee_id)
);

create table public.device_presence (
  device_id uuid primary key references public.devices(id) on delete cascade,
  online boolean not null default false,
  last_seen_at timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  requester_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'requested' check (state in ('requested', 'accepted', 'connected', 'ended', 'rejected')),
  attended boolean not null default false,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.device_shares enable row level security;
alter table public.device_presence enable row level security;
alter table public.support_sessions enable row level security;

-- A user may see their own profile and update only their own profile.
create policy "profiles_select_own" on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Devices are visible to their owner and explicitly shared grantees.
create policy "devices_select_authorized" on public.devices for select to authenticated
  using (
    (select auth.uid()) = owner_id
    or exists (
      select 1 from public.device_shares share
      where share.device_id = id and share.grantee_id = (select auth.uid())
    )
  );
create policy "devices_insert_own" on public.devices for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "devices_update_own" on public.devices for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "devices_delete_own" on public.devices for delete to authenticated
  using ((select auth.uid()) = owner_id);

create policy "shares_select_participants" on public.device_shares for select to authenticated
  using (
    grantee_id = (select auth.uid())
    or exists (
      select 1 from public.devices device
      where device.id = device_id and device.owner_id = (select auth.uid())
    )
  );
create policy "shares_manage_owner" on public.device_shares for all to authenticated
  using (
    exists (
      select 1 from public.devices device
      where device.id = device_id and device.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.devices device
      where device.id = device_id and device.owner_id = (select auth.uid())
    )
  );

create policy "presence_select_authorized" on public.device_presence for select to authenticated
  using (
    exists (
      select 1 from public.devices device
      where device.id = device_id and (
        device.owner_id = (select auth.uid())
        or exists (
          select 1 from public.device_shares share
          where share.device_id = device.id and share.grantee_id = (select auth.uid())
        )
      )
    )
  );

create policy "sessions_select_participants" on public.support_sessions for select to authenticated
  using (
    requester_id = (select auth.uid())
    or exists (
      select 1 from public.devices device
      where device.id = device_id and device.owner_id = (select auth.uid())
    )
  );
create policy "sessions_request_authorized_device" on public.support_sessions for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and exists (
      select 1 from public.devices device
      where device.id = device_id and (
        device.owner_id = (select auth.uid())
        or exists (
          select 1 from public.device_shares share
          where share.device_id = device.id
            and share.grantee_id = (select auth.uid())
            and share.permission = 'control'
        )
      )
    )
  );

-- Trigger is private and only executable by its owning role. It creates a
-- profile immediately after Supabase Auth creates a user.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''));
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.handle_new_user();

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select, insert, update, delete on public.device_shares to authenticated;
grant select on public.device_presence to authenticated;
grant select, insert on public.support_sessions to authenticated;

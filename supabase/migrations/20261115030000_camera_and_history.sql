-- Round 4: webcam quick actions and connection history.
--
--   * device_commands: 'camera_photo' (JPEG) and 'camera_record' (MP4,
--     params.seconds 1–30). Only the PC's owner can insert commands (RLS),
--     so Remote Support helpers can never use the camera.
--   * Storage bucket "screenshots" also takes video/mp4 (limit 50 MB).
--   * remote_sessions.client_name / support_sessions.client_name: which phone
--     connected ("Google Pixel 7 · Android 16"), set by the app.
--   * device_connection_history(): the owner's view of who connected to one
--     of their PCs, with the account email — used by Remote PC Host.

-- Camera commands --------------------------------------------------------------

alter table public.device_commands drop constraint device_commands_command_check;
alter table public.device_commands add constraint device_commands_command_check check (command in (
  'lock', 'shutdown', 'hibernate', 'restart', 'logoff',
  'volume_up', 'volume_down', 'mute', 'beep',
  'screenshot', 'process_list', 'process_kill', 'sysinfo',
  'camera_photo', 'camera_record'
));

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array['image/png', 'image/jpeg', 'video/mp4']
where id = 'screenshots';

-- Which phone connected ------------------------------------------------------------

alter table public.remote_sessions
  add column client_name text check (client_name is null or char_length(client_name) <= 80);
grant insert (device_id, client_name) on public.remote_sessions to authenticated;

alter table public.support_sessions
  add column client_name text check (client_name is null or char_length(client_name) <= 80);

drop function public.redeem_support_code(text, text);
create function public.redeem_support_code(p_code text, p_mode text default 'control', p_client text default null)
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
  insert into public.support_sessions (host_id, helper_id, helper_email, host_name, mode, client_name)
  values (v_host, v_user, left(auth.jwt() ->> 'email', 320), v_name,
          case when p_mode = 'view' then 'view' else 'control' end,
          nullif(left(btrim(coalesce(p_client, '')), 80), ''))
  returning id into v_id;
  return query select v_id, v_name;
end;
$$;
revoke all on function public.redeem_support_code(text, text, text) from public, anon;
grant execute on function public.redeem_support_code(text, text, text) to authenticated;

-- Connection history (owner only) ---------------------------------------------------

create function public.device_connection_history(p_device uuid, p_limit integer default 50)
returns table (
  id uuid,
  requester_email text,
  client_name text,
  state text,
  end_reason text,
  created_at timestamptz,
  ended_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_device_owner(p_device) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  return query
    select s.id, u.email::text, s.client_name, s.state, s.end_reason, s.created_at, s.ended_at
    from public.remote_sessions s
    left join auth.users u on u.id = s.requester_id
    where s.device_id = p_device
    order by s.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function public.device_connection_history(uuid, integer) from public, anon;
grant execute on function public.device_connection_history(uuid, integer) to authenticated;

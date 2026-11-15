drop policy sessions_update_requester on public.remote_sessions;
drop policy sessions_update_agent on public.remote_sessions;
-- Requester may only end; the device's agent may accept, reject or end.
create policy sessions_update on public.remote_sessions for update to authenticated
  using (requester_id = (select auth.uid()) or (select private.is_device_agent(device_id)))
  with check (
    (requester_id = (select auth.uid()) and state = 'ended')
    or ((select private.is_device_agent(device_id)) and state in ('accepted', 'rejected', 'ended'))
  );

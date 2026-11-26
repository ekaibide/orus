-- Uso del plan gratuito. Solo guardamos segundos transcritos: ni audio ni texto.

create table public.usage_monthly (
  user_id    uuid    not null references auth.users (id) on delete cascade,
  month      date    not null,               -- primer día del mes (UTC)
  seconds    integer not null default 0 check (seconds >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

-- Tope global diario: el servicio es gratis y cada minuto cuesta dinero; acota
-- el gasto máximo si alguien abre muchas cuentas.
create table public.usage_daily_global (
  day     date   primary key,
  seconds bigint not null default 0 check (seconds >= 0)
);

alter table public.usage_monthly      enable row level security;
alter table public.usage_daily_global enable row level security;

-- Cada usuario puede leer su propio consumo; nadie escribe desde el cliente.
create policy "usage_monthly: leer el propio"
  on public.usage_monthly for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.usage_monthly      from anon;
revoke insert, update, delete on public.usage_monthly from authenticated;
revoke all on public.usage_daily_global from anon, authenticated;

-- Suma atómica del consumo (la llama solo la Edge Function con service_role).
create function public.record_usage(p_user uuid, p_seconds integer)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.usage_monthly (user_id, month, seconds)
  values (p_user, date_trunc('month', now() at time zone 'utc')::date, p_seconds)
  on conflict (user_id, month)
  do update set seconds = public.usage_monthly.seconds + excluded.seconds,
                updated_at = now();

  insert into public.usage_daily_global (day, seconds)
  values ((now() at time zone 'utc')::date, p_seconds)
  on conflict (day)
  do update set seconds = public.usage_daily_global.seconds + excluded.seconds;
$$;

create function public.quota_status(p_user uuid)
returns table (used_month integer, used_today_global bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select seconds from public.usage_monthly
              where user_id = p_user
                and month = date_trunc('month', now() at time zone 'utc')::date), 0),
    coalesce((select seconds from public.usage_daily_global
              where day = (now() at time zone 'utc')::date), 0);
$$;

revoke execute on function public.record_usage(uuid, integer) from public, anon, authenticated;
revoke execute on function public.quota_status(uuid)          from public, anon, authenticated;
grant  execute on function public.record_usage(uuid, integer) to service_role;
grant  execute on function public.quota_status(uuid)          to service_role;

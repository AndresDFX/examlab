-- Hace más robusto el broadcast de notificaciones por realtime:
--
--  1. REPLICA IDENTITY FULL: asegura que los eventos enviados al
--     listener incluyan TODAS las columnas (incluyendo user_id),
--     no solo la PK. Sin esto, en algunas configuraciones el
--     filter `user_id=eq.{userId}` no matchea porque user_id no
--     viaja en el payload de logical replication.
--
--  2. La tabla ya estaba en la publication supabase_realtime
--     (migración 20260419080000), pero re-aplicamos por
--     idempotencia — `add table` falla si ya existe, así que
--     usamos un do-block que ignora el error.

alter table public.notifications replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception
    when duplicate_object then
      null;
    when undefined_object then
      -- La publication no existe (entornos custom). La creamos.
      create publication supabase_realtime for table public.notifications;
  end;
end $$;

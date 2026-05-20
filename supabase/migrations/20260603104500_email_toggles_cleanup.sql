-- ──────────────────────────────────────────────────────────────────────
-- Limpieza de toggles de `email_settings.enabled_kinds`.
--
-- Diagnóstico previo a esta migración:
--
--   • `summary` — toggle declarado en la migración 20260523000009 pero
--     SIN sender real. No existe trigger ni cron que cree notifications
--     con `kind='summary'`. El toggle es dormido.
--     → DECISIÓN: removerlo del default y del shape esperado por la UI.
--       Si el admin lo tenía guardado como true/false, la columna JSONB
--       lo conserva pero la UI ya no lo expone.
--
--   • `system_alerts` (NUEVO) — alertas de almacenamiento a admins
--     (kind='system' + link '/app/admin/system' creadas por la función
--     `notify_admins_storage_threshold` en 20260523000010). HOY se
--     emailan SIN toggle: el predicado `_notification_kind_emails`
--     permite que pasen, y en `send-email` el `categoryKey` cae a
--     "system" pero el panel no lo expone. El admin no podía
--     silenciarlas sin tocar SQL.
--     → DECISIÓN: agregar `system_alerts: true` por default. La edge
--       function se actualiza para mapear este kind+link al categoryKey
--       y respetar el toggle.
--
--   • `grade` — confirmado SÍ se usa (client code en workshops/projects
--     emite `kind='grade'` al publicar nota). Toggle queda como está.
--
--   • `info` — no necesita toggle propio: solo emailamos `info` cuando
--     link comienza con `/app/messages`, y eso ya lo cubre el toggle
--     `messages` vía el `categoryKey` map del edge. Otros `info` nunca
--     llegan al sender (predicate `_notification_kind_emails` los
--     filtra antes).
--
--   • Password reset (`system` + `/auth/reset-password`) y email change
--     (`system` + `/auth/confirm-email-change`) → transaccionales,
--     intencionalmente sin toggle (el usuario perdería acceso si los
--     desactiva).
-- ──────────────────────────────────────────────────────────────────────

-- 1) Actualiza el DEFAULT del JSONB para nuevas filas (si algún día se
--    recrea el singleton). Quita `summary`, agrega `system_alerts`.
ALTER TABLE public.email_settings
  ALTER COLUMN enabled_kinds SET DEFAULT jsonb_build_object(
    'exam',          TRUE,
    'workshop',      TRUE,
    'project',       TRUE,
    'grade',         TRUE,
    'feedback',      TRUE,
    'messages',      TRUE,
    'system_alerts', TRUE
  );

-- 2) Para la fila singleton existente: agregar `system_alerts: true` si
--    no existe; remover `summary`. `jsonb_set` con `create_missing`
--    + `||` operator + `-` (delete key) cubre las dos en un UPDATE.
UPDATE public.email_settings
   SET enabled_kinds = (enabled_kinds - 'summary')
                       || jsonb_build_object('system_alerts', COALESCE(enabled_kinds->'system_alerts', 'true'::jsonb))
 WHERE id = 1;

NOTIFY pgrst, 'reload schema';

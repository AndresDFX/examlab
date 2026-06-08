-- ──────────────────────────────────────────────────────────────────────
-- Soporte: permitir ELIMINAR (soft-delete) un ticket por el Admin que lo
-- CREÓ, o por el SuperAdmin.
--
-- Contexto: la mig 20260904000000 dejó `support_tickets` con columnas
-- deleted_at/deleted_by y una policy DELETE que solo permitía al
-- SuperAdmin (hard-delete físico). El Admin no podía deshacerse de un
-- ticket que abrió por error — solo "cerrarlo".
--
-- Decisión: en vez de exponer un UPDATE directo de deleted_at (que el
-- Admin podría usar para tocar otros campos vía el mismo UPDATE), o
-- relajar la policy DELETE (que sería hard-delete físico irreversible),
-- agregamos una RPC dedicada `soft_delete_support_ticket(_ticket_id)`:
--   - SECURITY DEFINER: corre con privilegios elevados, así que NO
--     depende de la policy UPDATE de la tabla.
--   - Autoriza explícitamente: creator del ticket O SuperAdmin.
--   - Setea deleted_at = now(), deleted_by = auth.uid().
--   - RAISE EXCEPTION en español si no autorizado (P0001 deja pasar el
--     mensaje al cliente vía friendlyError).
--
-- Las listas (Admin + SuperAdmin) ya filtran `is('deleted_at', null)`,
-- así que el ticket desaparece de ambas vistas tras el soft-delete.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.support_tickets') IS NULL THEN
    RAISE NOTICE 'Tabla public.support_tickets no existe — se omite la RPC de soft-delete';
    RETURN;
  END IF;

  -- DROP previo defensivo por si redespliega con otra firma.
  DROP FUNCTION IF EXISTS public.soft_delete_support_ticket(UUID);

  EXECUTE $fn$
    CREATE FUNCTION public.soft_delete_support_ticket(_ticket_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $body$
    DECLARE
      v_created_by UUID;
      v_deleted_at TIMESTAMPTZ;
    BEGIN
      SELECT created_by, deleted_at
        INTO v_created_by, v_deleted_at
        FROM public.support_tickets
       WHERE id = _ticket_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'El ticket no existe.' USING ERRCODE = 'P0001';
      END IF;

      -- Idempotente: si ya está borrado, no hacemos nada (no es error).
      IF v_deleted_at IS NOT NULL THEN
        RETURN;
      END IF;

      -- Autorización: solo el creador del ticket o un SuperAdmin.
      IF NOT (v_created_by = auth.uid() OR public.is_super_admin()) THEN
        RAISE EXCEPTION 'No tienes permiso para eliminar este ticket.' USING ERRCODE = 'P0001';
      END IF;

      UPDATE public.support_tickets
         SET deleted_at = now(),
             deleted_by = auth.uid()
       WHERE id = _ticket_id;

      -- Auditoría best-effort (no aborta el soft-delete si falla).
      BEGIN
        PERFORM public.log_audit_event(
          'support.ticket_deleted',
          'support',
          'warning',
          'support_ticket',
          _ticket_id::text,
          NULL,
          NULL,
          NULL,
          jsonb_build_object('created_by', v_created_by)
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END;
    $body$;
  $fn$;

  GRANT EXECUTE ON FUNCTION public.soft_delete_support_ticket(UUID) TO authenticated;
END $$;

NOTIFY pgrst, 'reload schema';

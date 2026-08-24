-- ══════════════════════════════════════════════════════════════════════
-- Las pruebas diagnósticas de UNIAJ pasan a 5 advertencias (estaban en 3).
--
-- Pedido del docente: en las diagnósticas el margen de 3 es muy corto. Tiene
-- sentido: la diagnóstica pesa 0% y su propósito es medir de dónde parte el
-- grupo, así que auto-entregar por tres cambios de pestaña castiga un problema
-- de manejo del navegador —en el primer examen del semestre, cuando el alumno
-- todavía no conoce la plataforma— y no un intento de copiar. En los parciales
-- el umbral sigue en 3.
--
-- ── Por qué una migración y no un UPDATE a mano ───────────────────────
-- Es un cambio de DATOS en producción. Por migración queda en el historial:
-- qué se cambió, cuándo y con qué criterio. Un UPDATE en el SQL Editor no deja
-- rastro de la intención, y esa es justamente la información que hace falta
-- cuando alguien pregunte "¿por qué esta diagnóstica tolera 5 y el parcial 3?".
--
-- ── El filtro, y por qué es así de estrecho ───────────────────────────
-- Se acota por CUATRO condiciones a la vez, porque `title = 'Prueba
-- diagnóstica'` por sí solo podría existir en otra institución:
--   · el curso pertenece al tenant `uniaj` (por slug, no por UUID hardcodeado);
--   · el título es exactamente 'Prueba diagnóstica';
--   · `weight = 0` — es lo que DEFINE a la diagnóstica en este modelo, y la
--     distingue de cualquier examen que se llame parecido;
--   · no está en la papelera.
--
-- Verificado por consulta antes de escribir esto: son exactamente 4 filas, una
-- por curso 2026-2 (Arquitectura, Bases de Datos II, Programación II y
-- Seminario), todas con `max_warnings = 3` y `weight = 0`.
--
-- Idempotente (`max_warnings <> 5`) y con NOTICE del conteo, para que el log
-- del deploy diga cuántas filas se tocaron de verdad en vez de dejarlo a la fe.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actualizadas INT := 0;
BEGIN
  IF to_regclass('public.exams') IS NULL OR to_regclass('public.tenants') IS NULL THEN
    RAISE NOTICE 'exams o tenants ausente — se omite el ajuste de advertencias';
    RETURN;
  END IF;

  UPDATE public.exams e
     SET max_warnings = 5,
         updated_at   = now()
   WHERE e.title      = 'Prueba diagnóstica'
     AND e.weight     = 0
     AND e.deleted_at IS NULL
     AND e.max_warnings <> 5
     AND EXISTS (
       SELECT 1
         FROM public.courses c
         JOIN public.tenants t ON t.id = c.tenant_id
        WHERE c.id = e.course_id
          AND t.slug = 'uniaj'
          AND c.deleted_at IS NULL
     );

  GET DIAGNOSTICS v_actualizadas = ROW_COUNT;
  RAISE NOTICE 'Diagnósticas de UNIAJ con max_warnings=5: % fila(s) actualizada(s)', v_actualizadas;

  -- El CHECK de la columna admite 1..50 (mig 20260504100000), así que 5 entra
  -- sin tocar la restricción.
END $$;

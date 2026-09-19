-- Le da aire al rol con el que PostgREST carga su CATÁLOGO, sin tocar el que
-- acota las consultas de los usuarios.
--
-- ── La caída del 2026-09-19, medida ──────────────────────────────────
-- Los cinco servicios del proyecto quedaron en Unhealthy y los estudiantes
-- recibían 504 en `PATCH /submissions` y `GET /notifications` — o sea, justo
-- al entregar. La base NUNCA estuvo caída: 181 MB, 31 de 60 conexiones, sin
-- cadenas de bloqueo y con el log de Postgres limpio. Lo que se cayó fue
-- PostgREST, y la cadena es esta:
--
--   1. La instancia es la más chica (shared_buffers 224 MB) y su E/S va por
--      créditos. Al agotarlos, `SELECT name FROM pg_timezone_names` —que lee
--      los ~1.196 husos del disco y que PostgREST corre en CADA recarga de su
--      caché de esquema— pasó de 55 ms a 3.496 / 7.666 / 16.887 ms. Medido tres
--      veces seguidas, y confirmado por `pg_stat_statements`, donde esa consulta
--      encabezaba el gasto de TODA la base: 838 ms de promedio, 178 s totales,
--      por encima de cualquier consulta de la aplicación.
--   2. `authenticator` tenía `statement_timeout = 8s`, así que la recarga se
--      cancelaba con 57014 antes de terminar.
--   3. PostgREST reintenta, y cada intento retiene una de sus ~10 conexiones
--      del pool. El pool se agota → `PGRST003: Timed out acquiring connection
--      from connection pool` → 504 para todo el mundo.
--
-- Es una espiral que no sale sola: mientras la E/S siga lenta, cada reintento
-- vuelve a fallar por el mismo timeout. Subir el tope a 30 s la corta de raíz —
-- la recarga termina aunque la instancia esté lenta, y el servicio sigue de pie.
-- Verificado: tras aplicarlo, los cinco servicios volvieron a ACTIVE_HEALTHY sin
-- reiniciar nada, y el REST volvió a responder 200 en ~0,3 s.
--
-- ── Por qué SOLO `authenticator` ─────────────────────────────────────
-- `authenticator` es el rol con el que PostgREST se conecta; las consultas de
-- los usuarios corren DESPUÉS de un `SET ROLE authenticated`/`anon`, que
-- conservan sus propios 8 s y 3 s. O sea: esto no le afila el cuchillo a nadie
-- para dejar una consulta pesada corriendo media hora — solo permite que
-- PostgREST termine de leer el catálogo. Subir el `statement_timeout` GLOBAL
-- sería lo contrario de lo que queremos: ahí sí una consulta cara de un
-- estudiante podría comerse una conexión por 30 s.
--
-- ── Lo que NO arregla ────────────────────────────────────────────────
-- El tamaño de la instancia. 132 relaciones, 399 funciones, 384 policies y
-- 1.994 columnas es un catálogo grande para el tier más chico, y cada recarga
-- lo recorre entero. Esto evita que una recarga lenta tumbe el servicio; no
-- hace que la recarga sea rápida.

DO $$
BEGIN
  -- Defensivo a propósito: en un entorno donde el rol de la migración no tenga
  -- ADMIN sobre `authenticator` (un Postgres local, un branch de Supabase), un
  -- ALTER ROLE suelto aborta el deploy ENTERO por un ajuste de rendimiento.
  -- Preferimos que quede sin aplicar y visible en el log.
  EXECUTE 'ALTER ROLE authenticator SET statement_timeout = ''30s''';
EXCEPTION
  WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE 'No se pudo ajustar statement_timeout de authenticator (%). Aplicar a mano en el SQL Editor.', SQLERRM;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- Corrección de dato: el nombre del vocero en dos Acuerdos Pedagógicos.
--
-- Los Acuerdos de Programación II y Seminario de Sistemas (generados el
-- 2026-09-02) imprimen «Josuan» en la casilla «Nombre del vocero». El perfil
-- dice «Beltran Castaño Josuhan David» —el nombre se corrigió DESPUÉS de
-- generar el documento— y el bloque de firma del pie, que se resuelve en
-- vivo, ya muestra el nombre bueno. O sea que el MISMO documento se
-- contradice: arriba una foto vieja, abajo el dato actual.
--
-- Va por migración y no por REST porque `generated_reports` no tiene policy
-- de UPDATE (mig 20260975000000): tiene SELECT, INSERT y DELETE. Un informe
-- generado es inmutable para la aplicación —se regenera o se borra, no se
-- edita—, así que un PATCH devuelve 204 y no toca ninguna fila. Esta
-- migración corre como propietario y se salta la RLS, que es justamente por
-- lo que deja rastro versionado de un cambio sobre un documento firmado.
--
-- Sobre las firmas: `signed_hash` se calcula sobre el snapshot al firmar y
-- NADA lo recalcula después, así que las 22 firmas puestas en cada documento
-- siguen siendo válidas y verificables. Las que se pongan de ahora en más
-- tendrán un hash distinto, y eso ya no produce ninguna alerta: el aviso de
-- «firmas sobre versiones distintas» se retiró en el mismo cambio, porque el
-- Acuerdo Pedagógico es un documento VIVO y corregirlo es lo correcto, no una
-- anomalía.
--
-- El reemplazo se ancla a `>Josuan<` (con las etiquetas) y no al nombre
-- suelto: es una celda de tabla, y así no se toca ninguna otra aparición del
-- texto. Verificado contra producción: la cadena aparece EXACTAMENTE una vez
-- en cada uno de los dos documentos, y en ningún otro.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tocadas int;
BEGIN
  IF to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'generated_reports no existe en este entorno; nada que corregir.';
    RETURN;
  END IF;

  UPDATE public.generated_reports
     SET html = replace(html, '>Josuan<', '>Beltran Castaño Josuhan David<')
   WHERE id IN (
           '9c8edc13-d3aa-44aa-bee9-f5f520571b04',  -- Programación II 2026-2 341C
           'dddff24d-554a-4e2f-9422-f38d3d0c3062'   -- Seminario de Sistemas 2026-2 341C
         )
     AND html LIKE '%>Josuan<%';

  GET DIAGNOSTICS v_tocadas = ROW_COUNT;

  -- Sin excepción si son 0: el entorno del usuario puede no tener estos
  -- documentos (son filas de producción), y abortar ahí tumbaría el deploy
  -- entero por una corrección de dato puntual.
  RAISE NOTICE 'Acuerdos con el nombre del vocero corregido: %', v_tocadas;
END $$;

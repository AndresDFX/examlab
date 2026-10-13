-- Tope por archivo del bucket `project-files`: 50 MB, el mismo que anuncia y valida la pantalla de entrega
-- (`MAX_CODE_FILES_TOTAL_BYTES` en src/shared/lib/code-upload.ts) y el que ya tiene `workshop-files`.
--
-- Medido el 2026-10-12: en producción el bucket estaba en 10 MB. Las migraciones que lo crean
-- (20260507160000 y 20260530100000) dicen 100 MB, pero usan `ON CONFLICT DO NOTHING`, así que el valor real
-- lo había dejado un cambio a mano en el panel. Con la entrega ZIP configurable (un proyecto final con su
-- informe, diagramas y capturas en un solo ZIP), un ZIP de 12 MB pasaba la validación del navegador y
-- fallaba recién al subirse, sin que el estudiante entendiera por qué.
--
-- No se toca `allowed_mime_types`: ya está en NULL (se sube cualquier tipo; lo que se acepta lo decide la
-- configuración de cada entrega, ver supabase/functions/_shared/contenido-zip.ts).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets SET file_size_limit = 52428800 WHERE id = 'project-files';
  END IF;
END $$;

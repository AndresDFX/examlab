-- ============================================================
-- Proyectos: unificar el tipo "código" a `codigo_zip`.
--
-- Motivación: en talleres una pregunta "código" se contesta con UN
-- archivo escrito en un textarea (CodeEditor). En proyectos eso no
-- aplica — el entregable es UN ZIP con TODOS los archivos del código
-- fuente del estudiante. Conservar el tipo `codigo` (textarea) en
-- `project_files` confunde al docente y al estudiante (la UI ofrecía
-- ambos tipos casi idénticos).
--
-- Cambio: las preguntas existentes con `type='codigo'` o `type='java_gui'`
-- en `project_files` se reescriben a `type='codigo_zip'`. La UI nueva
-- solo deja crear los 4 tipos paralelos a talleres: abierta, cerrada,
-- diagrama, codigo (que internamente es `codigo_zip`).
--
-- Las entregas previas (rows en `project_submission_files` con
-- `content` lleno y sin `zip_path`) NO se borran — el docente puede
-- seguir viendo lo entregado. Solo cambia la UI de futuras subidas:
-- a partir de esta migración, las preguntas aceptan ZIP en lugar de
-- texto plano.
-- ============================================================

UPDATE public.project_files
   SET type = 'codigo_zip',
       -- starter_code no aplica al ZIP (no hay editor inline). Lo
       -- limpiamos para no confundir al estudiante con código de
       -- arranque que ya no se va a usar.
       starter_code = NULL
 WHERE type IN ('codigo', 'java_gui');

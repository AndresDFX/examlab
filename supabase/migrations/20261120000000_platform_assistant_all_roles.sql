-- ══════════════════════════════════════════════════════════════════════
-- Asistente IA de plataforma para TODOS los roles (no solo Admin).
--
-- Ya existe el asistente de plataforma (edge platform-support-chat + tablas
-- platform_support_sessions/messages + KB global platform_kb_docs), pero está
-- gateado a Admin/SuperAdmin por: (1) el WITH CHECK del INSERT de
-- platform_support_sessions y (2) module_visibility solo para Admin/SA.
--
-- Esta migración abre la BASE para que estudiantes y docentes también tengan
-- su asistente de uso de la plataforma. El rollout de UI (ruta/nav) + el prompt
-- role-aware + FAQs van en el código (fase siguiente).
--
-- platform_kb_docs es GLOBAL (sin tenant_id) y su SELECT es USING(true) → ya es
-- cross-tenant y legible por todos. Tiene columna `audience` para segmentar por
-- rol; hoy solo hay docs audience='admin'. Sembramos algunas de 'estudiante' y
-- 'docente' para que el asistente responda con base a cada rol ("aliméntalo").
-- ══════════════════════════════════════════════════════════════════════

-- 1) RLS: cualquier usuario autenticado puede crear SU propia sesión de
--    asistente (owner-scoped), igual que las policies de SELECT/UPDATE/DELETE
--    que ya eran owner-only. Quitamos el gate Admin/SA del INSERT.
DO $$
BEGIN
  IF to_regclass('public.platform_support_sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS platform_support_sessions_insert ON public.platform_support_sessions;
    CREATE POLICY platform_support_sessions_insert
      ON public.platform_support_sessions
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- 2) module_visibility: filas GLOBALES (tenant_id IS NULL) para que el módulo
--    del asistente esté disponible a Docente y Estudiante en TODOS los tenants
--    (la resolución hace fallback a global; la provisión de tenant no siembra
--    module_visibility). Admin/SA ya existen. Idempotente.
DO $$
DECLARE
  r text;
BEGIN
  IF to_regclass('public.module_visibility') IS NOT NULL THEN
    FOREACH r IN ARRAY ARRAY['Docente', 'Estudiante'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.module_visibility
        WHERE module_key = 'support_assistant' AND role = r AND tenant_id IS NULL
      ) THEN
        INSERT INTO public.module_visibility (module_key, role, enabled, display_order, tenant_id)
        VALUES ('support_assistant', r, true, 235, NULL);
      END IF;
    END LOOP;
  END IF;
END $$;

-- 3) Semilla de KB por audiencia (estudiante / docente). Contenido de uso de la
--    plataforma escrito para cada rol. ON CONFLICT (slug) DO NOTHING → idempotente
--    y no pisa ediciones del SuperAdmin.
DO $$
BEGIN
  IF to_regclass('public.platform_kb_docs') IS NOT NULL THEN
    INSERT INTO public.platform_kb_docs (slug, title, audience, body, position) VALUES
    ('est-tomar-examen', 'Cómo presentar un examen', 'estudiante',
$md$## Presentar un examen
1. En el menú lateral entra a **Exámenes**. Verás los exámenes asignados con su estado (pendiente, en curso, entregado).
2. Toca **Iniciar** en el examen disponible. Lee las instrucciones: si es de navegación *secuencial* no podrás regresar a preguntas anteriores.
3. Responde. Tus respuestas se **autoguardan** cada pocos segundos; si se corta el internet, se sincronizan al volver.
4. El **temporizador** arriba muestra el tiempo restante. Al llegar a 0 el examen se entrega solo.
5. Evita salir de pantalla completa o cambiar de pestaña: el sistema registra advertencias (proctoring) y a las 3 puede marcar la entrega como sospechosa.
6. Pulsa **Entregar** cuando termines. Si dejaste preguntas en blanco, te pedirá confirmación.$md$, 100),
    ('est-entregar-taller-proyecto', 'Cómo entregar un taller o proyecto', 'estudiante',
$md$## Entregar un taller o un proyecto
- **Talleres**: menú **Talleres** → abre el taller → responde cada pregunta (texto, opción, código, diagrama). Pulsa **Entregar**. Si es en grupo, cualquier integrante edita la misma entrega.
- **Proyectos**: menú **Proyectos** → sube los archivos pedidos (documento, diagrama y, si aplica, un **.zip** con el código) y pega el **enlace al repositorio** (obligatorio). La nota final del proyecto se completa tras la **sustentación** con el docente.
- Puedes ver la retroalimentación y la nota en **Mis notas** cuando el docente califique.$md$, 110),
    ('est-asistencia-qr', 'Cómo marcar asistencia con el código QR', 'estudiante',
$md$## Marcar asistencia (check-in)
Cuando el docente abre el check-in en clase:
1. Entra a **Asistencia**. Arriba aparece la tarjeta **Check-in disponible**.
2. Escanea el **QR** que proyecta el docente con el botón de cámara, o escribe el **código de 6 dígitos** que se muestra.
3. El código rota cada minuto: si expira, vuelve a escanear el nuevo.
4. Verás confirmación de que quedaste **presente**.$md$, 120),
    ('doc-crear-curso-cortes', 'Cómo crear un curso y definir cortes y pesos', 'docente',
$md$## Crear un curso y configurar la evaluación
1. Menú **Cursos** → **Nuevo curso**: nombre, periodo, escala de notas y fechas.
2. Define los **cortes** (parciales). Cada corte tiene un **peso** = % de la nota final; los cortes deben sumar 100.
3. Dentro de cada corte, reparte el peso entre **talleres**, **exámenes**, **proyectos** y **asistencia** (los "buckets"). Cada actividad de un tipo no puede exceder su bucket.
4. Matricula estudiantes desde **Gestionar estudiantes** del curso o impórtalos en **Usuarios**. Al inscribirlos reciben un correo de bienvenida al curso.$md$, 200),
    ('doc-crear-evaluaciones', 'Cómo crear exámenes, talleres y proyectos', 'docente',
$md$## Crear evaluaciones
- **Examen**: menú **Exámenes** → **Nuevo**. Elige el/los curso(s), fechas, duración, tipo de navegación y proctoring. Agrega preguntas (abierta, opción, código, red, etc.) o genera con IA.
- **Taller**: menú **Talleres** → **Nuevo**. Igual que el examen pero con fecha de entrega; admite trabajo en grupo.
- **Proyecto**: menú **Proyectos** → **Nuevo**. Define los archivos esperados y si exige sustentación.
- Puedes **generar preguntas con IA** y ajustar el peso de cada actividad dentro del corte. Al crear/editar, el selector prioriza el curso actual y los cursos abiertos.$md$, 210),
    ('doc-calificar-ia', 'Cómo se califica con IA y cómo ajustar notas', 'docente',
$md$## Calificación con IA y ajuste manual
1. Cuando un estudiante entrega, la IA puede pre-calificar (según la configuración del tenant) y deja una nota sugerida + retroalimentación.
2. Revisa en el **monitor del examen** o en el diálogo de calificación del taller/proyecto. Puedes **sobrescribir** la nota y editar la retroalimentación.
3. Todo cambio manual de nota que hace un docente/admin queda en **Auditoría** (quién, cuándo, IP, valor anterior→nuevo) — las notas puestas por la IA no se auditan.
4. Consolida las notas por corte en el **Gradebook** y expórtalas a CSV.$md$, 220)
    ON CONFLICT (slug) DO NOTHING;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

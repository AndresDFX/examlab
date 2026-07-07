-- ──────────────────────────────────────────────────────────────────────
-- Base de conocimiento (KB) del Asistente IA de plataforma.
--
-- Documentación de USO de ExamLab, una fila por sección del manual del
-- administrador (docs/demos/manual/manual-administrador.md). El edge
-- `platform-support-chat` la carga (audience IN ('admin','all')) ordenada
-- por `position` y la inyecta en el placeholder {{platform_kb}} del prompt.
--
-- Es documentación pública de uso (no dato sensible): SELECT abierto a
-- authenticated; solo el SuperAdmin escribe (mantiene el manual central).
-- Idempotente: INSERT ... ON CONFLICT (slug) DO UPDATE.
-- Guards to_regclass por si el deploy corre antes de tener la tabla.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_kb_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'admin'
    CHECK (audience IN ('admin', 'docente', 'estudiante', 'all')),
  body TEXT NOT NULL,
  position INT DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

ALTER TABLE public.platform_kb_docs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_kb_docs_select" ON public.platform_kb_docs;
CREATE POLICY "platform_kb_docs_select"
  ON public.platform_kb_docs FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "platform_kb_docs_insert" ON public.platform_kb_docs;
CREATE POLICY "platform_kb_docs_insert"
  ON public.platform_kb_docs FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "platform_kb_docs_update" ON public.platform_kb_docs;
CREATE POLICY "platform_kb_docs_update"
  ON public.platform_kb_docs FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "platform_kb_docs_delete" ON public.platform_kb_docs;
CREATE POLICY "platform_kb_docs_delete"
  ON public.platform_kb_docs FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ── Seed: una fila por sección del manual del administrador ──────────
DO $$
BEGIN
  IF to_regclass('public.platform_kb_docs') IS NULL THEN
    RAISE NOTICE 'skip platform_kb_docs seed: tabla ausente';
    RETURN;
  END IF;

  INSERT INTO public.platform_kb_docs (slug, title, audience, body, position) VALUES
  (
    'panel', 'Panel (Dashboard)', 'admin',
    $kb$Es la pantalla de inicio del Admin: un resumen accionable del estado de la institución (módulo "Dashboard" del menú lateral).

- Revisa las 4 tarjetas superiores: cursos, usuarios, pendientes por calificar y pendientes del docente.
- Usa los dos cuadros inferiores (cursos recientes y actividad reciente) para entrar directo a lo que está pasando hoy.
- Haz clic en cualquier tarjeta o ítem para saltar al módulo correspondiente.$kb$,
    10
  ),
  (
    'cron-ia', 'Cron IA (cola de IA)', 'admin',
    $kb$Centraliza el seguimiento del trabajo que la IA hace en segundo plano: calificación automática y generación de evaluaciones/contenido. Está en el módulo "Cron" (o "Cola") del menú lateral.

- En la pestaña Jobs ves la cola de calificación y de generación con su estado (pendiente, en proceso, fallado, listo). Los jobs en proceso muestran cuánto llevan y se marcan en ámbar si quedan atascados.
- Expande una fila para ver el detalle y el error completo si algo falló; puedes Reintentar, Procesar ahora o Cancelar un job.
- "Procesar todos" drena la cola procesando los jobs uno a uno; si quedan pendientes, reintenta automáticamente hasta 3 veces y solo entonces te avisa que esperes unos minutos.
- Con selección múltiple, "Volver a la cola" devuelve los jobs marcados a pendiente y "Eliminar" los quita definitivamente. "Liberar atascados" rescata los jobs colgados en proceso.
- Útil cuando un docente reporta que "la IA no calificó": acá confirmas si quedó encolado y lo reprocesas.$kb$,
    20
  ),
  (
    'prompts-ia-modelo', 'Prompts de IA y modelo', 'admin',
    $kb$Controla cómo se comporta la IA en toda la institución. Está en el módulo "Prompts" del menú lateral, con dos pestañas.

- Pestaña Prompts: editas los textos base que guían a la IA en calificación de talleres, proyectos y exámenes, generación de contenidos y el Tutor IA; puedes restaurar el valor por defecto.
- Pestaña Modelo: eliges el proveedor (Gemini u OpenAI), el modelo específico y las claves de API (principal + respaldo para failover).
- Aquí decides el modo de la cola: sync (la IA responde al instante, dentro del formulario) o async (la generación se encola para controlar el gasto y un proceso la drena después).$kb$,
    30
  ),
  (
    'banco-de-preguntas', 'Banco de preguntas', 'admin',
    $kb$Repositorio de preguntas reutilizables por curso, para armar exámenes y talleres más rápido sin volver a redactarlas. Está en el módulo "Banco de preguntas".

- Selecciona un curso en el filtro superior; el banco vive por curso.
- Crea preguntas con "Nueva pregunta", edítalas, duplícalas o elimínalas con el menú de cada fila.
- Reaprovecha estas preguntas al construir evaluaciones, en lugar de escribirlas cada vez.$kb$,
    40
  ),
  (
    'cursos', 'Cursos, cortes y pesos de evaluación', 'admin',
    $kb$Es el corazón de la operación académica (módulo "Cursos"): aquí se crean los cursos y se definen sus cortes y pesos de evaluación.

- Crea un curso, asígnale docentes y matricula estudiantes.
- Define los cortes y cómo se reparte la nota final: cada corte tiene un peso (los cortes suman 100) y dentro del corte se reparte entre exámenes, talleres, proyectos y asistencia (esos "buckets" suman el peso del corte). Cada examen/taller/proyecto lleva su propio peso, tope del bucket de su tipo.
- Una actividad sin nota cuenta como 0 con su peso hasta que se califique (no se re-escala).
- Usa el buscador, el orden por columna y las acciones de fila (gestionar, duplicar, eliminar) para administrar muchos cursos.
- Diagnóstico del curso: escaneo del estado en pestañas (Calificaciones, Errores IA, Conversaciones, Asistencia). En Calificaciones ves la matriz estudiante × actividad con lo accionable resaltado: entregas sin calificar, errores de IA y proyectos que faltan sustentación. "Calificar todos con IA" encola de una sola vez todas las entregas pendientes.$kb$,
    50
  ),
  (
    'contenidos', 'Contenidos', 'admin',
    $kb$Material didáctico del curso que el estudiante consulta por sesión (módulo "Contenidos").

- Sube archivos (.md, .docx, .pptx, imágenes, PDF, .py/.java/.js, .ipynb) y asígnalos a una clase.
- Las imágenes y PDF se ven en línea; las imágenes se pueden anotar/editar y el código y notebooks se pueden ejecutar.
- Con IA: genera material didáctico automáticamente a partir de un tema, ahorrando la redacción inicial.$kb$,
    60
  ),
  (
    'videos', 'Videos', 'admin',
    $kb$Biblioteca de videos para apoyar las clases, asociados a un curso o globales para toda la institución (módulo "Videos").

- Agrega un video (por URL) y márcalo como global o de un curso específico.
- Filtra y ordena con las estadísticas superiores (Total, En curso, Globales).
- Para quitar un video usa Eliminar (es permanente; los videos no pasan por la Papelera).$kb$,
    70
  ),
  (
    'examenes', 'Exámenes', 'admin',
    $kb$Crea y administra evaluaciones, presenciales o en línea, con control de proctoring y calificación automática (módulo "Exámenes").

- Define preguntas, duración, navegación (libre o secuencial) y reglas anti-trampa; o marca el examen como externo para solo registrar notas.
- Con IA: genera preguntas automáticamente y deja que la IA califique las respuestas abiertas y de código.
- Antifraude con IA: la calificación detecta respuestas sospechosas y la plataforma compara entregas entre estudiantes para señalar posibles copias.$kb$,
    80
  ),
  (
    'talleres', 'Talleres', 'admin',
    $kb$Actividades prácticas, individuales o en grupo, que el estudiante entrega para ser calificadas (módulo "Talleres").

- Crea el taller, define sus preguntas y, si quieres, activa trabajo en grupo (una sola entrega y nota por grupo).
- Con IA: genera las preguntas y obtén calificación automática de las entregas.
- Marca el taller como externo cuando solo necesitas registrar notas de algo ya realizado fuera de la plataforma.$kb$,
    90
  ),
  (
    'proyectos', 'Proyectos', 'admin',
    $kb$Entregas más grandes con archivos, código en ZIP y sustentación obligatoria para la nota final (módulo "Proyectos").

- Configura los archivos esperados (incluido un slot de código completo en ZIP) y las instrucciones.
- El estudiante debe adjuntar el enlace a su repositorio; la nota final = nota de la entrega × factor de sustentación. Sin sustentación, la nota final queda pendiente.
- Con IA: genera la definición del proyecto y califica el código entregado (incluido el ZIP descomprimido).$kb$,
    100
  ),
  (
    'calificaciones', 'Calificaciones (gradebook)', 'admin',
    $kb$Libro de notas consolidado por curso y por corte, con todo lo que pesa en la nota final (módulo "Calificaciones").

- Revisa el consolidado por estudiante y corte, incluyendo exámenes, talleres, proyectos y asistencia según los pesos del curso.
- Registra notas de actividades externas con observaciones por estudiante.
- Exporta el gradebook a CSV o Excel (.xlsx) cuando necesites entregar reportes oficiales.$kb$,
    110
  ),
  (
    'asistencia', 'Asistencia y check-in por QR', 'admin',
    $kb$Control de asistencia por sesión, con autocheck-in mediante código QR rotativo para no llamar uno a uno (módulo "Asistencia").

- Crea sesiones (o impórtalas/genera por plantilla) y abre el check-in para que los estudiantes se marquen presentes con un QR que rota.
- Proyecta el QR a pantalla completa; ve el contador de presentes en tiempo real y cierra el check-in cuando termines (opcionalmente marca a los pendientes como ausentes).
- Asocia código en clase (snippets) y pizarra compartida a cada sesión.$kb$,
    120
  ),
  (
    'encuestas', 'Encuestas y retos en vivo', 'admin',
    $kb$Encuestas y juegos en vivo tipo Kahoot para dinamizar las clases (módulo "Encuestas", disponible para Docente; el Admin lo supervisa).

- Tipos de encuesta: opción única, múltiple o de reserva de cupos (slot, estilo Doodle) con auto-cálculo de cupo por matriculados.
- Puedes asociar una encuesta a una sesión de clase y compartir su enlace con los estudiantes.
- Retos en vivo (Kahoot): preguntas cronometradas con puntaje; los estudiantes se unen con un PIN.
- Duplica una encuesta para reutilizar su estructura sin copiar respuestas.$kb$,
    130
  ),
  (
    'estadisticas', 'Estadísticas', 'admin',
    $kb$Tablero analítico de desempeño de la institución: aprobación, asistencia y uso de la IA (módulo "Estadísticas").

- Filtra por curso para ver gráficos de aprobación, asistencia por sesión y estadísticas de fraude.
- Identifica cursos con baja aprobación o asistencia para tomar acción a tiempo.
- Como Admin puedes ver el panel a nivel de toda la institución.$kb$,
    140
  ),
  (
    'certificaciones', 'Certificaciones', 'admin',
    $kb$Vista unificada de los certificados emitidos en la institución (módulo "Certificaciones").

- Busca, ordena y filtra los certificados emitidos.
- Descarga el PDF de cualquier certificado y copia su enlace de verificación pública.
- Revocar un certificado desde el menú de acciones de la fila: la página de verificación pasa a mostrar "Revocado" y el PDF deja de ser una constancia válida.
- La configuración de la plantilla de certificado se ajusta desde Configuración → Institución.$kb$,
    150
  ),
  (
    'usuarios', 'Usuarios y roles', 'admin',
    $kb$Gestión de las personas de la institución y sus roles (Admin, Docente, Estudiante) desde el módulo "Usuarios".

- Crea usuarios uno a uno o por importación masiva (CSV).
- Asigna o quita roles, edita datos y usa "Iniciar como" para entrar en el contexto de un usuario y dar soporte.
- Filtra y ordena la tabla; las acciones de fila están en el menú de tres puntos.

Correos automáticos al dar de alta usuarios:
- Cada usuario nuevo recibe un correo de bienvenida con un enlace seguro (un solo uso, vence a los 7 días) para definir su propia contraseña.
- Si los correos de bienvenida están desactivados (Configuración → Correos → Bienvenida), el usuario se crea con una contraseña temporal que el Admin comparte, y la plataforma le obliga a cambiarla en su primer ingreso.
- Reenvío/recuperación: la persona puede usar "¿Olvidaste tu contraseña?" en el ingreso, o el Admin puede reenviar/restablecer desde este módulo.
- Crear la institución (tenant) en sí no envía correos: los correos empiezan al crear las personas.$kb$,
    160
  ),
  (
    'informes', 'Informes y plantillas', 'admin',
    $kb$Plantillas globales de informes que docentes y administradores usan para generar reportes con datos del curso (módulo "Informes").

- Crea una plantilla, escribe su contenido con marcadores de posición o impórtala desde un .docx.
- Con IA: usa el generador para redactar el cuerpo del informe a partir del contexto del curso.
- Edita, duplica o elimina plantillas; estas son globales (los overrides por curso los gestiona el docente).$kb$,
    170
  ),
  (
    'papelera', 'Papelera', 'admin',
    $kb$Recuperación de elementos eliminados: nada se borra de inmediato, va a la papelera por 30 días (módulo "Papelera").

- Aquí caen cursos, exámenes, talleres, proyectos, sesiones, pizarras, contenidos y encuestas eliminados.
- Restaura lo que borraste por error o elimina definitivamente lo que ya no necesitas (individual o en lote).
- Cada elemento muestra los días restantes antes de su purga automática.$kb$,
    180
  ),
  (
    'academico', 'Académico (programas, asignaturas, periodos)', 'admin',
    $kb$Define el armazón institucional: carreras (programas), asignaturas y periodos académicos (módulo "Académico").

- Crea y edita programas, asignaturas (con su sílabo: objetivos, contenidos, bibliografía y pesos) y periodos.
- Duplica una asignatura para reutilizar todo su sílabo y ajustar solo lo necesario.
- Esta estructura organiza los cursos y aporta contexto a los reportes.$kb$,
    190
  ),
  (
    'soporte', 'Soporte (PQRS al equipo de plataforma)', 'admin',
    $kb$Canal de peticiones, quejas, reclamos y sugerencias (PQRS) hacia el equipo dueño de la plataforma (módulo "Soporte").

- Abre un ticket eligiendo categoría (petición, queja, reclamo, sugerencia u otro) y describe el caso.
- Conversa por el chat del ticket en tiempo real y adjunta archivos (hasta 25 MB).
- Sigue el estado del ticket (abierto, en proceso, esperando, resuelto, cerrado) desde la lista.
- Para dudas hacia el equipo de plataforma usa este módulo, no los mensajes directos (los SuperAdmin no son contactables por mensaje).$kb$,
    200
  ),
  (
    'auditoria', 'Auditoría', 'admin',
    $kb$Registro de actividad de la institución: quién hizo qué y cuándo, para trazabilidad y diagnóstico (módulo "Auditoría").

- Filtra y busca eventos por tipo, severidad o fecha.
- Útil para investigar incidencias (por ejemplo, errores de importación o cambios de configuración).
- Exporta los eventos filtrados a CSV o Excel (.xlsx) para análisis externo.
- La retención de estos registros se ajusta desde Configuración → Auditoría.$kb$,
    210
  ),
  (
    'configuracion', 'Configuración (branding, correos, IA, módulos)', 'admin',
    $kb$Centro de ajustes de la institución, organizado en pestañas (módulo "Configuración").

- Generales: valores por defecto de cursos/exámenes y alertas de volumen de correos. Institución: branding (colores, logo) y certificados.
- Correos: interruptor general y por categoría. Compilador: proveedor de ejecución de código.
- Modelo IA y Cola IA: proveedor, modelo, claves y modo sync/async. Auditoría: retención. Módulos: qué módulos ve cada rol y en qué orden.$kb$,
    220
  ),
  (
    'mensajes', 'Mensajes', 'admin',
    $kb$La mensajería con docentes y estudiantes vive en el ícono de mensajes del pie de página (junto a la campana), no en el menú lateral.

- Chat 1-a-1 con cualquier persona de la institución, con adjuntos, edición/borrado de tus mensajes y búsqueda dentro de la conversación.
- Difusión a curso(s) y programar envíos, disponibles igual que para el docente.
- Para PQRS hacia el equipo de plataforma usa el módulo Soporte del menú lateral (los SuperAdmin no son contactables por mensajes directos).$kb$,
    230
  )
  ON CONFLICT (slug) DO UPDATE
    SET title = EXCLUDED.title,
        audience = EXCLUDED.audience,
        body = EXCLUDED.body,
        position = EXCLUDED.position,
        updated_at = now();
END $$;

NOTIFY pgrst, 'reload schema';

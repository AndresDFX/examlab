# Viabilidad real: qué de EDUTORI se puede implementar en ExamLab

> Complementa [`comparativa-edutori.md`](comparativa-edutori.md), que dice **qué falta**. Este dice
> **qué se puede hacer**, con qué apoyarse y qué no vale la pena. Todo lo afirmado sobre ExamLab está
> verificado en el código; lo de EDUTORI viene de su PDF de ventas y no es verificable.

> **Estado:** la #1 (alerta temprana) **ya está implementada** — clasificador puro con 35 tests,
> panel en Estadísticas de Docente y Admin, y umbrales por institución. Ver la sección
> "Alerta temprana" en [`CLAUDE.md`](../CLAUDE.md). Queda pendiente de Publish en Lovable.

## Veredicto

De las 9 brechas, **3 son ensamblaje** (la pieza difícil ya está construida y solo falta conectarla),
**4 son construcción honesta** (semanas de trabajo con un camino claro), **1 depende de una decisión de
plan/contrato** y **1 conviene no hacerla**.

La conclusión que más cambia la hoja de ruta: **la brecha de mayor peso comercial no es la más cara**.
La alerta temprana de deserción —KPI de rector, atado a financiación en LatAm— tiene su materia prima
ya calculada y probada. Y SAML, que en un pliego de universidad pública se pide por nombre, no requiere
tocar el código de autorización.

---

## Tabla de viabilidad

| # | Brecha | Sobre qué se apoya (verificado) | Qué falta | Viabilidad |
|---|---|---|---|---|
| 1 | **Alerta temprana con semáforo** | `src/shared/lib/statistics.ts` ya calcula `computeFailedStudents` y `computeNoPresentedStudents`, **con tests**. El pipeline de notificación existe entero: `notify_send_email` → `_notification_kind_emails` → edge `send-email`, con cron | ~~Clasificar en 3 niveles~~ ✅ · ~~umbrales por institución~~ ✅ · pendiente V2: persistir el nivel + digest automático al docente | ✅ **IMPLEMENTADA** |
| 2 | **SAML 2.0** | `auth-sso-verify` es **agnóstico del proveedor**: valida que el correo esté pre-aprovisionado, no cómo se autenticó. Google y Microsoft ya funcionan sobre ese mismo camino | Habilitar SAML en Supabase (requiere plan Pro+), metadata del IdP por institución, y un punto de entrada en el login | 🟢 **Ensamblaje + contrato** · días de código |
| 3 | **Progreso y continuidad ("Mi aprendizaje")** | Las vistas de curso, sesión y contenido existen; el dashboard del alumno ya consulta lo pendiente | `video_views` es un **booleano**: hay que guardar posición y % por contenido, y derivar "continuar donde ibas" | 🟢 **Ensamblaje** · 1-2 sem |
| 4 | **SCORM 1.2** | `fflate` está disponible en los edges (`npm:fflate@0.8.2`, ya se usa para descomprimir `.pptx`/`.docx`). El bucket `generated-contents` y sus policies ya sirven material | Parser de `imsmanifest.xml`, extracción a Storage, player en `<iframe>` con shim de la API `cmi.*`, y tabla de tracking | 🟡 **Construcción** · 4-6 sem |
| 5 | **Sincronización con SIS** | `bulk-import-users` ya crea/vincula usuarios y matricula idempotentemente (`onConflict`), y tolera re-ejecución. La FK de matrículas tiene `ON UPDATE CASCADE` | Columna `external_id` con índice único, edge de reconciliación de roster (altas, bajas, cambios de sección), programación, y **una excepción explícita a la política "nunca crear cuentas automáticamente"** | 🟡 **Construcción** · 3-5 sem |
| 6 | **Competencias / outcomes** | Nada reutilizable: `academic_subjects.objetivos` y `expected_rubric` son TEXT libre, sin identificador en ninguna punta | Entidad de competencia, mapeo ítem→outcome, rollup de logro por estudiante y por asignatura, informe exportable | 🟡 **Construcción** · 4-6 sem · **urgente por decaimiento** |
| 7 | **Rutas con prerrequisitos** | Existe un gate por fecha (mig `20261160000000`) que su propio comentario dice que tiene **0 uso en producción**, y videos obligatorios antes de entregar | `prerequisite_id`, criterios de completitud, y resolución del grafo de liberación | 🟡 **Construcción** · 3-4 sem |
| 8 | **Gamificación (puntos, insignias, niveles, rachas)** | Solo el leaderboard del Reto en vivo, que es por juego y no persiste progreso | Todo: puntos, reglas de otorgamiento, insignias (Open Badges es un estándar con firma), niveles, rachas | 🟡 **Construcción** · 3-5 sem · negociable |
| 9 | **Búsqueda semántica / recomendador** | **No hay pgvector** (verificado: ninguna migración lo instala ni declara una columna `vector`). El tutor ya lee el material real, pero por extracción de texto, no por embeddings | Extensión, pipeline de embeddings, backfill de todo el material, y re-indexado en cada cambio | 🔴 **No hacerla ahora** |

---

## Los tres de mayor retorno, con su camino

### 1 · Alerta temprana — el mejor esfuerzo/valor de toda la lista

No hay que calcular nada nuevo. `statistics.ts` ya produce quiénes reprobaron y quiénes no presentaron,
y hay tests que lo cubren. La asistencia, las entregas faltantes y las notas bajo `passing_grade`
también están disponibles.

Lo que falta es la parte de producto, no de datos: **decidir los umbrales** (¿riesgo alto es 2
inasistencias o 3? ¿lo define la institución?), guardar el nivel para poder ver su evolución, y avisarle
al docente. Y avisarle es gratis: el pipeline de notificación con correo y cron ya está armado y probado
por otros seis tipos de aviso.

El riesgo real de esta brecha no es técnico, es de diseño: un semáforo que marca en rojo a media clase
se deja de mirar en dos semanas. Conviene arrancar con una sola señal defendible y sumar después.

### 2 · SAML — barato para lo que pesa

Este era el hallazgo menos esperado. `auth-sso-verify` no pregunta *cómo* se autenticó el usuario:
verifica que el correo corresponda a una cuenta ya aprovisionada y, si no, borra la sesión. Google y
Microsoft entran por ese mismo camino. **Agregar SAML no toca la capa de autorización.**

Queda del lado de la plataforma: habilitarlo en Supabase (está en planes Pro+, así que es una decisión
de contrato antes que de código) y cargar la metadata del IdP por institución. Para una universidad
pública con Shibboleth o ADFS, esto convierte un "no cumple" en un "cumple" a costo bajo.

### 3 · SCORM — el que desarma la objeción de lock-in

Es el más caro de los tres, pero es el único que ataca dos objeciones a la vez: *"no puedo reutilizar el
contenido que ya compré"* y *"si me caso con ustedes no puedo salir"*. La segunda pesa más de lo que
parece en un comité de compras.

Y es más viable de lo que sugiere la ausencia total de código, porque la pieza que uno esperaría tener
que negociar —descomprimir un paquete en el navegador sin agregar dependencias— **no hace falta**:
`fflate` ya está disponible en los edges y se usa para leer `.pptx` y `.docx`. El paquete se
descomprime server-side a Storage y el player es un `<iframe>` sobre los archivos extraídos, más un
shim que implemente la API `cmi.*` que el contenido SCORM espera encontrar.

Alcance mínimo defendible: **SCORM 1.2 de solo consumo con tracking de completitud y nota**. Ni
importar/exportar cursos completos, ni xAPI, ni cmi5.

---

## Lo que recomiendo no hacer

**Búsqueda semántica y recomendador de contenidos.** Requiere instalar pgvector, generar embeddings de
todo el material, mantenerlos al día en cada edición y construir el recomendador. Contra eso: el Tutor
IA **ya lee el material real** del curso —extrae texto de `.docx`, `.pptx` y notebooks, y lo cachea— así
que la pregunta del estudiante ya se responde con su contenido. La ganancia marginal de reemplazar
extracción por embeddings es chica frente a semanas de trabajo y un componente de infraestructura nuevo
que hay que operar.

Si algún día se hace, que sea porque el catálogo creció al punto de que el material no cabe en el
prompt — no para poder decir "búsqueda semántica" en una tabla comparativa.

**Open Badges con firma.** Si se hace gamificación, empezar por puntos y rachas. Las insignias
verificables son un estándar con criptografía y hosting de la credencial: mucho costo para un ítem que
casi nunca decide una compra.

---

## Orden sugerido

1. ~~**Alerta temprana**~~ — ✅ hecha. Fue, como se esperaba, ensamblaje: el clasificador se apoya en
   el `CourseDataset` que las estadísticas ya cargaban, así que el panel **no cuesta una sola query
   extra**, y los umbrales entraron en `app_settings` sin tabla ni RLS nueva.
2. **SAML** — decidir primero el plan de Supabase; el código es menor.
3. **Competencias/outcomes** — no es la más urgente hoy, pero **es la única que se encarece sola**: no
   es derivable retroactivamente, así que cada periodo que pasa sin identificador de competencia es un
   periodo que nunca va a poder alimentar un informe de acreditación.
4. **Progreso y continuidad** — barato y es lo primero que un evaluador prueba en una demo.
5. **SCORM** — cuando haya un prospecto que lo pida por nombre. Antes de eso es inversión especulativa.
6. **SIS** — el más caro y el que más depende del sistema del cliente. Ojo: exige revisar la política de
   "nunca crear cuentas automáticamente", que hoy es una decisión de seguridad deliberada.

## Advertencia sobre cómo usar este informe

Los tiempos son estimaciones de una lectura del código, no de una planificación con el equipo. Y la
comparación es asimétrica: de ExamLab leímos el código, de EDUTORI tenemos un PDF comercial. La
auditoría anterior encontró que **la propia documentación de ExamLab sobrevendía en 7 puntos
verificados**; asumir la misma tasa de optimismo del otro lado es lo prudente.

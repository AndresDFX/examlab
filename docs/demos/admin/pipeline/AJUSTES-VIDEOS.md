# Ajustes para regenerar los videos demo

Checklist consolidado de TODO lo aprendido regenerando las 3 series (Admin /
Docente / Estudiante). Tenerlo en cuenta al volver a generar cualquier video.

---

## 1. Reglas de contenido (decisiones del usuario)

- **Un módulo de plataforma por video.** Nunca agrupar 2-3 módulos. Numeración
  consecutiva; el `outro` de cada video anuncia el módulo siguiente.
- **Duración:** apuntar a 30-60s. Se acepta más largo SOLO si el módulo lo
  amerita (demos de IA en vivo). **Nunca** inflar con esperas colgadas.
- **Sin login en cámara.** Mono-institución: **Demo Global Corp**.
- **Voz:** `es-CO-GonzaloNeural`, rate `-4%`.
- **NO** mencionar "se limpia el contexto de la institución" (videos de cuenta/sesión).
- **Docente** = mostrar *cómo crear/generar*. **Estudiante** = *ver/participar/enviar*.
- Mostrar features **EN VIVO** cuando aplique: generación con IA (preguntas,
  contenido, Reto en vivo), QR de asistencia, proctoring, entrega ZIP, variables de
  informe, mensajes programados/difusión.
- Calendario (estudiante y docente): enfocar la **GRILLA del mes**, no la leyenda.
- Si un módulo nuevo entra a la serie, dale su propio `module-NN.json` y ajustá
  el `outro` del anterior — no renumerar 12 archivos salvo que sea imprescindible.

## 2. Estado de la plataforma ANTES de grabar (seeds)

- **`ai_model_settings.processing_mode = sync`** mientras grabás los videos de
  generación con IA (corre inline, sin pedir código ni encolar).
  **RESTAURAR a `async` al terminar** (es el estado normal de prod).
- Sembrar para que el video **no salga vacío**, por video:
  - **t07 calificaciones:** una nota real en el consolidado (workshop `is_external`
    con `final_grade` + `cut_id` apuntando a un corte con bucket > 0). Da 4,30.
  - **t08 asistencia:** ~7-8 `course_enrollments` extra en el curso → contador "0/8".
  - **Admin Papelera:** soft-delete de UNA entidad descartable con `deleted_at`
    ~25 días atrás → badge "5-6 días" en ámbar.
  - **t13 mensajes:** 1-2 `scheduled_messages` `status='pending'` con `send_at` futuro.
  - **s05 entrega:** el proyecto necesita slots variados — `codigo_zip` (ZIP),
    `diagrama`, `abierta` — y el slot **ZIP en `position` baja** para que se vea
    arriba del dialog.
  - **t06 banco:** arranca vacío o con pocas (cada re-grabación ACUMULA preguntas
    en el curso; limpiar con DELETE a `question_bank` del curso si querés empezar limpio).
- **⚠ Dependencias cruzadas de seed:** no borres para un demo algo que otro video
  usa. (Pasó: borrar "Taller en clase — Patrones de diseño" para Papelera dejó t07
  sin su nota — era su fuente). Usá entidades dedicadas por seed.
- **Cuenta demo:** `test-demo-global-corp@examlab.test` (3 roles). Cambiar de rol
  **por SPA** (role-switcher), nunca `page.goto` (resetea el rol activo en memoria
  → cae al dashboard de Admin). Rutas sin nav item (`/app/messages`,
  `/app/student/take/$id`) → navegar por click/Link SPA, o aceptar que el contexto
  caiga a Admin si el contenido a mostrar es un modal que llena la pantalla.

## 3. Sincronía narración ↔ visual (`syncWord`)

- `gen-voice.py` emite `scene-N-words.json` (word boundaries de edge-tts).
- Cada beat con **`syncWord`** aparece cuando el guion PRONUNCIA esa palabra
  (menos un lead de ~650ms). El hold se extiende hasta el gate del beat siguiente.
- Usar palabras **únicas** del guion como `syncWord` (evitar palabras repetidas;
  si se repite, usar `syncOccurrence`).

## 4. Cámara / foco (lecciones que arreglaron los "zoom mal ubicado")

- **Des-proyección:** los beats 2+ de una escena se miden con el transform del beat
  anterior aplicado → el recorder des-proyecta a coords body-local. Era el root
  cause de TODOS los focos en posición incorrecta.
- **`overpan: true`:** para elementos pegados al borde (footer: campana/sobre/
  logout) — centra aunque la cámara rebase el body (el dim del spotlight cubre el vacío).
- **`fitScale`** nunca recorta (cap por viewport 0.9w/0.8h). No subir escala a mano
  en elementos anchos.
- **No** `will-change:transform` en `cameraSetup` (creaba containing block → la
  carátula saltaba al tercio inferior en páginas altas).
- **Calendario:** target `main div.grid-cols-7:not(.uppercase)` (la grilla, no la
  leyenda `text:Leyenda`).
- **Footer:** `footericons` (unión de los 4 íconos) o targets individuales con
  `overpan`; nunca el wrapper de las campanas (rect enorme → sin zoom).

## 5. Interacción en vivo — capacidades del recorder y sus trampas

| Beat | Uso | Trampa a evitar |
|---|---|---|
| `openVia {target, menuItem?}` | abrir detalle / ítem de menú | cierra modales previos con doble Escape — si NO querés cerrar el modal anterior (ej. escena que sigue usando el mismo dialog), no uses openVia ahí |
| `typeInto {target, text}` | tipeo en vivo | clickea el INPUT/TEXTAREA real dentro de `field:` (no el centro del contenedor = label) + Ctrl+A para reemplazar valores previos (ej. Cantidad) |
| `selectOption {target, selectOption}` | Radix Select | **el punto MÁS frágil** aun con la versión robusta. Si un curso/tipo DEBE cambiar, validá el frame; cuando se pueda, usá el valor por defecto o el curso auto-seleccionado y evitá el select |
| `click {target, waitText?, focusTarget?, afterClickMs?}` | acción inline + espera | `waitText` matchea CUALQUIER texto, incl. el ESTÁTICO del dialog (ej. "al banco" estaba en la descripción → matcheaba al instante). Usar una palabra que SOLO esté en el toast (ej. "generada"). Para toasts transitorios (sonner ~4s) que pueden no matchearse y colgar hasta el timeout → preferir `afterClickMs` si el dialog **auto-cierra** al terminar |
| resolvers | `button:` (excluye tabs), `field:Label`, `card:Título`, `text:`, `stat:N`, `statrow`, `row:N`, `rowaction:N`, `createbtn`, `maincard`, `firstcard`, `[css]` | `card:` devuelve solo el título (sliver) — para el card completo usar `text:Título`; `field:` para Selects no sirve para clickear (resuelve el contenedor) |

## 6. Resultado de generación con IA en diálogos

- **Examen** (t03): el resultado se ve en la lista de preguntas (`#exam-questions-list`).
- **Taller / Proyecto** (t04/t05): el dialog NO cierra solo → cambiar a la tab
  **"Preguntas (N)"** (`tab: "Preguntas"`) para mostrar el resultado, no dejar la tab IA.
- **Banco** (t06): el dialog **auto-cierra** al generar → usar `afterClickMs ~11s`
  (no `waitText`), y la pregunta queda en la tabla (`row:0`).
- **Reto en vivo** (t12): preguntas en `kahoot_questions` (identificador interno) se ven
  en el dialog "Preguntas del reto" con sus opciones de colores y la correcta marcada.

## 7. Verificación obligatoria

- Verificar SIEMPRE por **frames en los segundos de los beats** (no asumir que grabó bien).
- Revisar la **duración**: si se infló (ej. 141s), casi seguro un `waitText` quedó
  colgado hasta el timeout — cambiar a `afterClickMs`.
- Revisar los `⚠` del log de grabación (selectOption / openVia / waitText fallidos).

## 8. Issues residuales conocidos (candidatos a re-grabar)

- **t08 asistencia:** el `selectOption` a "Fundamentos" suele fallar → queda en
  Arquitectura "0/1" en vez de "0/8". El QR igual aparece (lo importante). Si se
  quiere "0/8", validar el select o pre-seleccionar el curso por estado.
- **t12 encuestas:** el `selectOption` del tipo "Cupo por opción" puede fallar (la
  parte Reto en vivo IA sí funciona). El generador de slots Doodle se muestra igual.
- **t07:** el modal "Detalle del corte" puede no abrir (`button:Detalle`), pero la
  nota 4,30 sí se ve en el consolidado.
- **t06 banco:** acumula preguntas entre re-grabaciones (limpiar el curso si molesta).

---

## 9. Pendiente tras cambios recientes (2026-07-06)

Cambios en la plataforma que impactan la serie de videos. **Requisito previo a re-grabar
cualquiera de estos: la app debe estar PUBLICADA en Lovable con los commits abajo** — el
recorder graba `examlab.lovable.app` EN VIVO, así que grabar antes del Publish capturaría
la UI vieja. El render del `.mp4` exige correr el pipeline (`make.mjs`: Playwright +
edge-tts + ffmpeg) contra la app publicada; no se genera sin ese paso.

- **Rename "Kahoot" → "Reto en vivo"** (legal, commit `0c1994c0`). Specs YA actualizados a
  "Reto en vivo": `module-t12.json` (docente, encuestas) y `module-s01.json` (estudiante,
  dashboard — el target pasó de `text:Ranking Kahoot` a `text:Ranking de retos`, que es el
  texto real de la UI renombrada). **Acción:** re-grabar **t12** y **s01** post-Publish.
- **Nuevo módulo Admin "Asistente IA de plataforma"** (`/app/admin/support-assistant`,
  commit `e5208bf1`) — chat de IA tipo Tutor para dudas de la plataforma. Falta crear su
  `module-NN.json` (nuevo, un módulo por video) + ajustar el `outro` del módulo Admin
  anterior para anunciarlo. Los `target`/`field:`/`text:` deben autorearse **contra la UI
  publicada** (no a ciegas) para que el recorder los encuentre.
- **Soporte automatizado con IA + remediación** (commit `b24f052f`): botón "Sugerir
  respuesta con IA" en el detalle del ticket (SuperAdmin/Admin) + acción "Analizar con IA"
  en Errores. Se puede sumar como beat al video del módulo Soporte (Admin/SA) o al del
  Asistente IA. Requiere Publish (edge `support-ai-suggest`) para demostrarlo en vivo.

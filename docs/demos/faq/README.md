# Videos FAQ — clips cortos y guionizados por rol

Los **FAQ** son videos **cortos y puntuales** (≈15–25 s) que responden **UNA** pregunta
concreta de un rol (Admin / Docente / Estudiante). Son distintos de los **tours de
módulo** (largos) que ya viven en `platform_help_videos` (`kind='module'`).

El **asistente de IA de la plataforma** (`platform-support-chat`) los inyecta en su base
de conocimiento con su **enlace público** y, cuando la pregunta del usuario coincide con
la del clip, comparte el link en el chat. Están **disponibles para todos los tenants**
(RLS `phv_select = true`); solo el **SuperAdmin** los administra (`phv_write = is_super_admin()`).

## Todo queda guionizado (para mantenerlo fácil)

Cada FAQ es un **spec JSON** versionado en el repo — la **fuente de verdad**. Si algo de
la plataforma cambia (una ruta, un botón, un flujo), se edita el guion y se regenera el
clip; no hay que "recordar" qué decía el video.

- Ubicación: `docs/demos/admin/pipeline/modules/module-faq{a,t,s}NN.json`
  (los 3 roles comparten esa carpeta de pipeline, igual que los tours de módulo).
  - `faqa*` = Admin · `faqt*` = Docente · `faqs*` = Estudiante.
- Campos propios del FAQ (además del schema normal de un `module-*.json`):
  - `"kind": "faq"` — lo distingue de los tours de módulo.
  - `"question": "..."` — la pregunta EXACTA que responde el clip. Se copia a la
    columna `platform_help_videos.question` para que el asistente lo matchee.
  - `"series": "faq"` — la salida cae en `docs/demos/faq/output/<id>.mp4`.
  - `"role"` — `Admin` | `Docente` | `Estudiante` (filtra a quién se le ofrece el clip).
- Estructura corta: 2 escenas → una `card` con la pregunta + una escena `platform` con
  la respuesta (2–3 `beats` de zoom/foco). Regla de narración: **autocontenida**, sin
  numerar módulos ni encadenar ("en el siguiente…").

## Set inicial (9 clips)

| id | rol | pregunta |
|----|-----|----------|
| `modulo-faqa01` | Admin | ¿Cómo creo un usuario o importo estudiantes por CSV? |
| `modulo-faqa02` | Admin | ¿Cómo creo un curso y le asigno docentes y estudiantes? |
| `modulo-faqa03` | Admin | ¿Cómo configuro los cortes y los pesos de evaluación? |
| `modulo-faqt01` | Docente | ¿Cómo creo un examen? |
| `modulo-faqt02` | Docente | ¿Cómo tomo asistencia con el código QR? |
| `modulo-faqt03` | Docente | ¿Cómo veo el libro de notas y lo exporto? |
| `modulo-faqs01` | Estudiante | ¿Cómo presento un examen? |
| `modulo-faqs02` | Estudiante | ¿Cómo hago check-in de asistencia? |
| `modulo-faqs03` | Estudiante | ¿Dónde veo mis notas? |

Agregar un FAQ = copiar un `module-faq*.json`, cambiar `id`/`question`/`role`/`appPath`/
`scenes`, y sumarlo al seed.

## Generar + publicar (pasos)

Igual que los tours de módulo, corre desde la copia de trabajo `C:/Temp/examlab-rec/`
(el repo es la FUENTE de los specs; se copian a `C:/Temp/.../modules/`).

```bash
# 1) Generar los MP4 (voz edge-tts → grabación Playwright → mux ffmpeg)
node make.mjs faqa01 faqa02 faqa03 faqt01 faqt02 faqt03 faqs01 faqs02 faqs03
#    → docs/demos/faq/output/modulo-faq*.mp4

# 2) Subir al bucket help-videos + registrar/actualizar en platform_help_videos (kind='faq').
#    Auth = login SuperAdmin (lee URL/ANON de ../../../.env; NO requiere service_role key).
node seed-faq-videos.mjs
```

`seed-faq-videos.mjs` hace login como SuperAdmin (creds en el script, `.env` para URL/ANON —
mismo patrón que `setup-tenant.mjs`), lee los specs `module-faq*.json`, sube cada
`output/<id>.mp4` a `help-videos/faq/<id>.mp4` (bucket público) y hace **upsert** de la fila
en `platform_help_videos` con `kind='faq'`, `question`, `role`, `route` (= `appPath`) y
`video_url` público. Deja la fila `is_active=true` solo si el MP4 existe; mientras no exista,
el asistente no la ofrece (el edge filtra `is_active=true` + `video_url IS NOT NULL`).

## Requisito de esquema

La columna `kind` + `question` en `platform_help_videos` la agrega la migración
`supabase/migrations/20261390000000_platform_help_videos_faq_kind.sql`. Debe estar
**publicada** en Lovable antes de correr el seed.

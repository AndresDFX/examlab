# ExamLab

**Plataforma multi-tenant de gestión educativa** con exámenes online, talleres, proyectos, asistencia, calificación con IA, proctoring y mensajería interna. Para instituciones educativas que dictan cursos a estudiantes y necesitan evaluar de forma estructurada.

Hospedada en Lovable (https://examlab.lovable.app) sobre Supabase (PostgreSQL + RLS + Edge Functions). Multi-tenant: una sola instancia sirve a múltiples instituciones (cada una ve solo sus propios datos).

---

## Tabla de contenidos

- [Roles y permisos](#roles-y-permisos)
- [Features principales](#features-principales)
- [Stack](#stack)
- [Setup local](#setup-local)
- [Estructura del repo](#estructura-del-repo)
- [Despliegue](#despliegue)
- [Testing](#testing)
- [Videos demo](#videos-demo)
- [Documentación interna](#documentación-interna)
- [Git workflow](#git-workflow)

---

## Roles y permisos

| Rol | Acceso |
|---|---|
| **SuperAdmin** | Cross-tenant. Operación de la plataforma: gestión de instituciones, infra (cron, backups, secretos), Soporte (PQRS de Admins), branding global. |
| **Admin** | Owner de una institución (tenant). Gestiona usuarios, cursos, programas/periodos/asignaturas, certificados, prompts IA, configuración del tenant, abre tickets de Soporte al SA. |
| **Docente** | Profesor de uno o varios cursos. Crea exámenes/talleres/proyectos, califica (manual + IA), gestiona asistencia (QR rotativo), pizarras compartidas, encuestas (incluye slots tipo Doodle), contenidos pedagógicos. |
| **Estudiante** | Alumno matriculado. Toma exámenes con proctoring (fullscreen, copy/paste detection, screenshot warnings), entrega talleres/proyectos (individual o grupal), check-in QR, consulta calificaciones, tutor IA, certificados al cerrar curso. |

Un mismo `auth.users` puede tener varios roles simultáneos (ej. Admin + Docente). El sidebar tiene un **role-switcher** que cambia el rol activo (efímero, no persiste entre recargas).

---

## Features principales

### Para el Admin
- **Bulk import de usuarios** desde CSV (decenas o cientos en un click, con throttle + retry contra rate limit del Auth admin API).
- **Cursos** con cortes evaluativos pesados, programas + periodos + asignaturas heredados, matrícula masiva.
- **Cola IA** (grading + generation) con jobs reintentos automáticos para errores transitorios (429/5xx/timeout).
- **Auditoría** con eventos agrupados por fingerprint, búsqueda y estados (nuevo/revisando/resuelto/ignorado).
- **Configuración granular**: tabs Generales, Institución, Correos (toggle por categoría incluyendo "Bienvenida"), Compilador (Python/Java/JavaScript), Modelo IA (provider + model), Cola IA, Módulos visibles.
- **Soporte** — abre tickets al SA con categoría, prioridad, adjuntos, chat realtime.

### Para el Docente
- **Exámenes** (cerrada, cerrada_multi, abierta, código, código ZIP, diagrama, Java GUI, Python GUI) con proctoring opcional, navegación libre vs secuencial, calificación automática con IA para abiertas/código.
- **Talleres** y **Proyectos** con rúbrica IA configurable por curso (override del prompt global del Admin), trabajo en grupo (V1 teacher_assigned), sustentación con factor multiplicador, link al repo.
- **Banco de preguntas** reutilizable por curso (todos los docentes del curso comparten).
- **Asistencia** con sesiones programables, check-in self-service via QR rotativo (TOTP-like), pizarra compartida en tiempo real, snippets de código (Java/Python/JS) por sesión.
- **Calendario** sincronizado con Google Calendar (OAuth), genera sesiones automáticamente desde fecha de inicio + días de la semana.
- **Gradebook** con consolidado por corte, export CSV.
- **Contenidos** generados con IA (Gemini/OpenAI) o subidos manualmente (PDF, PPTX, MD).
- **Mensajes** 1-a-1 + broadcast a curso(s) + programación a futuro + etiquetas `#examen` `#taller` `#proyecto`.
- **Reportes** parametrizables (plantillas globales + overrides por curso + privadas).
- **Encuestas** opción única / múltiple / Doodle (slots con cupo para agendar sustentaciones).

### Para el Estudiante
- **Toma de examen** con proctoring opcional: detección de salidas de fullscreen, copy/paste/cut warnings, screenshot attempts. Autosave cada 1.5s. Modo offline con sync al reconectar (IndexedDB).
- **Entregas** de talleres/proyectos con grupos (cuando aplica), link al repo para proyectos.
- **Calificaciones** por corte con proyección de nota final en vivo.
- **Check-in QR** escaneando con cámara (html5-qrcode) o ingresando código de 6 dígitos.
- **Tutor IA** que conoce el contexto del curso (RAG sobre contenidos).
- **Pizarras compartidas**, **encuestas**, **biblioteca de videos**, **certificados** al cerrar curso.

### Cross-rol
- **PWA** instalable (manifest + service worker).
- **Notificaciones push** (Web Push API + VAPID).
- **Onboarding tour interactivo** con driver.js, +30 pasos por rol con demos guiados de creación.
- **Papelera (soft-delete)** con TTL de 30 días para 8 entidades padre.
- **i18n** español-CO default + inglés.
- **Dark mode** con persistencia por usuario.
- **Branding por tenant** — cada institución personaliza colores (primary + sidebar + icon) que se aplican vía CSS vars OKLCH.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + TypeScript + TanStack Router v1 + Tailwind + shadcn/ui |
| Backend | Supabase (PostgreSQL 15 + RLS + pg_cron) + Edge Functions (Deno) |
| AI | Google Gemini (`gemini-2.5-flash`/`pro`) + OpenAI (`gpt-4o`/`gpt-4o-mini`) via Lovable AI Gateway |
| Runtime de código | OnlineCompiler / JDoodle / AWS Lambda (Java + Python tkinter GUI via Xvfb + screenshot) |
| Plataforma de hosting | Lovable (lovable.dev) — gestiona Cloudflare Workers + Supabase deploy |
| Build | Vite + Bun (runtime + package manager — `bun.lock` NO `package-lock.json`) |
| i18n | react-i18next |
| Offline | idb-keyval (IndexedDB) |
| Charts | Recharts |
| Whiteboard | Excalidraw (con librerías predefinidas + viewport persistente + modo compartido realtime) |
| Notificaciones | Sonner (toasts) + Supabase Realtime + Web Push |
| Tests | Vitest + Testing Library + jsdom |

---

## Setup local

```bash
# 1. Clonar
git clone git@github-personal:AndresDFX/examlab.git
cd examlab

# 2. Instalar (USAR bun, NO npm/pnpm — el lockfile es bun.lock)
bun install

# 3. Crear .env (anon key pública, está en el bundle final)
cat > .env <<'EOF'
VITE_SUPABASE_URL="https://uxxpzfsfcnqiwwdxoelm.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbG...EdZ_3KlDGVSQ-i026ZriHu4FbLFJLwghkW-FlfcTlkE"
VITE_SUPABASE_PROJECT_ID="uxxpzfsfcnqiwwdxoelm"
VITE_VAPID_PUBLIC_KEY="BAg2gqFTm-P9_gNuumcJPQF7fj-6e2XjlSDZJGTGa2YMvZSDdKD6C6S3pc88UM7mvBNrlcebXUXeJzqKp4bROVo"
EOF

# 4. Servidor de desarrollo
bun run dev
# → http://localhost:5173

# 5. Verificar tipos + tests
bun tsc --noEmit
bun test                 # vitest + jsdom (NO usar runner bun puro)

# 6. Build de producción (mismo entorno que Lovable)
bun run build
```

### Cuentas demo (tenant FESNA — datos del entorno de testing)

> ⚠️ Las cuentas demo son del entorno HOSTED (https://examlab.lovable.app). Si vas a operar en local apuntando a la misma DB, **NO uses datos productivos** — la DB es compartida.

| Rol | Email | Password |
|---|---|---|
| SuperAdmin (cross-tenant) | `castano.julian@correounivalle.edu.co` | `Tester#12345` |
| Multi-rol (Admin + Docente + Estudiante) en FESNA | `test-fesna@examlab.test` | ⚠️ migró a SSO (2026-06-12) — la contraseña ya no funciona |

La cuenta multi-rol facilita testing — el role-switcher del sidebar cambia entre los 3 roles sin re-login.

---

## Estructura del repo

```
examlab/
├── src/
│   ├── routes/                  # TanStack Router file-based routes
│   │   ├── __root.tsx           # Shell SSR-compatible (Lovable usa Cloudflare Workers)
│   │   ├── index.tsx            # Landing pública
│   │   ├── auth.index.tsx       # Login + tenant picker + reset password
│   │   ├── app.index.tsx        # Dashboard (router renderea según rol activo)
│   │   ├── app.admin.*.tsx      # Pantallas Admin (users, courses, certificates, etc.)
│   │   ├── app.teacher.*.tsx    # Pantallas Docente
│   │   ├── app.student.*.tsx    # Pantallas Estudiante
│   │   ├── app.superadmin.*.tsx # Pantallas SuperAdmin (tenants, system, support)
│   │   └── app.messages.tsx     # Mensajería cross-rol
│   ├── modules/                 # Componentes y lógica de dominio
│   │   ├── admin/               # Panels Admin (EmailSettings, AiCron, etc.)
│   │   ├── ai/                  # UnifiedAiQueuePanel, prompts, model picker
│   │   ├── auth/                # Login forms, change password dialogs
│   │   ├── calendar/            # Google Calendar OAuth + sync
│   │   ├── code/                # Code editors, runners (CheerpJ, AWS Lambda)
│   │   ├── contents/            # Generación + upload de contenidos con IA
│   │   ├── exams/               # FraudPanel, IntegrityReview, PendingNotes
│   │   ├── grading/             # FeedbackThread, OpenFeedbackModal, ExternalGrades
│   │   ├── messaging/           # Tags, broadcast, scheduled, attachments
│   │   ├── onboarding/          # Tour driver.js + tour-config por rol
│   │   ├── polls/               # Slot generation Doodle-style
│   │   ├── reports/             # Template editor + render engine
│   │   ├── sessions/            # Snippets de código por sesión + csv helpers
│   │   ├── support/             # Ticket dialog (chat realtime)
│   │   ├── tenants/             # ThemeProvider + signal de active role
│   │   ├── trash/               # Soft-delete helpers
│   │   └── whiteboard/          # MultiPage + librerías predefinidas
│   ├── shared/                  # Componentes y lib compartidos cross-feature
│   ├── components/ui/           # shadcn primitives + wrappers propios
│   ├── hooks/                   # useAuth, useTheme, useTenant, etc.
│   ├── integrations/supabase/   # Cliente + types.ts auto-generado
│   ├── i18n/                    # locales/es-CO.json + en.json
│   └── styles.css               # Tailwind + design tokens OKLCH
├── supabase/
│   ├── migrations/              # SQL versionadas (Lovable las aplica en Publish)
│   └── functions/               # Edge Functions Deno
│       ├── _shared/             # audit, edge-error, etc.
│       ├── ai-grade-submission/
│       ├── ai-grading-worker/
│       ├── ai-generate-questions/
│       ├── ai-generation-worker/
│       ├── auth-sso-verify/
│       ├── broadcast-course-message/
│       ├── bulk-import-users/
│       ├── calendar/            # Google Calendar OAuth + sync
│       ├── db-backup-runner/
│       ├── execute-code/        # Router a OnlineCompiler/JDoodle/AWS Lambda
│       ├── generate-contents/
│       ├── send-email/          # SMTP gateway
│       └── ...
├── scripts/                     # Utilidades: gen de manuales/presentaciones, iconos PWA, audit i18n
├── aws/code-runner/             # Lambda handler para Java/Python GUI
│   ├── app.py
│   ├── GuiBootstrap.java
│   ├── TkinterBootstrap.py
│   └── Dockerfile
├── docs/
│   ├── demos/                   # Videos demo (pipeline propio: Playwright + edge-tts + ffmpeg)
│   │   ├── admin/pipeline/      # make.mjs, record-module.mjs, build-mux.mjs + specs module-*.json
│   │   ├── correos/             # Plantillas de correos de difusión
│   │   └── manual/              # Manuales por rol (Admin/Docente/Estudiante)
│   ├── costos/                  # Análisis de costos + modelos de negocio
│   ├── audit/                   # Auditorías de seguridad (históricas)
│   └── archive/                 # Documentación obsoleta archivada
│           ├── admin.webm
│           ├── teacher.webm
│           └── student.webm
├── CLAUDE.md                    # Contexto técnico para asistentes IA
└── README.md                    # Este archivo
```

---

## Despliegue

**Lovable es la plataforma de hosting**. El flujo es:

1. `git push origin main` → Lovable detecta el commit.
2. Usuario click en **Publish** en el dashboard de Lovable.
3. Lovable buildea con Vite (`bun run build`), deployea a Cloudflare Workers, y aplica las migraciones nuevas de `supabase/migrations/` sobre la DB de Supabase.

**No hay CI/CD externo** — el deploy es manual desde Lovable. Los tests locales sirven para validar antes del push; el build de Lovable es la fuente de verdad.

### Migraciones — defensiva obligatoria

Cada migración nueva DEBE envolver `ALTER TABLE` en un guard porque Lovable a veces marca migraciones como aplicadas aunque el `CREATE TABLE` no haya corrido:

```sql
DO $$ BEGIN
  IF to_regclass('public.X') IS NOT NULL THEN
    ALTER TABLE public.X ...;
  END IF;
END $$;
```

Sin el guard, una sola migración fallida aborta todo el deploy.

### AWS Lambda code-runner (opcional)

El edge `execute-code` puede routear a un Lambda en AWS para Java/Python GUI con screenshot via Xvfb. Si no se usa, los otros providers (OnlineCompiler, JDoodle, CheerpJ client-side) cubren los lenguajes básicos. Build del Lambda con `aws/code-runner/Dockerfile` (incluye `python3-tkinter`, `openjfx`, `xvfb`). Ver `aws/code-runner/README.md`.

---

## Testing

```bash
bun test                                 # toda la suite
bun test src/modules/sessions            # solo un módulo
bun tsc --noEmit                         # validación de tipos
```

Convención:
- **Helpers puros** (sin React, sin DOM): tests directos al lado del módulo (`csv.ts` + `csv.test.ts`).
- **Componentes React**: Vitest + Testing Library + jsdom.
- Algunos tests requieren jsdom; usar siempre `bun test` (que invoca vitest), NO el runner bun puro (`document is not defined`).

Tests existentes cubren helpers de:
- Cálculo de notas (`grade.ts`, `exam-attempts.ts`).
- Generación de slots Doodle (`polls/slot-generation.ts`).
- CSV de sesiones (`sessions/csv.ts`).
- Helpers de upload de contenido externo (`contents/upload-external-helpers.ts`).
- Roles helpers (`shared/lib/roles.ts`).
- Tour config (`onboarding/tour-config.ts`).
- RBAC rules (`shared/lib/rbac.ts`).
- Excalidraw libraries (`whiteboard/excalidraw-libraries.ts`).
- Soft-delete (`modules/trash/soft-delete.ts`).
- Edge error extraction.
- Messaging helpers (broadcast normalize, dedup, tags).

---

## Videos demo

Los videos de demostración se generan con un **pipeline propio** (sin avatar): graba la app real con Playwright, sintetiza la narración con edge-tts (`es-CO-GonzaloNeural`) y mezcla audio+video con ffmpeg. Un módulo de la plataforma por video.

```bash
# Desde la copia de trabajo (C:/Temp/examlab-rec). Un id = un módulo.
node make.mjs 01 02 03        # voz → grabar (vs prod) → mux → docs/demos/<serie>/output/
node build-serie.mjs admin    # concatena los módulos en serie-admin-completa.mp4
```

Pipeline + specs en `docs/demos/admin/pipeline/` (compartido por las 4 series: Admin, Docente, Estudiante, recorrido general). Convenciones y aprendizajes en `docs/demos/admin/pipeline/AJUSTES-VIDEOS.md`.

> HeyGen (avatar IA superpuesto) quedó **deprecado**; `docs/heygen/` se eliminó. El `scripts/record-tour.ts` es legacy de ese flujo.

---

## Documentación interna

- **`CLAUDE.md`** — contexto técnico exhaustivo para asistentes IA (Claude Code, Cursor, etc.). Cubre arquitectura, design system, RBAC, RLS, migraciones críticas, convenciones de código (~50 reglas), patrones de bugs comunes, cuentas de testing, snapshot del proyecto. **Si vas a modificar el código, leelo ANTES**.
- **`docs/README.md`** — índice de la documentación de `docs/` (referencia/setup, planes activos, negocio, demos, archivo).
- **`docs/demos/`** — pipeline propio de videos demo + manuales por rol + plantillas de correo.
- **`aws/code-runner/README.md`** — build del Lambda code-runner (Java/Python GUI).
- **`docs/archive/`** — documentación obsoleta archivada (Docker self-host, contexto pre-CLAUDE.md, hallazgos resueltos).

---

## Git workflow

```bash
# Branch principal: main (Lovable hace deploy desde acá).
git pull --rebase origin main   # antes de empezar a trabajar
# ...cambios...
git add <archivos específicos>  # NO git add . (puede colar .env, secrets, etc.)
git commit -m "feat: descripción concisa"
git push origin main
# Después: ir a Lovable y click Publish.
```

Convenciones:
- Commits en **español** con prefijo `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`.
- NO `git push --force` a `main`.
- NO `--no-verify` ni skipear hooks.
- Si Lovable empuja cambios (raramente lo hace), `git pull --rebase origin main` antes de pushear.

### Archivos secretos NUNCA commitear

- `.env` (anon key pública es OK, pero NO incluir SERVICE_ROLE_KEY si la pegás).
- `.env.recording` (credenciales del usuario demo para Playwright).
- `recordings/` (videos efímeros de grabación; los videos demo versionados van en `docs/demos/<serie>/output/`).
- `*.json` con credenciales de Google service account o AWS.

---

## Licencia

Privado. Todos los derechos reservados.

---

## Contacto

Reportar bugs a `castano.julian@correounivalle.edu.co` o abrir un ticket desde la propia app (rol Admin → módulo Soporte).

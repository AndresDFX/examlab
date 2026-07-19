# Archivo (documentación obsoleta)

Documentos que **ya no reflejan el estado actual** del proyecto pero se conservan
por valor histórico (decisiones, hallazgos cerrados, un enfoque que se abandonó).
No los uses como referencia de "cómo está armado esto hoy" — para eso están
`CLAUDE.md`, `README.md` y `CHANGELOG.md` en la raíz, y los docs vigentes de
`docs/` (ver `docs/README.md`).

Nada acá se borró: `git log --follow <archivo>` reconstruye su historia.

## Qué hay

### `docker-selfhost/`
El intento (abril 2026) de **auto-hospedar ExamLab con Docker + AWS** (CloudFormation,
CloudShell, scripts de deploy). Se **abandonó** cuando el proyecto se movió a **Lovable**
como plataforma de hosting. Incluye: `DOCKER_DEPLOYMENT`, `MIGRATION_TO_DOCKER`,
`README_DOCKER`, `SETUP_SIMPLE`, `GETTING_STARTED`, `IMPLEMENTATION_SUMMARY`,
`CLOUDSHELL_QUICK_START`. El despliegue real hoy es `git push` → **Publish** en Lovable
(ver `README.md`). El único Docker vigente es el del Lambda code-runner
(`aws/code-runner/Dockerfile`, documentado en `aws/code-runner/README.md`).

### `contexto-superado/`
Documentos de contexto (`EXAMLAB-CONTEXT`, `PROJECT_CONTEXT`) previos a que `CLAUDE.md`
se volviera la fuente única de contexto técnico. Tienen datos desactualizados
(ej. "React 19 / Tailwind 4" cuando el stack real es React 18). **Superados por `CLAUDE.md`.**

### `hallazgos-resueltos/`
Reportes de cacerías de bugs / auditorías / QA **de punto en el tiempo, ya corregidos**
(cada hallazgo cerrado con su commit/migración). Se conservan como bitácora de qué se
encontró y cómo se arregló: `HALLAZGOS-BUGS-2026-07-15{,-ronda2,-ronda3}`,
`HALLAZGOS-FUNCIONALES-2026-06-30`, `HALLAZGOS-RLS-2026-07-15`,
`AUDITORIA-PAPELERA-SELECCION-2026-06-30`, `QA-RESULTADOS`, `REVISION-SEGURIDAD-E2E-POR-ROL`,
`AUDIT-URLS-REFERENCIABLES`, `i18n-hardcoded-audit`, `CORRECCIONES-videos-qa`.

### `security-audit-2026/`
Serie de auditoría de seguridad (`00`–`06`): hallazgos iniciales, edge functions/storage,
integración Google Calendar, auditoría externa, secretos/auth. Histórica; las
correcciones ya viven en migraciones + `CHANGELOG.md`.

### `planes-superados/`
Planes reemplazados por otros más nuevos o por la implementación:
- `EMAIL-MIGRATION-PLAN` — superado por el enfoque de `docs/PLAN-CORREO-POR-CUENTA.md`.
- `PLAN-LICENCIAS-Y-RESET-PASSWORD-DOCENTE` — superado.

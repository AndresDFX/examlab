# Documentación de ExamLab

Índice de la documentación **vigente**. La fuente de verdad técnica principal es
`../CLAUDE.md` (contexto exhaustivo) + `../README.md` (visión general) + `../CHANGELOG.md`
(historial). Lo obsoleto/histórico vive en [`archive/`](archive/) — no lo uses como
referencia del estado actual.

## Referencia / setup

| Doc | Para qué |
|---|---|
| [SSO-SETUP.md](SSO-SETUP.md) | Configurar SSO con Azure AD (login institucional). |
| [OUTLOOK-CALENDAR-SETUP.md](OUTLOOK-CALENDAR-SETUP.md) | Habilitar la integración de Calendario Outlook / Microsoft Graph. |
| [CRON-JOBS.md](CRON-JOBS.md) | Runbook de las tareas programadas (pg_cron): qué corre y cómo operarlas. |
| [TERMINOS-Y-CONDICIONES.md](TERMINOS-Y-CONDICIONES.md) | Términos, condiciones y modelo de negocio (legal/comercial). |
| [PLAN-PRUEBAS-QA.md](PLAN-PRUEBAS-QA.md) | Plantilla de plan de pruebas QA por rol/módulo (se actualiza por ciclo). |
| [PLAN-ERRORES.md](PLAN-ERRORES.md) | Metodología find→verify de cacería de bugs + backlog abierto. |

## Planes / propuestas (aún NO implementados)

| Doc | Estado |
|---|---|
| [PLAN-CORREO-POR-CUENTA.md](PLAN-CORREO-POR-CUENTA.md) | Diseño aprobado, implementación parcial (solo Reply-To + hardening RLS). |
| [PLAN-MODULO-FINANCIERO.md](PLAN-MODULO-FINANCIERO.md) | Propuesta de módulo de facturación/suscripciones — pendiente de aprobación. |
| [PLAN-generar-preguntas-desde-contenido.md](PLAN-generar-preguntas-desde-contenido.md) | Generar preguntas con IA leyendo el material del curso — gap abierto. |
| [FEASIBILITY-VIDEO-IA.md](FEASIBILITY-VIDEO-IA.md) | Estudio de factibilidad de generación de video con IA — no implementado. |
| [optimizaciones.md](optimizaciones.md) | Backlog de optimizaciones (algunas aplicadas, resto pendiente). |

## Negocio

- [costos/](costos/) — análisis de infraestructura, modelos de negocio y precios (4 modelos: autogestionada, administrada, independientes, aliados). `costos/analisis/historico/` conserva versiones previas.

## Demos, videos y comunicación

- [demos/](demos/) — pipeline propio de **videos demo** (`demos/admin/pipeline/`: Playwright + edge-tts + ffmpeg; specs `module-*.json`; convenciones en `AJUSTES-VIDEOS.md`), **manuales por rol** (`demos/manual/`), **plantillas de correo** de difusión (`demos/correos/`) y mensajes sociales (`demos/social/`). Guía operativa: `demos/README-mensajes.md`.

## Otros

- [articulo-revista-semillero.md](articulo-revista-semillero.md) — borrador de artículo para revista de semillero.

## Archivo

- [archive/](archive/) — documentación **obsoleta** conservada por historia: intento de auto-hosting con Docker (abandonado por Lovable), contexto previo a `CLAUDE.md`, reportes de hallazgos ya resueltos, auditorías de seguridad históricas y planes superados. Ver [archive/README.md](archive/README.md).

# Regeneración de guiones — SuperAdmin + FAQ Admin/SuperAdmin (2026-10)

Alcance: `module-sa01..05`, `module-faqa01..15`, `module-faqsa01..06`. Solo specs
(sin grabar, sin `make.mjs`, sin escrituras a DB). Verificado contra `src/routes/*`,
`src/shared/components/AppLayout.tsx` (nav `to:` = `data-tour-nav`) y
`src/i18n/locales/es.json`. 26 JSON validados (parse OK, syncWords únicos por escena,
sin títulos+rol duplicados).

## Hallazgos transversales (nav / rutas reales hoy)
- Etiquetas de nav cambiaron: `Sistema` (no "Diagnósticos"), `Precios` (no "Costos"),
  `Instrucciones IA` (no "Prompts"), `Tareas de IA` (ai-cron), `Documentos` (report-templates),
  `Asistente IA` → ruta **`/app/assistant`** (NO `/app/admin/support-assistant`, que redirige).
- **Email settings** ya no es módulo propio: vive en `/app/admin/settings` → pestaña **Correos**
  (gobierna "qué avisa la plataforma": campanita + correo + push, no solo email).
- **Errores** ya no es ruta propia: es la 2ª pestaña de **Auditoría** (`/app/admin/audit-logs`),
  con "Analizar con IA". Los **inicios de sesión fallidos** se auditan (`user.login_failed`).
- SA `Sistema` tiene pestañas: Plataforma · Correos · Backups · Diagnósticos · Secretos infra.
  La pestaña Correos del SA = mismo panel de toggles (no "actividad de envío"); el estado SMTP
  vive en Diagnósticos (card Email SMTP). Botón real: **"Refrescar diagnóstico"**.
- **Sugerir respuesta con IA** (`support.aiSuggestReply`) vive dentro del detalle del ticket.

## Cambios por archivo
- **sa01**: focus/syncWords de menú a labels reales (Instituciones/Sistema/Precios/Soporte).
  El Asistente IA NO va (su nav es Docente/Admin, no SA). Carátulas con título propio.
- **sa02**: tuteo + syncWords; outro con título del módulo. Beats OK (nav, text:Nueva, firstcard).
- **sa03**: título "Sistema"; corregida la escena Correos (era "actividad de envío" → ahora
  "qué avisa la plataforma"). Diagnósticos usa `button:Refrescar diagnóstico` (verificado).
- **sa04**: renombrado a "Calculadora de precios" (antes "costos"); menciona plan/modelo/IA.
- **sa05**: +escena "asistida" con **Sugerir respuesta con IA**. syncWords.
- **faqa05**: reescrito a "Qué avisa la plataforma" → `/app/admin/settings` tab **Correos**.
- **faqa06**: label "Instrucciones IA" + botón "Restaurar default" + ajuste per-curso docente.
- **faqa09**: +pestaña Errores, +logins fallidos, +"Analizar con IA".
- **faqa12**: `/app/admin/settings` tab **Módulos** (antes firstcard sobre tab general).
- **faqa01/02/03/04/07/08/10/11, faqsa01/02/03/06**: verificados y con syncWord agregado
  (todas las claims siguen siendo exactas; textos de botón `Nuevo usuario/curso/ticket`,
  `Importar`, `Nueva institución` confirmados en i18n).
- **faqsa04**: +Sugerir respuesta con IA. **faqsa05**: pestaña Diagnósticos + "Refrescar".

## Archivos nuevos (next free numbers)
- **module-faqa13** — Asistente IA (`/app/assistant`).
- **module-faqa14** — Tareas de IA / cola calificación+generación (`/app/admin/ai-cron`).
- **module-faqa15** — Documentos / plantillas con variables (`/app/admin/report-templates`).
  (Cubren los módulos Admin que no tenían FAQ.)

## Seeds necesarios (para que no salgan vacíos)
- **faqa14 (Tareas de IA)**: la cola suele estar vacía → sembrar jobs en varios estados
  (ver AJUSTES §9 / `scratchpad/seed-cron-pg.mjs`) antes de grabar.
- **faqa15 (Documentos)**: tener ≥1 plantilla para que `firstcard` muestre contenido.
- **sa05/faqsa04 (Soporte)**: ≥1 ticket en la bandeja; para el beat de IA, abrir un ticket
  (requiere edge `support-ai-suggest` desplegada).
- **sa03 Diagnósticos**: requiere que los chequeos corran en vivo (edge `health-check`).

## Riesgos / privacidad (SA)
- **Datos reales expuestos**: el recorder entra como SuperAdmin cross-tenant, así que
  `sa01` (dashboard: nombres/contadores), `sa02`/`faqsa01-03` (lista de instituciones),
  `sa05`/`faqsa04` (tickets) muestran instituciones REALES (uniaj, fesna, univalle, linkvide).
  Las narraciones/beats son genéricas (no citan datos), pero el video SÍ los capta.
  **Recomendación**: antes de grabar la serie SA, dejar en la institución demo solo lo
  necesario o aceptar que la lista es inherente al rol (Demo Global Corp es una fila más).
  No se puede "override a demo" en estas pantallas (son cross-tenant por diseño).
- **seed-faq-videos.mjs NO sube los faqsa**: su regex `^module-faq[ats]\d+\.json$` exige UNA
  letra tras "faq" seguida de dígitos, y "faqsa01" tiene "sa" → **todos los SuperAdmin FAQ
  quedan fuera del seeding** (verificado). Hay que ampliar el regex a algo como
  `^module-faq(sa|[ats])\d+\.json$` para registrar los 6 faqsa en `platform_help_videos`.
  Fuera de mi alcance de edición; se reporta.
- `tab:` en faqa05/faqa12 depende de que el recorder cambie de pestaña en `/app/admin/settings`
  (Admin arranca en tab "Generales"). Soportado por el recorder (platform scene `tab`).

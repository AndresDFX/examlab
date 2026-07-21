# Auditoría de consistencia de nombres visibles — 2026-07-20

Workflow de 6 dimensiones (paridad i18n, nombres de módulo sidebar↔header↔tour,
rename "Reto en vivo", rename "institución", naming del Asistente, labels de
entidad/estado). **20 inconsistencias confirmadas.** Solo texto VISIBLE al usuario
(no identificadores, keys, tablas ni comentarios).

## ✅ Corregido en esta pasada

**i18n es-CO que estaba en inglés** (comercio `595c41cd`):
- Filtros de estado de la cola (Cron + panel unificado IA): `Pending/Processing/Failed/
  Rejected/Done/Cancelled` → Pendiente/Procesando/Fallado/Rechazado/Completado/Cancelado.
- Mensajería: "Broadcast" → "Difundir" (botón) / "Difusión" (label).
- Proctoring: monitor "Strikes" → "Advertencias"; diálogo de salida "strike(s)" → "advertencia(s)".
- `badgeDefault` "Default"→"Predeterminado", `metadata` "Metadata"→"Metadatos",
  calculadora "Add-ons"→"Complementos", "Storage sobre el cap"→"Almacenamiento sobre el cupo".

**"tenant" → "institución" en texto visible a Admin/Docente** (commit `a02cb5cd`):
- Error de subida de imagen de certificado (es+en).
- Hint del banco de preguntas: "Admin de la institución" (es+en).
- Alerta de API key de IA: "no funciona en tu institución" (es+en).
- Paso de API key del tour de Admin.

**Títulos de tour alineados al nombre del sidebar** (commit `a02cb5cd`):
- "Certificados" → "Certificaciones" (3 pasos: Admin/Docente/Estudiante).
- "Encuestas y retos en vivo" → "Encuestas" (2 pasos); el matiz queda en la descripción.
- "Pizarras compartidas" → "Pizarras" (1 paso).
- Catálogo de Módulos: "Foro" → "Foros".

## 🟡 Pendiente de decisión de producto

1. **Naming del Asistente (alta).** Conviven tres formas para dos conceptos:
   - Tutor por curso: sidebar/página "Asistente de IA" (con "de"), catálogo "Tutor del curso".
   - Asistente de plataforma (`/app/assistant`): sidebar/página "Asistente IA" (sin "de"),
     tarjeta destacada "Asistente de la plataforma", tour "Asistente de IA".
   - Recomendación: canónico **"Asistente de IA"** para el tutor por curso y
     **"Asistente de la plataforma"** para el de plataforma (evita el choque de nombres
     casi idénticos). Requiere confirmar el naming antes de tocar nav/catálogo/tour.
   - Ubicaciones: `nav.aiAssistant` (es.json:166), `nav.supportAssistant` (:120),
     `supportAssistant.title` (:8812), `supportAssistant.emptyTitle` (:8819),
     `tutorIndex.platformCardTitle` (:4809), `module-catalog.ts:104,112`,
     `PlatformAssistantChat.tsx:217,320`, `tour-config.ts:1151,1153`.

2. **"Mis cursos" / "Mis estudiantes" (media/baja).** Los tours de Docente/Estudiante
   titulan pasos "Mis cursos" y "Mis estudiantes" mientras el sidebar dice "Cursos"/
   "Usuarios". Probablemente **intencional** (personalización de la vista propia). Si se
   quiere unificar, decidir si el nav docente pasa a "Mis cursos"/"Mis estudiantes" o el
   tour vuelve a "Cursos"/"Usuarios".

## 🔵 Diferido — solo visible al SuperAdmin (baja prioridad)

El usuario pidió ocultar la arquitectura multi-tenant a **quien no es SuperAdmin**. Estos
textos con "tenant"/"cross-tenant" **solo los ve el SuperAdmin** (banner de override,
opción "vista cross-tenant", panel comercial, impersonación). El SA conoce la
arquitectura, así que quedan como mejora cosmética opcional:
- `overrideBannerHint`, `crossTenantAiHint`, `crossTenantOnlySuperAdmin`, `crossTenantOption`,
  `crossTenantTitle`, `overrideBannerExitTitle`, `backToCrossTenant`, `institutionSADescCrossTenant`,
  `actionImpersonateHint`, `removeConfirmDescription`, `scopeNote`, pricing `modelo2`/`toggleIsolationHint`,
  `crossTenant` (dashboard SA), `TenantBillingDialog.tsx:204` ("Propia (key del tenant)").
- Recomendación si se abordan: "cross-tenant" → "entre instituciones" / "multi-institución".

## Limpio (sin hallazgos)

- **rename "Reto en vivo"**: 0 ocurrencias de "Kahoot" en texto visible — el rename quedó bien.

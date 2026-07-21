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

## ✅ Verificado — ya estaba resuelto

**Naming del Asistente (el workflow lo marcó "alta", pero el hallazgo era stale).** Al
verificar el estado real del código, el naming YA es consistente y sin colisión:
- Asistente de plataforma (`/app/assistant`): **"Asistente de la plataforma"** en todas
  las superficies — `nav.supportAssistant` (es.json:120), `filterModuleSupport` (:4606),
  `supportAssistant.title` (:8812), `tutorIndex.platformCardTitle` (:4809), y el
  `defaultValue` de `PlatformAssistantChat.tsx:217`. EN = "Platform Assistant".
- Tutor/umbrella del estudiante: **"Asistente de IA"** (`nav.aiAssistant` :166,
  `tutorIndex.title` :4802). Catálogo de Módulos: **"Tutor del curso"** (`nav.tutor` :154)
  — correcto para el panel de configuración (distingue los dos módulos).
- No queda ninguna variante "Asistente IA" (sin "de") en texto visible. Sin acción.

## 🟡 Pendiente de decisión de producto

1. **"Mis cursos" / "Mis estudiantes" (media/baja).** Los tours de Docente/Estudiante
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

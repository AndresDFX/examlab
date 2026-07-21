# Auditoría de "features fantasma" (nombradas pero no implementadas) — 2026-07-20

Workflow de 6 dimensiones (nav/rutas, botones no-op, promesas del tour, toggles de
settings, RPC/edge ausentes, KB/videos del asistente). **3 hallazgos**, todos verificados.
Dimensiones limpias (sin fantasmas): **nav/rutas**, **botones no-op**, **promesas del tour**,
**RPC/edge ausentes** — o sea, no hay rutas del menú sin pantalla, ni botones que no hagan
nada, ni el tour promete flujos inexistentes, ni el cliente llama RPCs/edges que no existen.

## 🟠 Media

**Videos de ayuda del asistente con `video_url` NULL** — *falso positivo en prod, mitigado igual.*
- El audit leyó el **seed de la migración** (`20261270000000`), que inserta las 43 filas de
  módulo con `is_active=true` y `video_url` NULL, y notó que el edge las anunciaría como
  "video en preparación".
- **Reconciliación contra prod**: las **43 filas de módulo ya tienen `video_url` poblado**
  (`url_null=false`, `is_active=true`) — una sesión previa las subió. El asistente NO está
  anunciando videos inexistentes en producción.
- **Mitigación aplicada** (commit de este doc): el edge `platform-support-chat` ahora filtra
  `video_url IS NOT NULL` — nunca anuncia un clip sin enlace real. Belt-and-suspenders para
  filas futuras (los FAQ ya nacen `is_active=false` sin MP4).

## 🟢 Baja — honestamente declaradas como "futuras" (roadmap, no bug)

1. **"Cerrar periodo académico" → bloquear notas.** El botón (AdminAcademicPeriodsPanel)
   SÍ cierra el periodo (`status='cerrado'` + audit), pero la consecuencia prometida
   ("Próximamente esto bloqueará modificaciones a calificaciones") **no está implementada**:
   ningún editor de notas ni RLS lee `status='cerrado'`. El texto lo dice "Próximamente".
   - *Acción*: dejar como está (honesto) o quitar la 2ª oración del `confirmCloseDesc`.
   - *Para implementarlo de verdad*: gatear `submissions`/`external grades` cuando el corte
     cae en un periodo cerrado (gradebook + ExternalGradesEditor + RLS).

2. **Campo "Dominio email (opcional)" de la institución.** Editable y se persiste
   (`tenants.email_domain`), pero **nada lo lee** para lógica de negocio (la auto-asignación
   de usuarios por dominio no existe). El hint ya declara "para versiones futuras".
   - *Acción*: dejar `disabled`/"próximamente" hasta implementar, o implementar la
     auto-asignación (handle_new_user / bulk-import-users leyendo `email_domain`).

## Nota

Ambos hallazgos "baja" son features de roadmap **declaradas honestamente** en la propia UI
("Próximamente" / "para versiones futuras"), no promesas engañosas. Se documentan como gaps
conocidos; implementarlas es trabajo de feature, no una corrección de consistencia.

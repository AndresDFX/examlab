# Módulo 10 — Auditoría, Soporte (PQRS) y Papelera

- **Duración objetivo:** 120–140 s
- **Rutas:** `/app/admin/audit-logs` (tab Errores incluida) · `/app/admin/support`
  · `/app/trash`
- **Precondiciones:** sesión Admin de *Demo Global Corp*; con actividad previa de
  la serie, la auditoría y la papelera ya tendrán registros reales.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).

---

### Escena 0 — Contexto · 0:00–0:08
- **VISUAL:** `CURSOR→([data-tour-module="audit_logs"])`, `CLICK(Auditoría)`.
  `LOWER-THIRD`: **“Módulo 10 · Auditoría, Soporte y Papelera”**.
- **VOZ:** «Este módulo agrupa las herramientas de gobierno de la institución:
  trazabilidad, soporte y recuperación de lo eliminado.»

### Escena 1 — Auditoría (quién hizo qué) · 0:08–0:42
- **VISUAL:**
  1. `ZOOM-OUT` a la bitácora de auditoría. `PAN` por columnas (actor, acción,
     entidad, fecha).
  2. `HIGHLIGHT(una entrada)` que muestre, por ejemplo, una creación de usuario o
     un reset de contraseña del módulo 2.
  3. `CURSOR→(tab "Errores")`, `CLICK`. `HIGHLIGHT` la lista de fallos.
- **VOZ:** «La auditoría registra quién hizo qué y cuándo. Sirve para responder
  reclamos y para investigar incidentes. Cada registro pertenece a esta
  institución: un Administrador no ve la actividad de otra. Adentro, una pestaña de
  Errores reúne lo que falló, útil para el equipo de soporte.»
- **BEAT multi-tenant (voz):** «cada registro pertenece a esta institución».

### Escena 2 — Soporte (PQRS) hacia el SuperAdmin · 0:42–1:18
- **VISUAL:**
  1. `CURSOR→([data-tour-module="support"])`, `CLICK(Soporte)`. `ZOOM-OUT` a la
     lista de tickets + stats.
  2. `CURSOR→(botón "Nuevo ticket")`, `CLICK`. Modal: categoría (**petición /
     queja / reclamo / sugerencia**), asunto, descripción, adjuntos.
  3. Tipeo de un ticket de demo, `HIGHLIGHT(adjuntar archivo)`, `CLICK(Crear)`.
  4. Abrir el ticket: `ZOOM-IN` al chat interno del ticket.
- **VOZ:** «Soporte es el canal directo del Administrador con el dueño de la
  plataforma, el SuperAdmin. Aquí se abren peticiones, quejas, reclamos o
  sugerencias, con archivos adjuntos y una conversación dentro del propio ticket.
  El Administrador recibe notificación cuando le responden o cambian el estado.
  Es importante notar la dirección del canal: el Administrador escala hacia la
  plataforma; no gestiona otras instituciones.»
- **BEAT RBAC (voz):** «el Administrador escala hacia la plataforma; no gestiona
  otras instituciones» — la operación cross-tenant es exclusiva del SuperAdmin.

### Escena 3 — Papelera (recuperar lo eliminado) · 1:18–1:50
- **VISUAL:**
  1. `CURSOR→([data-tour-module="trash"])`, `CLICK(Papelera)`. `ZOOM-OUT` a la
     tabla unificada.
  2. `HIGHLIGHT(badge "días restantes")` de un elemento (rojo si quedan pocos).
  3. `CURSOR→(acción "Restaurar")`, `CLICK`. Confirmar; el elemento vuelve a su
     listado original.
- **VOZ:** «Cuando se elimina un curso, examen, taller o proyecto, no desaparece de
  inmediato: pasa a la Papelera, donde permanece treinta días antes del borrado
  definitivo. Desde aquí se restaura con un clic. Mientras un elemento está en la
  papelera, deja de ser visible y utilizable en cualquier flujo y rol —hasta que
  se restaure—. Y, como todo, la papelera está acotada a esta institución.»

### Escena 4 — Cierre · 1:50–2:00
- **VISUAL:** `ZOOM-OUT` a la papelera. `LOWER-THIRD`: **“Siguiente módulo:
  Cuenta y Cierre de Sesión”**. Fade out.
- **VOZ:** «Cerramos la serie con la gestión de la propia cuenta del
  Administrador y el cierre seguro de sesión.»

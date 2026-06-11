# Módulo 6 — Configuración de IA (Prompts · Modelo · Cola)

- **Duración objetivo:** 120–140 s
- **Rutas:** `/app/admin/ai-prompts` (tabs Prompts + Modelo) · `/app/admin/ai-cron`
  (Jobs + Supabase Cron)
- **Precondiciones:** sesión Admin de *Demo Global Corp*; idealmente algún job en
  la cola (pendiente / fallido) para mostrar el reintento.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).
- **Nota de alcance:** la **API key** del proveedor de IA se gestiona en
  *Configuración → Modelo IA* (Módulo 7). Este módulo cubre la **política de IA**:
  los prompts, el modelo activo y la cola de trabajos.

---

### Escena 0 — Contexto · 0:00–0:08
- **VISUAL:** `CURSOR→([data-tour-module="ai_prompts"])`, `CLICK(Prompts IA)`.
  `LOWER-THIRD`: **“Módulo 6 · Configuración de IA”**.
- **VOZ:** «La inteligencia artificial califica entregas, genera material y detecta
  copias. Aquí el Administrador define cómo se comporta esa IA dentro de la
  institución.»

### Escena 1 — Prompts por caso de uso · 0:08–0:40
- **VISUAL:**
  1. `HIGHLIGHT(tab "Prompts")`. `ZOOM-IN(lista de casos de uso, 120%)`: taller
     completo, pregunta de taller, archivo de proyecto, proyecto completo,
     pregunta de examen.
  2. `CURSOR→(un caso de uso)`, `CLICK`. Abre el editor del prompt del sistema.
     `PAN` por el texto (rol, criterios, tono).
  3. `HIGHLIGHT(botón "Restaurar default")`.
- **VOZ:** «Los prompts definen el criterio con el que la IA evalúa: su rol, su
  nivel de exigencia y su tono. Hay un prompt por cada caso de uso. Lo que se
  define aquí es la política base de la institución; cada docente puede ajustarla
  para su propio curso sin alterar la global. Solo se edita el criterio: los datos
  de cada entrega los inyecta el sistema, de modo que no es posible romper el
  contrato del prompt.»

### Escena 2 — Modelo y modo de procesamiento · 0:40–1:05
- **VISUAL:**
  1. `CURSOR→(tab "Modelo")`, `CLICK`. `ZOOM-IN(selector proveedor + modelo, 130%)`.
  2. `HIGHLIGHT(proveedor)` (Gemini / OpenAI) y `HIGHLIGHT(modo de procesamiento:
     sync / async)`.
- **VOZ:** «Elegimos el proveedor y el modelo de IA, y el modo de procesamiento.
  En modo síncrono, la generación ocurre en el momento; en modo asíncrono, el
  trabajo se encola y se procesa en segundo plano para controlar el gasto. Esta
  configuración aplica a toda la institución.»

### Escena 3 — Cola de IA: monitoreo y reintento · 1:05–1:40
- **VISUAL:**
  1. `CURSOR→([data-tour-module="ai_cron"])`, `CLICK(Cola de IA)`. `ZOOM-OUT` al
     panel de jobs.
  2. `HIGHLIGHT(stats: pendientes / en proceso / fallados)`. `PAN` por la tabla.
  3. `CURSOR→(un job fallido)`, `CLICK` para expandir — `HIGHLIGHT(preview del
     error + detalle)`. `CURSOR→(botón "Reintentar")`, `CLICK`.
- **VOZ:** «La cola de IA muestra todo lo que la inteligencia artificial está
  haciendo: qué entregas está calificando, qué material está generando y qué se
  trabó. Si un trabajo falla, vemos el error completo y lo reintentamos con un
  clic. Esto es clave para soporte: cuando un docente avisa que una nota no llegó,
  aquí se diagnostica y se resuelve.»
- **NOTA editor:** mostrar el botón **Copiar** del detalle de error como gesto de
  diagnóstico.

### Escena 4 — Cierre · 1:40–1:52
- **VISUAL:** `ZOOM-OUT` al panel de cola. `LOWER-THIRD`: **“Siguiente módulo:
  Configuración del Tenant”**. Fade out.
- **VOZ:** «Para que la IA funcione, la institución necesita su propia clave de
  proveedor. Eso —junto al branding, las cuotas y los correos— se configura en el
  siguiente módulo.»

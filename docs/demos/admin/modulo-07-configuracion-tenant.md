# Módulo 7 — Configuración del Tenant

- **Duración objetivo:** 120–140 s
- **Ruta:** `/app/admin/settings`
- **Precondiciones:** sesión Admin de *Demo Global Corp*; tener (sin exponer en
  pantalla) una API key de IA de demo para ilustrar el flujo.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).
- **Nota de frontera (importante para el relato):** la **existencia** de la
  institución y su identidad cross-tenant (slug, dominio de correo) las crea el
  **SuperAdmin** de la plataforma. Lo que el Administrador ajusta aquí es la
  **configuración operativa de su propia institución**: branding, cuotas,
  visibilidad de módulos, clave de IA y correos.

---

### Escena 0 — Contexto · 0:00–0:08
- **VISUAL:** `CURSOR→([data-tour-nav="/app/admin/settings"])`,
  `CLICK(Configuración)`. `LOWER-THIRD`: **“Módulo 7 · Configuración del Tenant”**.
  Plano de los tabs.
- **VOZ:** «Configuración es el panel de control de la institución. Desde aquí el
  Administrador ajusta cómo se ve, cómo opera y cómo se comunica *Demo Global
  Corp* — siempre dentro de los límites de su propio inquilino.»

### Escena 1 — Branding · 0:08–0:32
- **VISUAL:**
  1. `HIGHLIGHT(sección branding)`. `CURSOR→(selector de color primario)`, `CLICK`,
     elegir un color. `ZOOM-IN` a cómo el botón primario / sidebar adoptan el
     color al instante.
  2. `CURSOR→(carga de logo)`, mostrar la previsualización.
- **VOZ:** «El branding define el logo y los colores de la institución. El cambio
  se aplica al instante en toda la interfaz: botones, menú lateral y acentos
  adoptan la identidad de *Demo Global Corp*. Cada institución mantiene su propia
  apariencia, independiente de las demás.»

### Escena 2 — Cuotas por rol y visibilidad de módulos · 0:32–1:02
- **VISUAL:**
  1. `CURSOR→(sección "Cuotas")`, `HIGHLIGHT`. Mostrar los límites por rol.
  2. `CURSOR→(sección "Visibilidad de módulos")`, `HIGHLIGHT`. `ZOOM-IN` a una
     fila con toggles por rol (Admin / Docente / Estudiante).
  3. Apagar/encender un módulo para un rol y `HIGHLIGHT` el efecto.
- **VOZ:** «Definimos cuántos usuarios admite cada rol y, sobre todo, qué módulos
  ve cada uno. Esta es otra capa del control de acceso: además de lo que el rol
  permite por diseño, el Administrador decide qué partes de la plataforma quedan
  visibles para docentes y estudiantes de su institución. Los cambios aplican solo
  a *Demo Global Corp*.»
- **BEAT RBAC (voz):** énfasis en «qué módulos ve cada rol… solo en esta
  institución».

### Escena 3 — API key de IA · 1:02–1:28
- **VISUAL:**
  1. `CURSOR→(tab "Modelo IA" / [data-tour-id="settings-ai-tab"])`, `CLICK`.
     `HIGHLIGHT(tab)`.
  2. `HIGHLIGHT(selector de proveedor)` (Gemini recomendado / OpenAI).
  3. `CURSOR→(campo API key)`, pegar una clave de demo (mantenerla oculta /
     enmascarada). `CLICK(Guardar)`.
- **VOZ:** «Cada institución necesita su propia clave del proveedor de IA. Sin
  ella, la calificación automática, la generación de contenidos y la detección de
  copia no funcionan. El costo se factura a la cuenta del proveedor de la
  institución. La clave se guarda de forma segura como secreto del entorno —no
  queda expuesta en la base de datos ni visible para otros usuarios.»

### Escena 4 — Correos · 1:28–1:55
- **VISUAL:**
  1. `CURSOR→(tab "Correos" / [data-tour-id="settings-email-tab"])`, `CLICK`.
  2. `HIGHLIGHT(interruptor global)`. Explicar el kill-switch.
  3. `CURSOR→(toggle "Bienvenida" / [data-tour-id="email-kind-welcome"])`,
     `HIGHLIGHT`. Mostrar prender/apagar.
- **VOZ:** «En Correos se controla, por categoría, qué notificaciones salen por
  email: calificaciones, mensajes, encuestas. Hay un interruptor global que, al
  apagarse, detiene todos los correos manteniendo las notificaciones dentro de la
  app. Y un toggle de bienvenida: el correo de *“define tu contraseña”* que se
  envía al crear usuarios. Se apaga cuando las claves se reparten por otro canal.»

### Escena 5 — Cierre · 1:55–2:05
- **VISUAL:** `ZOOM-OUT` al panel. `LOWER-THIRD`: **“Siguiente módulo:
  Certificados”**. Fade out.
- **VOZ:** «Con la institución configurada, pasamos a los entregables hacia el
  estudiante. El siguiente módulo cubre la emisión de certificados.»

# Módulo 2 — Gestión de Usuarios y Roles

- **Duración objetivo:** 50–57 s · **producido:** ~56 s.
- **Ruta:** `/app/admin/users` (ya autenticado, sin login en cámara).
- **Enfoque:** centrado solo en Demo Global Corp; el rol es control de acceso
  dentro de la institución (no es el modelo multi-institución).
- **Estilo:** cámara dinámica (zoom/pan) + foco estilo onboarding (spotlight +
  popover).
- **Fuente de verdad:** [pipeline/modules/module-02.json](pipeline/modules/module-02.json)
  (narración, targets, escala, hold, textos de popover). Para cambiar el módulo
  se edita ese JSON. Ver [pipeline/](pipeline/).

---

### Escena 1 — Intro · ~0:00–0:09
- **VISUAL:** Carátula azul: **“ExamLab · Rol Administrador”** / **“Usuarios y
  Roles”** / **“Demo Global Corp”**. (La página de usuarios carga por detrás.)
- **VOZ:** «Módulo dos: gestión de usuarios y roles. Administramos las personas
  de Demo Global Corp y definimos lo que cada una puede hacer.»

### Escena 2 — Crear un usuario · ~0:09–0:20
- **VISUAL:** Zoom + spotlight sobre el botón **“Nuevo usuario”**; popover
  **“Nuevo usuario — Crea una persona y asigna sus roles y contraseña temporal.”**
- **VOZ:** «Creamos una persona con el botón Nuevo usuario: indicamos su correo,
  su nombre y sus roles, y le damos una contraseña temporal que deberá cambiar en
  su primer ingreso.»

### Escena 3 — Roles (RBAC) · ~0:20–0:34
- **VISUAL:** Spotlight sobre la **columna Roles** (popover **“Roles — Definen qué
  ve y qué puede hacer cada persona.”**), luego sobre la **fila completa de un
  usuario** a tamaño real (escala 1.0, sin recorte) — popover **“Cada usuario —
  Sus roles aparecen en la lista…”**.
- **VOZ:** «El rol es la pieza clave del control de acceso: define qué módulos ve
  y qué puede hacer cada persona. La lista muestra los roles de cada usuario; un
  docente ve sus herramientas de enseñanza, un estudiante solo las suyas.»

### Escena 4 — Importación en lote y acciones · ~0:34–0:48
- **VISUAL:** Spotlight sobre el menú **“Datos”** (popover **“Importar en lote —
  Carga muchos usuarios desde un archivo CSV.”**), luego **se hace click en el
  botón de acciones (tres puntos)** de una fila → **se abre el menú** mostrando
  las acciones reales (**Editar · Iniciar como · Eliminar**) con la página en dim
  por detrás (vía `clickToOpen` + hook `data-row-actions`).
- **VOZ:** «Para grupos grandes, importamos muchos usuarios a la vez desde un
  archivo. Y cada usuario ofrece acciones de soporte: iniciar sesión como esa
  persona o restablecer su contraseña, todo registrado en la auditoría.»

### Escena 5 — Outro · ~0:48–0:54
- **VISUAL:** Carátula azul: **“Siguiente módulo: Estructura Académica”**.
- **VOZ:** «En el siguiente módulo: la estructura académica de la institución.»

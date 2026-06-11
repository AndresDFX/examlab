# Módulo 1 — Panel de administración y Dashboard

- **Duración objetivo:** 50–57 s (rango pedido: 30–60 s) · **producido:** ~54 s.
- **Ruta:** `/app` (ya autenticado).
- **Enfoque:** centrado **solo en la institución (Demo Global Corp)**. NO se
  menciona el modelo multi-institución ni otras instituciones; el relato es el de
  "el panel de tu institución". Tampoco se muestra el login (el acceso será por
  subdominio); la grabación arranca dentro de la app.
- **Estilo visual:** **cámara dinámica** (zoom/pan reales) + **foco estilo
  onboarding (driver.js)**: en cada punto se resalta el elemento con un spotlight
  (se oscurece el resto) y aparece un **popover** con título y descripción.
- **Fuente de verdad:** este guion es la versión legible; el módulo se controla
  por el spec declarativo [pipeline/modules/module-01.json](pipeline/modules/module-01.json)
  (narración, targets, escala, hold y textos de los popovers). Para cambiar el
  módulo se edita ese JSON. Ver [pipeline/](pipeline/).
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).

---

### Escena 1 — Intro · ~0:00–0:05
- **VISUAL:** Carátula azul de marca: `LOWER-THIRD` **“ExamLab · Serie de
  demostración”**, título **“Demo Global Corp”**, subtítulo **“Rol:
  Administrador”**. (El dashboard carga por detrás.)
- **VOZ:** «Demostración del panel de administración de *Demo Global Corp*, en
  ExamLab.»

### Escena 2 — Identidad de la institución · ~0:05–0:17
- **VISUAL:** Se revela el dashboard. La **cámara hace zoom-in** a la marca del
  sidebar (**“Demo Global Corp”**, logo + colores) y luego se desplaza al saludo
  **“Hola, …”** del encabezado. Cierra con zoom-out al panel completo.
- **VOZ:** «Este es el panel de la institución. Su identidad —el logotipo, el
  nombre y los colores— acompaña toda la plataforma, dándole una experiencia
  propia y reconocible.»

### Escena 3 — Recorrido de módulos · ~0:17–0:33
- **VISUAL:** La **cámara recorre verticalmente el menú lateral** (pan + zoom),
  deteniéndose en Cursos, Usuarios, Académico, Contenidos, Auditoría y
  Configuración. Cierra con zoom-out.
- **VOZ:** «Desde el menú lateral, el Administrador tiene a mano toda la gestión:
  cursos, usuarios, estructura académica, contenidos, certificados, informes,
  configuración y auditoría. Cada área, a un solo clic.»

### Escena 4 — Dashboard de inicio · ~0:33–0:47
- **VISUAL:** La **cámara recorre** las tarjetas de estadística (**Cursos ·
  Usuarios · Por calificar**) una a una, y luego enfoca **“Cursos recientes”** y
  **“Actividad reciente”**. Cierra con zoom-out al panel completo.
- **VOZ:** «El panel de inicio resume el estado de la institución de un vistazo:
  cursos activos, usuarios y el trabajo pendiente por calificar. Debajo, los
  cursos recientes y la actividad reciente del sistema.»

### Escena 5 — Outro · ~0:47–0:53
- **VISUAL:** Carátula azul: **“Siguiente módulo: Gestión de Usuarios y Roles”**.
- **VOZ:** «En el siguiente módulo: la gestión de usuarios y sus roles.»

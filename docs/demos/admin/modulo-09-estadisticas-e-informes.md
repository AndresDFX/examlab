# Módulo 9 — Estadísticas e Informes

- **Duración objetivo:** 100–120 s
- **Rutas:** `/app/admin/statistics` · `/app/admin/report-templates`
- **Precondiciones:** sesión Admin de *Demo Global Corp*; datos suficientes
  (cursos activos, notas) para que las gráficas no salgan vacías.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).

---

### Escena 0 — Contexto · 0:00–0:08
- **VISUAL:** `CURSOR→([data-tour-module="statistics"])`, `CLICK(Estadísticas)`.
  `LOWER-THIRD`: **“Módulo 9 · Estadísticas e Informes”**.
- **VOZ:** «Estadísticas e Informes dan visibilidad sobre el desempeño de la
  institución. Toda la analítica está acotada a *Demo Global Corp*.»

### Escena 1 — Estadísticas institucionales · 0:08–0:42
- **VISUAL:**
  1. `ZOOM-OUT` al tablero de estadísticas. `PAN` por las gráficas.
  2. `HIGHLIGHT(indicador "cursos activos")`, luego `HIGHLIGHT(rendimiento
     general)`, luego `HIGHLIGHT(estudiantes en riesgo)`.
  3. `ZOOM-IN` a una gráfica concreta mientras la voz la describe.
- **VOZ:** «El tablero resume el pulso de la institución: cuántos cursos están
  activos, cómo va el rendimiento general y qué cursos tienen estudiantes en
  riesgo de perder. Son datos listos para una reunión directiva, y reflejan
  únicamente la actividad de esta institución —ningún dato proviene de otra—.»
- **BEAT multi-tenant (voz):** «reflejan únicamente la actividad de esta
  institución».

### Escena 2 — Plantillas de informes · 0:42–1:14
- **VISUAL:**
  1. `CURSOR→([data-tour-module="reports"])`, `CLICK(Informes)`. `ZOOM-OUT` a la
     lista de plantillas.
  2. `CURSOR→(botón "Nueva plantilla")`, `CLICK`. `ZOOM-IN(editor, 120%)`.
  3. `HIGHLIGHT` por sección: **columnas**, **agrupaciones**, **filtros**.
  4. `CLICK(Guardar)`.
- **VOZ:** «Las plantillas de informes definen cómo se generan actas, boletines y
  reportes en PDF: qué columnas incluir, cómo agrupar y qué filtros aplicar. Se
  configuran una vez y los docentes las usan desde su propia pestaña de Informes,
  siempre sobre los datos de sus cursos.»

### Escena 3 — Cierre · 1:14–1:26
- **VISUAL:** `ZOOM-OUT` a la lista de plantillas. `LOWER-THIRD`:
  **“Siguiente módulo: Auditoría, Soporte y Papelera”**. Fade out.
- **VOZ:** «Medir el desempeño es una cara de la gestión; la otra es la
  trazabilidad y el gobierno. Eso veremos en el siguiente módulo.»

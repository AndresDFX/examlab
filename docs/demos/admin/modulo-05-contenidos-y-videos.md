# Módulo 5 — Contenidos y Biblioteca de Videos

- **Duración objetivo:** 110–130 s
- **Rutas:** `/app/teacher/contents` (el Admin revisa el material) · `/app/videos`
- **Precondiciones:** sesión Admin de *Demo Global Corp*; al menos un curso con
  sesiones (Módulo 4); idealmente algún contenido ya generado para mostrar la
  revisión de calidad.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).

---

### Escena 0 — Contexto · 0:00–0:08
- **VISUAL:** `CURSOR→([data-tour-module="contents"])`, `CLICK(Contenidos)`.
  `LOWER-THIRD`: **“Módulo 5 · Contenidos y Videos”**.
- **VOZ:** «El material de estudio —presentaciones, guías, ejercicios, código,
  notebooks— se concentra en Contenidos. El Administrador puede revisar lo que se
  produce en la institución, incluido lo generado con IA, antes de que llegue a
  los estudiantes.»

### Escena 1 — El repositorio de contenido del tenant · 0:08–0:30
- **VISUAL:**
  1. `ZOOM-OUT` al grid de contenidos. `PAN` por columnas (título, curso, estado,
     fecha).
  2. `HIGHLIGHT(filtro por curso)` — todos los cursos del selector son de
     *Demo Global Corp*.
- **VOZ:** «El repositorio agrupa el material por curso. Igual que en el resto de
  la plataforma, solo aparecen los cursos y contenidos de esta institución —los
  archivos viven en un almacenamiento acotado al inquilino—.»

### Escena 2 — Revisar un contenido (calidad) · 0:30–0:58
- **VISUAL:**
  1. `CURSOR→(una fila de contenido)`, `CLICK`. Abre el detalle / archivos por
     clase.
  2. `ZOOM-IN(visor de un archivo, 120%)` — mostrar la previsualización inline
     (imagen / PDF / markdown).
  3. `HIGHLIGHT(estado del contenido)` — generado / revisado.
- **VOZ:** «Al abrir un contenido vemos sus archivos organizados por sesión, con
  vista previa directa. Esto permite verificar la calidad de lo que generó la IA
  o subió un docente, y confirmar que el material es apropiado antes de publicarlo
  a los estudiantes del curso.»

### Escena 3 — Biblioteca de Videos · 0:58–1:30
- **VISUAL:**
  1. `CURSOR→([data-tour-module="videos"])`, `CLICK(Videos)`. `ZOOM-OUT` a la
     biblioteca.
  2. `PAN` por las tarjetas/filas de video; `HIGHLIGHT(stat "Globales")` para
     mostrar los reutilizables.
  3. `CURSOR→(botón "Agregar video")`, `CLICK`. Modal: URL (YouTube/Vimeo) o
     archivo. Pegar una URL de ejemplo y `CLICK(Guardar)`.
- **VOZ:** «La biblioteca de videos centraliza todo el material audiovisual:
  enlaces de YouTube o Vimeo y archivos subidos. Un video se agrega una vez y se
  reutiliza en cuantos cursos haga falta; los docentes lo enlazan luego a sus
  talleres y proyectos. Como todo el contenido, la biblioteca pertenece a esta
  institución.»

### Escena 4 — Cierre · 1:30–1:42
- **VISUAL:** `ZOOM-OUT` a la biblioteca. `LOWER-THIRD`: **“Siguiente módulo:
  Configuración de IA”**. Fade out.
- **VOZ:** «Buena parte de este material puede producirse y calificarse con
  inteligencia artificial. En el siguiente módulo configuramos cómo se comporta la
  IA en la institución.»

# Módulo 3 — Estructura Académica

- **Duración:** ~53 s · **Ruta:** `/app/admin/academic` (ya autenticado).
- **Enfoque:** centrado solo en Demo Global Corp. La página usa **pestañas**
  (Resumen · Carreras · Asignaturas · Periodos); el video va cambiando de tab.
- **Estilo:** cámara dinámica + foco estilo onboarding (spotlight + popover).
  Filas a escala 1.0 (completas); botones "Nuevo X" con zoom.
- **Fuente de verdad:** [pipeline/modules/module-03.json](pipeline/modules/module-03.json).
- **Datos demo:** sembrados con [pipeline/seed-academic.mjs](pipeline/seed-academic.mjs)
  + [pipeline/seed-subjects.mjs](pipeline/seed-subjects.mjs) (3 carreras, 2 periodos,
  3 asignaturas con sílabo).

---

### Escena 1 — Intro · ~0:00–0:08
- **VISUAL:** Carátula azul: **“Estructura Académica” / “Demo Global Corp”**.
- **VOZ:** «Módulo tres: estructura académica. Definimos el catálogo de la
  institución: carreras, asignaturas y periodos.»

### Escena 2 — Carreras · ~0:08–0:20
- **VISUAL:** Cambia a la pestaña **Carreras**. Zoom + foco sobre **“Nuevo
  programa”** (popover “Nueva carrera…”), luego sobre la **fila completa** de una
  carrera (popover “Carreras — Los programas de la institución…”).
- **VOZ:** «En Carreras viven los programas de la institución, como Ingeniería de
  Software. Cada carrera agrupa sus asignaturas y se crea con un clic.»

### Escena 3 — Asignaturas · ~0:20–0:36
- **VISUAL:** Pestaña **Asignaturas**. Foco sobre **“Nueva asignatura”** y sobre
  la **fila completa** de una asignatura (popover “Asignaturas — Cada una con su
  sílabo: objetivos, contenidos, bibliografía e intensidad”).
- **VOZ:** «Las asignaturas son el corazón del catálogo: cada una guarda su
  sílabo —objetivos, contenidos, bibliografía e intensidad horaria— y se asocia a
  una carrera y un semestre. Al crear un curso, esa información se hereda.»

### Escena 4 — Periodos · ~0:36–0:47
- **VISUAL:** Pestaña **Periodos**. Foco sobre **“Nuevo periodo”** y sobre la
  **fila completa** de un periodo (popover “Periodos — Ej. 2026-I, con sus fechas
  de inicio y fin”).
- **VOZ:** «Los periodos académicos, como el primer semestre de 2026, marcan la
  ventana temporal de los cursos, con sus fechas de inicio y fin.»

### Escena 5 — Outro · ~0:47–0:53
- **VISUAL:** Carátula azul: **“Siguiente módulo: Gestión de Cursos”**.
- **VOZ:** «En el siguiente módulo: la gestión de cursos.»

# Módulo 8 — Certificados

- **Duración objetivo:** 90–110 s
- **Ruta:** `/app/certificates`
- **Precondiciones:** sesión Admin de *Demo Global Corp*; al menos un curso con
  estudiantes aprobados para ilustrar una emisión.
- **Convenciones visuales:** ver [README](README.md#convenciones-visuales-del-guion-para-el-editor).

---

### Escena 0 — Contexto · 0:00–0:08
- **VISUAL:** `CURSOR→([data-tour-module="certificates"])`, `CLICK(Certificados)`.
  `LOWER-THIRD`: **“Módulo 8 · Certificados”**.
- **VOZ:** «Los certificados acreditan la finalización de un curso. El
  Administrador define el diseño una vez y la institución los emite a los
  estudiantes que aprueban.»

### Escena 1 — Plantilla de certificado · 0:08–0:40
- **VISUAL:**
  1. `CURSOR→(botón "Nueva plantilla" / sección de diseño)`, `CLICK`.
  2. `ZOOM-IN(editor de plantilla, 120%)`. `HIGHLIGHT` por elemento: **logo**,
     **firma**, **texto del certificado**, campos dinámicos (nombre del alumno,
     curso, fecha).
  3. `CLICK(Guardar)`. Mostrar la previsualización resultante.
- **VOZ:** «La plantilla define la identidad visual del certificado: el logo de la
  institución, la firma, el texto y los campos que se rellenan automáticamente con
  los datos de cada estudiante y curso. Se diseña una sola vez y se reutiliza.»
- **NOTA editor:** el logo y los colores deben coincidir con el branding del
  Módulo 7 — refuerza la coherencia de marca del tenant.

### Escena 2 — Emisión a estudiantes aprobados · 0:40–1:08
- **VISUAL:**
  1. `CURSOR→(selector de curso)`, `CLICK`. `HIGHLIGHT` — solo aparecen cursos de
     *Demo Global Corp*.
  2. Mostrar la lista de estudiantes elegibles. `CURSOR→(acción "Emitir")`,
     `CLICK`. Confirmar.
  3. `ZOOM-IN` a un certificado emitido / su código de verificación.
- **VOZ:** «Para emitir, elegimos un curso de la institución y aplicamos la
  plantilla a los estudiantes que cumplen los requisitos de aprobación. Cada
  certificado queda ligado a su curso y estudiante. Como en el resto de la
  plataforma, solo se listan cursos y alumnos de esta institución.»

### Escena 3 — Cierre · 1:08–1:18
- **VISUAL:** `ZOOM-OUT` a la lista de certificados. `LOWER-THIRD`:
  **“Siguiente módulo: Estadísticas e Informes”**. Fade out.
- **VOZ:** «Con los certificados cubiertos, el siguiente módulo muestra cómo medir
  y reportar el desempeño de la institución.»

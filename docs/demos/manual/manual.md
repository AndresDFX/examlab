# Manual de usuario — ExamLab

ExamLab es una plataforma educativa con **inteligencia artificial** que reúne, en un solo lugar, todo el ciclo académico: cursos, evaluaciones, asistencia, contenidos y comunicación. La IA te ahorra horas — **genera** exámenes/talleres/proyectos y material de clase, **califica** las entregas con retroalimentación, **detecta copias** y ofrece un **tutor** a los estudiantes.

Este manual está organizado por **rol**. Abre el que corresponda a tu perfil:

- 🛠️ **[Administrador](manual-administrador.md)** — gestiona toda la institución (usuarios, cursos, estructura académica, certificados, configuración) y supervisa evaluaciones y calificaciones.
- 👩‍🏫 **[Docente](manual-docente.md)** — crea cursos y evaluaciones (con ayuda de la IA), califica, lleva asistencia y consolida notas.
- 🎓 **[Estudiante](manual-estudiante.md)** — presenta exámenes, talleres y proyectos, consulta sus notas y usa el tutor de IA.

> **SuperAdmin (dueño de la plataforma):** este rol opera **cross-tenant** (gestiona varias instituciones desde una sola consola) y, por su naturaleza interna, no tiene un manual público en este paquete. Su operación se documenta en los runbooks internos del equipo de plataforma. Si necesitas la guía SuperAdmin, contáctanos por el canal de **Soporte**.

---

## Cómo ingresar

1. Abre la plataforma en tu navegador: **https://examlab.lovable.app/auth**
2. En **"Selecciona tu institución"**, elige tu institución de la lista. *(Si te entregaron una **cuenta de demostración**, elige **ExamLab Demo**.)*
3. Escribe el **usuario (correo)** y la **contraseña** que recibiste por correo.
4. Toca **Entrar**.

> Tu menú lateral muestra solo los módulos de tu rol. Si tienes más de un rol, puedes cambiar entre ellos con el selector que aparece arriba del menú.

> **¿Entras con una cuenta de demostración?** Tu espacio empieza **vacío**: como Docente, **crea tu propio curso** para arrancar y usa la IA para generar exámenes y talleres. La matrícula de estudiantes la hace un administrador, así que el ciclo completo de calificación con entregas reales se ve en los videos demo, no en esta cuenta. Tu cuenta trae **dos roles: Docente y Estudiante** — cambia con el selector arriba del menú para ver también la vista del alumno.
>
> Si la **IA falla** en algún momento, lo más probable es que sea **disponibilidad del modelo** (es un entorno de demostración) — espera unos minutos y reintenta. No es un error de la plataforma.

---

## En el celular (app móvil sin tienda) — ExamLab es una PWA

ExamLab es una **PWA (Progressive Web App)**: la **misma página web funciona como una app** en tu celular, **sin descargar nada de Play Store ni App Store**. Entras por el navegador y, si quieres, la **instalas en la pantalla de inicio** para abrirla con un toque como cualquier otra app.

**Cómo instalarla:**

- **Android (Chrome):** abre **https://examlab.lovable.app**, toca el menú **⋮** y elige **"Instalar app"** / **"Agregar a pantalla de inicio"**. (A veces aparece solo un aviso para instalar.)
- **iPhone / iPad (Safari):** abre la página, toca **Compartir** (el cuadro con la flecha ↑) y elige **"Añadir a pantalla de inicio"**.

**Qué ganas al usarla en el celular / instalada:**

- **Pantalla completa**, sin la barra del navegador — se ve y se siente como una app nativa.
- **Orientación vertical fija**: la app se mantiene en **vertical** aunque el teléfono gire, para que la lectura y los formularios no se descuadren.
- **Notificaciones push**: recibes avisos (exámenes, calificaciones, mensajes, etc.) aunque no tengas la pestaña abierta — según tus preferencias en **Notificaciones**.
- **Soporte offline al presentar exámenes**: si la conexión falla mientras respondes un examen, tus respuestas se **guardan en el dispositivo** y se **sincronizan solas** cuando vuelve internet — no pierdes lo escrito.
- **Siempre actualizada**: como es web, no hay que actualizar desde una tienda; al recargar ya tienes la última versión.

> No necesitas un dispositivo potente: todo corre en la nube. Funciona en celulares y tablets modernos (Android y iOS) con un navegador al día.

---

## Demostración

- Recorrido general (todos los roles): `docs/demos/presentacion/output/modulo-overview.mp4`
- Clip corto (redes / WhatsApp): `docs/demos/social/output/modulo-social.mp4`
- Cómo ingresar (video corto): `docs/demos/social/output/modulo-login.mp4`
- Presentaciones: `docs/demos/presentacion/ExamLab-Presentacion-General.pptx` (general) y `ExamLab-Presentacion-Comercial.pptx` (planes).

> Las rutas de arriba son la **ubicación en el repositorio**, no enlaces abribles desde este documento. Para compartir el manual con alguien externo, entrégale los videos y presentaciones por correo o carpeta compartida (o reemplaza las rutas por enlaces de Drive/YouTube).

Los pantallazos de este manual están en `docs/demos/manual/screenshots/<rol>/`.

# HeyGen — Script Admin

**Duración objetivo**: 75–90 segundos
**Tono**: cordial, profesional, conciso
**Idioma**: español neutro (es-CO)
**Avatar recomendado en HeyGen**: avatar formal, fondo neutro

---

## Configuración HeyGen sugerida

- **Voice speed**: 1.0× (natural)
- **Pause between paragraphs**: 0.5s
- **Background music**: instrumental suave al 10% del volumen
- **Captions**: encender (es-CO)

---

## Script (pegar directo en HeyGen)

> ¡Bienvenido a ExamLab! Soy tu guía y voy a mostrarte en menos de un minuto y medio cómo administrar tu institución.
>
> Como Administrador, tu trabajo central es **gestionar usuarios y cursos**. En el menú **Usuarios** podés crear cuentas una a una o importar un CSV con cientos de estudiantes a la vez. Cada usuario recibe una contraseña temporal y la cambia en su primer login.
>
> En **Cursos** definís el ciclo lectivo, los docentes principales, los cortes con sus pesos, y matriculás a los alumnos. Los cortes determinan cómo se calcula la nota final del curso.
>
> En **Académico** configurás los programas, periodos y asignaturas de tu institución. Esto se reutiliza cada vez que se crea un curso nuevo.
>
> Si querés controlar cómo la inteligencia artificial califica las entregas, abrí **Prompts IA**. Ajustás los criterios y la institución entera los usa.
>
> Para que nada se pierda, todo lo que se elimina pasa por la **Papelera** y queda recuperable durante treinta días. Si fue un error, se restaura con un click.
>
> Cuando algo no funcione como esperás, revisá **Errores** y **Auditoría**: ahí tenés un historial completo de lo que pasó y quién hizo qué.
>
> Y si después de este video querés un tour interactivo dentro de la plataforma, abrí el menú **Más opciones** abajo a la izquierda y elegí **Ver tour guiado**.
>
> ¡Listo! Ya tenés todo lo necesario para arrancar. ¡Mucho éxito gestionando tu institución!

---

## Notas para el editor de HeyGen

- **Cortes visuales sugeridos** (cuando hagas el ensamble en HeyGen + edición):
  - Segundo 0–10: avatar full-shot, bienvenida.
  - Segundo 10–30: zoom-out con overlay del módulo **Usuarios** y **Cursos**.
  - Segundo 30–50: overlay de **Académico** y **Prompts IA**.
  - Segundo 50–75: overlay de **Papelera**, **Errores**, **Auditoría**.
  - Segundo 75–end: avatar full-shot, cierre + CTA al tour interactivo.

- **CTA final en pantalla**: "Abrí el menú → Más opciones → Ver tour guiado".

- **URL del video terminado**: pegala en `src/modules/onboarding/tour-config.ts` (campo `videoUrl` del export `ADMIN_TOUR_META`) para que el tour interactivo muestre el botón "Ver video introductorio" en el primer paso.

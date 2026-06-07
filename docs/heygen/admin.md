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
> En **Académico** configurás los programas, periodos y asignaturas de tu institución. Esto se reutiliza cada vez que se crea un curso nuevo. Y en **Certificados** definís las plantillas que reciben los alumnos al cerrar un curso.
>
> Si querés controlar cómo la inteligencia artificial califica las entregas, abrí **Prompts IA**. Ajustás los criterios y la institución entera los usa. La **Cola IA** te muestra todos los jobs activos y fallidos para que sepas qué está corriendo.
>
> **Estadísticas** te da el panorama completo: aprobación por curso, asistencia, tendencias. Click en cualquier curso para entrar al detalle.
>
> Cuando algo no salga como esperás, revisá **Auditoría**: tenés un historial completo de lo que pasó, quién lo hizo y por qué falló — incluye los errores agrupados por causa.
>
> ¿Necesitás ayuda del dueño de la plataforma? Abrí **Soporte** y enviá un ticket con categoría, prioridad y adjuntos. La conversación queda persistida con notificaciones automáticas.
>
> Y todo lo que se elimina pasa por **Papelera**: recuperable durante treinta días con un click. Sin sorpresas.
>
> En **Configuración** centralizás los toggles de la institución: correos transaccionales, módulos visibles, modelo IA, compilador de código. Cada cambio queda auditado.
>
> Para profundizar, abrí el menú **Más opciones** abajo a la izquierda y elegí **Ver tour guiado**. ¡Mucho éxito gestionando tu institución!

---

## Notas para el editor de HeyGen

- **Cortes visuales sugeridos** (cuando hagas el ensamble en HeyGen + edición):
  - Segundo 0–10: avatar full-shot, bienvenida.
  - Segundo 10–25: overlay de **Usuarios** + **Cursos**.
  - Segundo 25–40: overlay de **Académico** + **Certificados**.
  - Segundo 40–55: overlay de **Prompts IA** + **Cola IA** + **Estadísticas**.
  - Segundo 55–70: overlay de **Auditoría** + **Soporte** (con ticket abierto).
  - Segundo 70–85: overlay de **Papelera** + **Configuración**.
  - Segundo 85–end: avatar full-shot, cierre + CTA al tour interactivo.

- **CTA final en pantalla**: "Abrí el menú → Más opciones → Ver tour guiado".

- **URL del video terminado**: pegala en `src/modules/onboarding/tour-config.ts` (campo `videoUrl` del export `ADMIN_TOUR_META`) para que el tour interactivo muestre el botón "Ver video introductorio" en el primer paso.

- **Scenes grabadas** (record-tour.ts → role=admin, 12 scenes ~80s):
  Dashboard → Usuarios → Cursos → Académico → Certificados → Prompts IA → Cola IA → Estadísticas → Auditoría → Soporte → Papelera → Configuración.

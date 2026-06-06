# HeyGen — Script Docente

**Duración objetivo**: 90–110 segundos
**Tono**: cercano, didáctico, motivador
**Idioma**: español neutro (es-CO)
**Avatar recomendado en HeyGen**: avatar amigable, fondo de aula virtual

---

## Configuración HeyGen sugerida

- **Voice speed**: 1.0× (natural)
- **Pause between paragraphs**: 0.5s
- **Background music**: instrumental suave al 10% del volumen
- **Captions**: encender (es-CO)

---

## Script (pegar directo en HeyGen)

> ¡Hola, profe! Bienvenido a ExamLab. En el próximo minuto y medio te muestro cómo armar tu clase y evaluarla con ayuda de inteligencia artificial.
>
> Tu punto de partida es **Mis Cursos**. Ahí ves los cursos que dictás y entrás al tablero de cada uno: contenidos, asistencia, calificaciones y comunicación con tus alumnos, todo en un solo lugar.
>
> Para construir tus evaluaciones tenés tres herramientas: **Exámenes**, **Talleres** y **Proyectos**. Cada una se crea desde su módulo: definís el corte, la fecha límite, y agregás preguntas a mano o importadas del **Banco de preguntas**. La IA califica automáticamente las preguntas abiertas y de código.
>
> En **Asistencia** podés crear sesiones una por una, programarlas a partir de una fecha de inicio y días de la semana, o importar tu cronograma desde una planilla. Durante la clase activás el check-in con un código QR rotativo: los estudiantes lo escanean con el celular y quedan marcados como presentes.
>
> Si querés enseñar visualmente, abrí una **Pizarra**. Soporta varias hojas, librerías de diagramas predefinidos —flowchart, UML, estructuras de datos— y modo compartido para que tus alumnos colaboren en vivo.
>
> Para tomar el pulso de la clase, usá **Encuestas**: opción única, múltiple, o tipo Doodle con cupos por opción cuando necesitás agendar sustentaciones.
>
> Y si borraste algo por error, abrí la **Papelera** y restauralo con un click. Tenés treinta días.
>
> Listo. Para profundizar en cada módulo, abrí el menú **Más opciones** y elegí **Ver tour guiado**. Te lleva paso a paso por cada sección.
>
> ¡Mucho éxito armando tu curso!

---

## Notas para el editor de HeyGen

- **Cortes visuales sugeridos**:
  - Segundo 0–10: avatar full-shot, bienvenida.
  - Segundo 10–25: overlay de **Mis cursos**.
  - Segundo 25–45: overlay de **Exámenes**, **Talleres**, **Proyectos** rotando con animación.
  - Segundo 45–65: overlay de **Asistencia** + animación del QR rotativo.
  - Segundo 65–80: overlay de **Pizarra** (mostrando libraries) + **Encuestas**.
  - Segundo 80–95: overlay de **Papelera**.
  - Segundo 95–end: avatar full-shot, cierre + CTA al tour interactivo.

- **CTA final en pantalla**: "Abrí el menú → Más opciones → Ver tour guiado".

- **URL del video terminado**: pegala en `src/modules/onboarding/tour-config.ts` (campo `videoUrl` del export `TEACHER_TOUR_META`) para que el tour interactivo muestre el botón "Ver video introductorio" en el primer paso.

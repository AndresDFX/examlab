# HeyGen — Script Estudiante

**Duración objetivo**: 75–90 segundos
**Tono**: cercano, joven, motivador
**Idioma**: español neutro (es-CO)
**Avatar recomendado en HeyGen**: avatar juvenil, fondo de campus

---

## Configuración HeyGen sugerida

- **Voice speed**: 1.0× (natural)
- **Pause between paragraphs**: 0.5s
- **Background music**: instrumental upbeat al 15% del volumen
- **Captions**: encender (es-CO)

---

## Script (pegar directo en HeyGen)

> ¡Hola! Bienvenido a ExamLab. En menos de un minuto y medio te muestro cómo usar la plataforma para tus clases.
>
> Tu **Dashboard** es la primera cosa que vas a ver: ahí aparecen los exámenes y talleres que tenés pendientes, las próximas clases, y todo lo que está por vencer.
>
> En **Mis cursos** entrás a cada uno y ves su tablero: contenidos por sesión, calificaciones, asistencia y foro.
>
> Cuando te toque rendir un **examen**, click en "Comenzar" dentro de la ventana de tiempo, respondé las preguntas y entregá. La inteligencia artificial califica al instante las respuestas abiertas y el código.
>
> Para los **talleres** y **proyectos**, vas a encontrar las consignas con su fecha límite, podés trabajar en grupo si el docente lo activa, y subís archivos, código o el link a tu repo.
>
> En **Calificaciones** ves tu boletín por corte y curso, con la nota proyectada actualizada en vivo según tus entregas.
>
> ¿Cómo registrás tu **asistencia**? Cuando el profe abra el check-in en clase, escaneás un código QR con la cámara del celular o tipeás el código de seis dígitos. Listo.
>
> En **Contenidos** acedés a las clases del curso — presentaciones, lecturas, material de apoyo, organizado por sesión.
>
> En **Encuestas** votás cuando el profe pide tu opinión o elegís fecha de sustentación tipo Doodle.
>
> Si el profe activa **Pizarra compartida**, podés colaborar en vivo desde tu equipo — diagramas, anotaciones, ejercicios en tiempo real.
>
> Tu **Calendario** consolida todo lo importante: exámenes, talleres, clases, en una sola vista. La **Biblioteca de videos** guarda las grabaciones de clases para que puedas repasarlas.
>
> Si tenés dudas sobre un tema, el **Tutor IA** te explica con contexto del curso. Es como un compañero que estudió la materia con vos.
>
> En **Retroalimentación** ves los comentarios que dejó el docente sobre tus entregas. Y en **Certificados** descargás los certificados de los cursos que completaste.
>
> Para ver todo esto paso a paso, abrí el menú **Más opciones** y elegí **Ver tour guiado**.
>
> ¡Éxitos en el semestre!

---

## Notas para el editor de HeyGen

- **Cortes visuales sugeridos**:
  - Segundo 0–8: avatar full-shot, bienvenida.
  - Segundo 8–18: overlay del **Dashboard** y **Mis cursos**.
  - Segundo 18–35: overlay rotando entre **Exámenes**, **Talleres**, **Proyectos**.
  - Segundo 35–48: overlay de **Calificaciones**, **Asistencia** + animación del QR.
  - Segundo 48–60: overlay de **Contenidos**, **Encuestas**, **Pizarra compartida**.
  - Segundo 60–75: overlay de **Calendario**, **Biblioteca de videos**, **Tutor IA**.
  - Segundo 75–85: overlay de **Retroalimentación** y **Certificados**.
  - Segundo 85–end: avatar full-shot, cierre + CTA al tour interactivo.

- **CTA final en pantalla**: "Abrí el menú → Más opciones → Ver tour guiado".

- **URL del video terminado**: pegala en `src/modules/onboarding/tour-config.ts` (campo `videoUrl` del export `STUDENT_TOUR_META`) para que el tour interactivo muestre el botón "Ver video introductorio" en el primer paso.

- **Scenes grabadas** (record-tour.ts → role=student, 15 scenes ~90s):
  Dashboard → Mis cursos → Exámenes → Talleres → Proyectos → Calificaciones → Asistencia → Contenidos → Encuestas → Pizarras compartidas → Calendario → Biblioteca de videos → Tutor IA → Retroalimentación → Certificados.

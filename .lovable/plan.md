
## Contexto

Tras revisar `src/components/WorkshopQuestions.tsx`, `src/routes/app.student.workshops.tsx`, `src/routes/app.teacher.workshops.tsx` y el hook `src/hooks/use-auth.ts` detecté lo siguiente:

- El `StudentWorkshopTaker` renderiza un `<h3>{workshopTitle}</h3>` además del `DialogTitle` del modal → título duplicado.
- El botón del listado usa la clave global `t("exam.start")` ("Iniciar examen") incluso para talleres.
- El botón de envío dice **"Enviar y calificar inmediatamente"**.
- La tarjeta de resultado muestra el texto pedido a cambiar.
- El `useEffect([workshopId, user])` del Taker se vuelve a disparar cuando Supabase emite `TOKEN_REFRESHED`/`SIGNED_IN` al volver al navegador → recarga las preguntas y "reinicia" el modal.
- El contenido de las preguntas (`q.content`) se pinta como texto plano: lo que la IA devuelve con `**Java**` se muestra literal en vez de en negrilla.
- En `app.teacher.workshops.tsx` la calificación funciona a nivel de **submission completa** (un `final_grade` y un `teacher_feedback`). No expone las respuestas por pregunta ni las calificaciones IA por pregunta que se guardan en `workshop_submission_answers`.

## Cambios propuestos

### 1) Estudiante – modal de entrega (`src/components/WorkshopQuestions.tsx` y `src/routes/app.student.workshops.tsx`)

- **Quitar el título duplicado**: eliminar el `<h3>{workshopTitle}</h3>` interno de `StudentWorkshopTaker` (el `DialogTitle` ya lo muestra).
- **Botón del listado**: en `app.student.workshops.tsx` reemplazar `t("exam.start")` por una nueva clave `t("workshop.startSubmission")` ("Iniciar entrega" / "Start submission") manteniendo `t("common.update")` para reentrega.
- **Botón de envío**: cambiar `"Enviar y calificar inmediatamente"` por simplemente `"Entregar"` (clave `workshop.submit`).
- **Mensaje del resultado**: cambiar el texto a:
  > "La calificación fue generada automáticamente por IA al enviar el taller. Si necesita una revisión manual, contacte a su docente."
  (clave `workshop.aiGradedNotice`).
- **Renderizar negrillas Markdown del enunciado**: agregar la dependencia `react-markdown` y usarla SOLO para `q.content` dentro del Taker (con un set mínimo de elementos: `strong`, `em`, `code`, `p`, `ul`, `ol`, `li`). Así `**Java**` se ve en negrilla y se evita HTML inseguro. (Es la opción más limpia y evita reescribir la generación IA.)
- **Evitar la "recarga" al volver al navegador**: añadir un `loadedRef` (o flag `loadedFor === workshopId`) en el Taker para que el `useEffect` solo cargue las preguntas la primera vez por `workshopId`, no en cada cambio de `user` (los eventos `TOKEN_REFRESHED` de Supabase mutan la referencia de `user` y disparan el efecto). Las respuestas en memoria (`answers`) ya no se sobreescriben mientras el alumno escribe.

### 2) Estudiante – i18n

Agregar a `es.json` y `en.json` bajo un nuevo namespace `workshop`:

```json
"workshop": {
  "startSubmission": "Iniciar entrega",
  "submit": "Entregar",
  "submitting": "Entregando…",
  "aiGradedNotice": "La calificación fue generada automáticamente por IA al enviar el taller. Si necesita una revisión manual, contacte a su docente."
}
```
(equivalentes en inglés)

### 3) Docente – calificar respuesta por respuesta (`src/routes/app.teacher.workshops.tsx`)

Reestructurar el modal de "Calificaciones" del taller:

- Al abrirlo, además de cargar `workshop_submissions`, traer también `workshop_questions` del taller y `workshop_submission_answers` por cada submission.
- Para cada entrega, mostrar (debajo del header del estudiante) un acordeón por pregunta con:
  - Enunciado de la pregunta (con `react-markdown`).
  - Respuesta del estudiante en el formato adecuado (texto / opción seleccionada / código en monoespaciado / Mermaid como texto).
  - Inputs editables para `ai_grade` (numérico, con `max = q.points`) y `ai_feedback` (textarea).
  - Botón "Guardar pregunta" que hace `update` en `workshop_submission_answers` y, al confirmarse, **recalcula la nota global de la entrega** (suma `ai_grade` ponderada a `max_score`) y la persiste en `workshop_submissions.final_grade` + `teacher_feedback` agregado.
  - Mantener "Recalificar con IA" por pregunta (reusa `ai-grade-submission` con `workshopQuestionGrading: true`).
- Conservar los inputs globales actuales de **Nota final** y **Retroalimentación** (el docente puede sobrescribir el cálculo automático).
- Añadir botón **"Recalcular nota global"** que toma la suma de `ai_grade` por pregunta y la escribe en `final_grade` para confirmar el cambio.
- Mantener el flujo de "Calificar todo con IA" / aprobar / rechazar a nivel global ya existentes.

Helper nuevo en el archivo (no hace falta archivo nuevo):
```ts
function recomputeFinalGrade(answers, questions, maxScore) {
  const totalPoints = questions.reduce((s, q) => s + Number(q.points || 0), 0);
  const earned = answers.reduce((s, a) => s + Number(a.ai_grade || 0), 0);
  return totalPoints > 0
    ? Number(((earned / totalPoints) * Number(maxScore)).toFixed(2))
    : 0;
}
```

### 4) Dependencia nueva

`bun add react-markdown` (uso aislado, solo para enunciados y para la respuesta de tipo "abierta" en la vista docente). No se añade `remark-gfm` para mantenerlo ligero — `**bold**`, `*italic*`, `` `code` `` y listas funcionan con el parser por defecto.

## Archivos a tocar

- `src/components/WorkshopQuestions.tsx` — quitar título duplicado, cambiar botón a "Entregar", evitar reload al refocus, usar `react-markdown` en enunciados, actualizar texto de la tarjeta de resultado.
- `src/routes/app.student.workshops.tsx` — usar `t("workshop.startSubmission")`.
- `src/routes/app.teacher.workshops.tsx` — modal de calificación con respuestas por pregunta editables y recálculo automático.
- `src/i18n/locales/es.json` y `src/i18n/locales/en.json` — nuevas claves bajo `workshop`.
- `package.json` — `react-markdown`.

## Fuera de alcance

- No se toca el flujo de exámenes ni `t("exam.start")` (sigue significando "Iniciar examen").
- No se modifican esquemas de DB ni RLS (la tabla `workshop_submission_answers` ya tiene políticas de UPDATE para Docentes/Admins).
- No se altera la edge function `ai-grade-submission`.

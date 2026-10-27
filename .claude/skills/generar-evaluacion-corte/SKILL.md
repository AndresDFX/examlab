---
name: generar-evaluacion-corte
description: >
  Arma el taller o el parcial de un corte a partir de lo que REALMENTE se le presentó al curso:
  cruza las transcripciones de clase (solo lo que dijo el docente), el material del tablero, las
  pizarras (incluido el texto escrito en los dibujos, el código, el SQL y los diagramas) y los
  snippets de cada sesión, lo compara con la evaluación del corte anterior (qué se evaluó y cómo
  le fue al curso pregunta por pregunta) y valida el plan con el docente antes de generar.
  Pregunta de forma interactiva temas, fechas y cantidad; dificultad básica por defecto. Crea
  todo en borrador. Úsalo cuando el usuario pida «genera el taller del corte N», «arma el parcial
  2 con los temas X», «preguntas posibles de lo que se ha visto» o «taller de corte de las clases
  del X al Y».
---

# Generar la evaluación de un corte

El objetivo es que cada pregunta salga de algo que el curso **vio**: una frase de la clase, un
ejemplo de la pizarra, un archivo del tablero. Una pregunta sobre algo que no se presentó es
injusta y genera reclamos. Todo lo redacto yo (no la IA de la plataforma: ver la memoria
`no-usar-ia-plataforma-para-contenido`), leyendo la base con la credencial de solo lectura.

## 1. Preguntar primero (AskUserQuestion, una sola ronda)

- **Curso(s)** y **tipo**: taller o parcial. Varios cursos de la misma asignatura → una
  evaluación por curso, salvo que pida compartirla.
- **Corte** y **ventana**: por fechas («clases del 28-sep al 25-oct») o por temas. Por defecto,
  las fechas del corte en `grade_cuts`.
- **Fechas de la actividad**: inicio y cierre (taller) o día y hora (parcial). Proponer la clase
  siguiente del calendario del curso; **si el día de la semana no coincide con la fecha, manda
  el día** (memoria `dia-de-la-semana-manda`) y se dice en una línea.
- **Cantidad y mezcla**: por defecto la del corte anterior (lo dice el dossier).
- **Dificultad: básica por defecto.** Solo cambia si el docente la pide.
- **Peso y corte**: por defecto los del mismo tipo en el corte anterior.

Lo que ya se sabe por la base no se pregunta: se propone.

## 2. Recolectar (solo lectura)

```bash
node .claude/skills/generar-evaluacion-corte/recolectar.mjs \
  --curso <uuid> --desde YYYY-MM-DD --hasta YYYY-MM-DD --corte-anterior <cut_uuid>
```

Deja `privado/evaluaciones/dossier-<código>-<ventana>.md` (está en `.gitignore`: hay
transcripciones y el repo es público). Trae, por sesión: lo que dijo el docente
(`teacher_text`, **nunca** `content_text`), el material amarrado, los snippets y el texto de la
pizarra; después las pizarras del curso tocadas en la ventana (hojas de texto, código con su
salida, SQL, Mermaid y el texto escrito en los dibujos) y el material suelto cuyo nombre nombra
una clase de la ventana. Con `--corte-anterior`: cada examen con el **% de acierto por pregunta**
(de `answers.__breakdown`) y las preguntas de cada taller.

Huecos que el script avisa y hay que cubrir a mano:

- **Dibujos a mano alzada e imágenes pegadas** no son texto («[además: N trazos…]»). Si la
  sesión depende de eso, abrir la pizarra como imagen o preguntar.
- **Material sin texto en línea** (Office/PDF): leerlo del submódulo
  `universidades/<UNI>/<Asignatura>/` o de Drive, que es la versión vigente (memoria
  `material-drive-vs-submodulo-desfase`). Solo leer: nunca editar el submódulo desde acá.
- **Sesión sin transcripción**: avisarlo; esa clase se cubre solo con material y pizarra.
- Una sesión que fue **solo evaluación** (p. ej. «Parcial 2») no aporta temas nuevos.

## 3. Validar con el docente ANTES de generar

Una tabla corta, y esperar confirmación:

| Tema | Clase(s) donde se vio | Evidencia (transcripción / pizarra / material) | Preguntas | Tipo |
|---|---|---|---|---|

Más tres líneas: **qué se evaluó en el corte anterior y no se repite** (salvo lo que salió por
debajo de ~60 % de acierto, que vale reforzar con otra forma), **qué se vio y queda fuera** y
por qué, y la dificultad. Si un tema que el docente pidió no tiene evidencia en la ventana, se
dice: no se inventa.

## 4. Generar

- **Solo lo que la plataforma califica** (memoria `preguntas-solo-lo-evaluable`): `cerrada`,
  `cerrada_multi`, `abierta` con rúbrica, `codigo` con lenguaje y plantilla, `bd_sql` con
  `CREATE TABLE` en el esquema. Nada de «entregue un documento».
- **Dificultad básica**: reconocer, explicar con sus palabras, completar o seguir un ejemplo
  muy parecido al de clase. Los distractores son confusiones reales del tema, no trampas.
- **Anclada**: cada pregunta lleva, solo en la propuesta para el docente (no en el enunciado),
  de qué clase y fuente sale. Reusar los ejemplos de la pizarra con otros datos.
- Español de Colombia, de usted, enunciados autocontenidos (el estudiante no ve la pizarra).
- `cerrada`: 4 opciones, una correcta en `correct_index`; revisar que la clave sea utilizable
  (lo mismo que verifica `QuestionOptionsPreview`).

## 5. Crear en la plataforma (en borrador)

Mostrar las preguntas completas y pedir el visto bueno. Después, con el JWT del SuperAdmin por
REST (memoria `carga-masiva-desde-esta-maquina`):

- Examen: fila en `exams` (`status='draft'`, `cut_id`, `weight`, fechas en UTC desde la hora de
  Bogotá) + `questions`.
- Taller: `workshops` (`status='draft'`) + su fila en `workshop_courses` con corte y peso +
  `workshop_questions`.
- **No publicar ni asignar** sin que lo pida: publicar no asigna y asignar un examen avisa
  aunque esté en borrador (memorias `uniaj-actividades-publicadas-sin-asignar` y
  `asignar-examen-notifica-aunque-sea-borrador`).

Cerrar con: lo creado (título, fechas en hora de Bogotá con día de la semana, peso), el enlace
del grid y lo que queda pendiente (publicar, asignar, avisar con `aviso-a-estudiantes`).

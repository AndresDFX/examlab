---
name: notas-a-uniajc
description: >
  Pasa la nota de un corte de ExamLab a la plataforma académica de la UNIAJC (Campus TI →
  Académico Docente → Academusoft «Ingresar Calificaciones») manejando el navegador, y lo hace
  DESPUÉS de dejar ExamLab ajustado: cola de IA vacía, puntajes mal registrados corregidos,
  reclamos respondidos y la regla de asistencia aplicada. Termina verificando grupo por grupo
  que cada estudiante quedó con su nota en la universidad. Úsalo cuando el usuario pida «pasa
  las notas a la universidad», «sube el corte N a la plataforma de la universidad», «registra
  las notas en Academusoft» o «corrige las notas y pásalas».
---

# Notas de ExamLab a la plataforma de la UNIAJC

Lo que importa es el resultado: **cada estudiante termina con su nota del corte registrada en
la universidad, y es la misma que ve en ExamLab** (con un decimal). La guía del docente
(`Guia Notas UNIAJ.docx`) es solo el punto de partida; el procedimiento vive acá.

El orden no se negocia: **primero ExamLab, después la universidad.** Una nota copiada antes
de tiempo queda vieja en la universidad y nadie avisa. Pasó en el Corte 1 de 2026-2: la copia
se tomó el 7 de octubre con reintentos todavía sin calificar, y a un estudiante le quedó 1,1
de aporte cuando le correspondía 1,34.

## 1. Ajustar ExamLab (todo antes de leer una sola nota)

Solo lectura con `scripts/db-query.mjs`. Las escrituras van con el JWT del SuperAdmin
(`C:/Temp/api.mjs`, ver la skill `calificar-parcial`), nunca con la `service_role`.

- **Cola de calificación** (`ai_grading_queue` en pending/processing/failed). UNIAJ está en
  modo asíncrono: la cola no drena sola. Antes de procesar, mirar cada trabajo. **Si su
  entrega ya tiene nota, se CANCELA (`cancel_ai_grading_job`), no se procesa**: el procesador
  solo se salta los talleres calificados, y a un examen ya calificado lo vuelve a calificar
  encima. Los que no tienen nota se procesan de a uno: `POST /functions/v1/ai-grading-worker`
  con `{ jobId }`. Al final la cola tiene que quedar vacía.
- **Entregas sin nota que no están en la cola** (trabajo cancelado o fallido): barrer los
  cursos con la definición de entregado de `entrega-hecha.ts`. Ninguna puede quedar así.
- **Puntaje registrado como fracción.** A veces la IA analiza bien («7 de 22») pero escribe
  la fracción (0,318) en `earned`. Buscar en `answers.__breakdown` filas con `points ≥ 2` y
  `0 < earned < 1`, y también `earned = 1` en preguntas de varios puntos (la respuesta
  perfecta guardada como «1.0»). Corregir `earned` y recalcular `ai_grade`
  (`Σearned/Σpoints × escala`, mitad hacia arriba). Agregar a la retroalimentación una línea
  que diga qué se corrigió. Los 0,5 de 2 de Bases de Datos II son parciales legítimos.
- **Reclamos** (`feedback_threads` abiertos con la última palabra del estudiante). Revisar la
  respuesta contra la rúbrica y comparar con cómo se calificó al resto en esa pregunta. Si
  tiene razón, corregir la nota. Responder en el hilo **como el docente** (entrando con
  `admin-impersonate`) y cerrarlo: insertar el comentario con `author_role: "teacher"`,
  `notify_feedback_event` (`comment`), cerrar el hilo y `notify_feedback_event` (`closed`).
  Tuteo, «Hola <nombre>», sin tecnicismos y diciendo la nota final. Que el hilo quede
  abierto no basta: el estudiante sigue esperando.
- **Sin ninguna asistencia en el corte ⇒ el corte es 0** (decisión del docente,
  2026-10-12). Si una de esas personas tiene nota, casi siempre es una nota de GRUPO o de
  EXPOSICIÓN que se le cargó sin estar: ponerla en 0 con la observación «No presentó la
  exposición: no registra asistencia a clase en el corte.». **Excepción, decidida el mismo
  día:** quien tiene trabajo PROPIO en línea (un examen o taller que entregó él) conserva su
  nota de ExamLab, porque ahí la asistencia ya le cuenta 0. Ante un caso nuevo de ese tipo,
  preguntar.
- **Entregas reabiertas que nadie volvió a entregar.** Una entrega `en_progreso` sin
  `submitted_at` pero con un `integrity.grade_changed` de nota → null (fue reabierta) cuenta
  0. Si el estudiante pregunta, explicar la historia (auditoría) y ofrecer devolverle la nota
  que tenía: status `calificado`, la `final_grade` y el `submitted_at` originales, más una
  observación visible.

Después de ajustar, releer: la cola vacía, ninguna entrega sin nota y ningún reclamo abierto
con la última palabra del estudiante.

## 2. Leer las notas del libro → CSV

```bash
node .claude/skills/notas-a-uniajc/leer-libro.cjs "C:/Users/Andre/Downloads/Notas-Corte<N>-<periodo>" --corte=<N>
```

Lee la PANTALLA del libro de calificaciones (el mismo cálculo que ve el docente), no una
consulta propia, y escribe un CSV por curso: `Estudiante;Documento;Correo;Corte N;Aporte`.
Entra como SuperAdmin; el libro está apagado para ese rol en el panel de Módulos, y el script
lo habilita **solo en la respuesta que recibe su navegador**, nunca en la base.

## 3. Pasar a la universidad: en seco, revisar, registrar

```bash
# En seco: entra a cada grupo, cruza por documento y muestra qué escribiría.
node .claude/skills/notas-a-uniajc/pasar-notas.cjs "<carpeta-csv>" --corte=<N>
# Revisado el plan, se registra; verifica solo, reabriendo cada grupo en una sesión nueva.
node .claude/skills/notas-a-uniajc/pasar-notas.cjs "<carpeta-csv>" --corte=<N> --registrar
```

`--solo=<grupo>` corre un solo curso. Conviene registrar primero UNO, mirar su verificación
y recién después el resto. **Correr un grupo a la vez**: dos sesiones del portal con la misma
cuenta pueden pisarse.

Qué revisar en el plan en seco antes de registrar:

- El **cruce por documento** debería ser del 100 %. Un «sin nota en ExamLab» es alguien
  matriculado en la universidad que no está en la plataforma: va NP, pero hay que nombrarlo.
- «En ExamLab y NO en el portal»: no tiene dónde registrarse. Hay que decirlo (en 2026-2 fue
  Bryan Ramos en Seminario, con 0).
- Los **2,95–2,99**: el redondeo a un decimal los deja en **3.0**, que aprueba. Es la regla
  del portal, pero hay que avisarlo.

## 4. Reglas del portal (Academusoft Académico 4.0 – Docente)

- **Credenciales** en `.env.uniajc`, en la raíz del repo: `UNIAJC_USUARIO`, `UNIAJC_CLAVE`, y
  las del SuperAdmin de ExamLab `EXAMLAB_SA_EMAIL` / `EXAMLAB_SA_CLAVE`. Lo ignora `.env.*`.
  **Nunca** van en esta skill: el repo es público.
- Login dentro del marco `mainFrame` (`#loginUsuario`, `#password`, `#btn-login`).
  «Académico Docente» es una imagen: se abre con `[onclick*="abrirPopAplicacion('3'"]`, en una
  ventana aparte. El árbol está en el marco `tree.jsp`: «Calificaciones» se despliega con
  `#join_24625` y de ahí sale «Ingresar Calificaciones».
- Materia por radio `it`, grupo por radio `itGrupo` y botón `#btCon`. Después
  `#evaluacion` → `#nota`; sin elegir los dos no aparece la lista.
- **Corte 1 = «EVALUACIÓN FORMATIVA I».** El nombre de los otros cortes no se vio todavía: el
  script supone FORMATIVA II/III; la primera vez, confirmarlo en el portal y pasarlo con
  `--evaluacion=`.
- **La nota lleva UNA cifra decimal y punto** («4.5»): la caja tiene `maxlength=3` y
  `registrar()` exige punto. Redondeo con la mitad hacia arriba (4,47 → 4.5; 4,25 → 4.3).
- **Sin nota ⇒ NP («NO PRESENTO»)** en el selector de estado. El portal pone 0.0 y bloquea la
  caja solo (`bloquearNota`). Regla del docente: quien no tiene nota va con 0 y NP.
- Un grupo ya registrado trae las cajas bloqueadas: «Modificar» (`#btMod`) las habilita.
- **Nunca «bloquear el grupo»**: es irreversible y lo decide el docente.
- «Registrar» (`#btReg`) pide confirmación y responde «El proceso se realizó
  satisfactoriamente». El aviso de que no se pudo enviar el correo de notificación es normal.
  Esa confirmación solo dice que el envío no falló: **lo que prueba el registro es la
  relectura**, y por eso el script reabre el grupo.

## 5. Cuándo hay que tocar el script

`CURSOS` (en los dos scripts) es la tabla de cursos del periodo: el nombre del archivo, la
materia y el grupo en el portal, y la clave para elegir el curso en el libro. **Se actualiza
cada semestre.** El grupo del portal es el código sin el sufijo de ExamLab: `641A-2` en
ExamLab es `641A` en la universidad.

## 6. El informe al docente

Por grupo, `verificadas N/N`. Después, en una lista:

- los NP y por qué;
- quién está en un lado y no en el otro;
- los 2,9x que quedaron en 3.0;
- cada nota que se cambió en ExamLab y el motivo;
- los reclamos respondidos y su decisión.

Y los mensajes listos para los estudiantes que preguntaron.

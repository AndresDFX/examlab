---
name: notas-a-uniajc
description: >
  Pasa —y mantiene sincronizada— la nota de un corte de ExamLab en la plataforma académica de
  la UNIAJC (Campus TI → Académico Docente → Academusoft «Ingresar Calificaciones») manejando
  el navegador. Primero deja ExamLab ajustado (cola de IA, puntajes mal registrados, reclamos,
  regla de asistencia), después registra y verifica grupo por grupo; si algo del corte cambia
  más tarde en ExamLab, volver a correrla escribe SOLO lo que cambió. Sirve para cualquier
  corte. Úsalo cuando el usuario pida «pasa las notas a la universidad», «sube el corte N»,
  «sincroniza las notas», «cambió una nota del corte 1, actualízala en la universidad» o
  «corrige las notas y pásalas».
---

# Notas de ExamLab a la plataforma de la UNIAJC

Lo que importa es el resultado: **cada estudiante termina con su nota del corte registrada en
la universidad, y es la misma que ve en ExamLab** (con un decimal). La guía del docente
(`Guia Notas UNIAJ.docx`) fue solo el punto de partida.

El orden no se negocia: **primero ExamLab, después la universidad.** Una nota copiada antes
de tiempo queda vieja en la universidad y nadie avisa. Pasó en el Corte 1 de 2026-2: la copia
se tomó el 7 de octubre con reintentos sin calificar, y un estudiante quedó con 1,1 de aporte
cuando le correspondía 1,34.

## Archivos

| Archivo | Qué hace |
|---|---|
| `cursos.json` | El periodo: cursos, materia y grupo en el portal, evaluación de cada corte. **Se actualiza cada semestre.** |
| `revisar-corte.cjs` | Solo lectura: lo que hay que resolver en ExamLab antes de leer notas. |
| `leer-libro.cjs` | Lee el corte del libro de calificaciones → un CSV por curso. |
| `pasar-notas.cjs` | Compara el portal con los CSV; en seco muestra las diferencias, con `--registrar` las escribe y verifica. |
| `informe-corte.py` | Informe de notas en Word con la marca de la UNIAJC. |
| `comun.cjs` | Configuración, credenciales, carpeta del corte y redondeo del portal. |

**Credenciales** en `.env.uniajc` (raíz del repo, ignorado por `.env.*`): `UNIAJC_USUARIO`,
`UNIAJC_CLAVE` (portal) y `EXAMLAB_SA_EMAIL`, `EXAMLAB_SA_CLAVE` (SuperAdmin de ExamLab para
leer el libro). **Nunca** van en esta carpeta: el repo es público.

**Datos de cada corte** en `privado/notas-<periodo>/corte<N>/` (ignorado por git, porque
llevan nombre, documento y nota):

- los CSV de `leer-libro.cjs`;
- `observaciones.json` y `ajustes.json` del informe;
- `registro-corte<N>.jsonl`: constancia de cada nota escrita en el portal (cuándo, antes y
  después);
- el informe en Word.

## A. Registrar un corte por primera vez

```bash
node .claude/skills/notas-a-uniajc/revisar-corte.cjs --corte=N   # 1. qué falta en ExamLab
#   ... resolver lo que diga (sección C) y volver a correrlo hasta que no haya nada bloqueante
node .claude/skills/notas-a-uniajc/leer-libro.cjs --corte=N      # 2. CSV del libro
node .claude/skills/notas-a-uniajc/pasar-notas.cjs --corte=N     # 3. en seco: revisar el plan
node .claude/skills/notas-a-uniajc/pasar-notas.cjs --corte=N --solo=<grupo> --registrar   # 4. uno primero
node .claude/skills/notas-a-uniajc/pasar-notas.cjs --corte=N --registrar                  #    y el resto
python .claude/skills/notas-a-uniajc/informe-corte.py --corte N  # 5. informe (sección E)
```

Correr **un grupo a la vez**: dos sesiones del portal con la misma cuenta pueden pisarse.
`--detalle` muestra todas las filas, no solo las que cambian.

Antes de registrar, revisar en el plan en seco:

- El **cruce por documento** debería ser del 100 %. «En el portal y sin nota en ExamLab» es
  alguien matriculado en la universidad que no está en la plataforma: va con NP, pero hay que
  nombrarlo.
- «En ExamLab y NO en el portal»: no tiene dónde registrarse. Hay que decirlo (en 2026-2 pasó
  con un estudiante de Seminario que tenía 0).
- **Los 2,95–2,99 quedan en 3.0** con el redondeo a un decimal, y eso aprueba. Hay que
  avisarlo.

## B. Sincronizar un corte ya registrado

Cuando algo del corte cambia en ExamLab después de registrarlo (un reclamo que sube una nota,
una entrega que se califica tarde, una corrección), se repite el mismo comando:

```bash
node .claude/skills/notas-a-uniajc/revisar-corte.cjs --corte=N
node .claude/skills/notas-a-uniajc/leer-libro.cjs --corte=N
node .claude/skills/notas-a-uniajc/pasar-notas.cjs --corte=N            # muestra SOLO lo que cambió
node .claude/skills/notas-a-uniajc/pasar-notas.cjs --corte=N --registrar
```

Si en seco sale «0 por escribir» en todos los grupos, el portal ya está al día. Con
`--registrar` pasa esto:

1. Pulsa «Modificar», porque un grupo registrado trae las cajas bloqueadas.
2. Escribe **solo las filas que difieren**.
3. Registra.
4. Vuelve a abrir el grupo y compara **todas** las filas.
5. Deja constancia en `registro-corte<N>.jsonl`.

Al estudiante afectado se le avisa con la nota nueva.

## C. Ajustar ExamLab (lo que pide `revisar-corte.cjs`)

Las escrituras se hacen con el JWT del SuperAdmin (`C:/Temp/api.mjs`, ver la skill
`calificar-parcial`), nunca con la `service_role`. Lo que revisa el script, en orden:

1. **Cola de calificación.** UNIAJ está en modo asíncrono, así que la cola no drena sola.
   - **Si la entrega ya tiene nota, el trabajo se CANCELA** (`cancel_ai_grading_job`): el
     procesador solo se salta los talleres calificados, y un examen calificado lo vuelve a
     calificar encima.
   - Los demás se procesan de a uno: `POST /functions/v1/ai-grading-worker` con `{ jobId }`.
2. **Entregas del corte sin nota fuera de la cola:** ninguna puede quedar así.
3. **Puntajes con forma de fracción.** La IA a veces analiza bien («7 de 22») pero guarda
   0,318, o «1» en vez de 22.
   - Leer la respuesta contra la rúbrica.
   - Corregir `earned` y recalcular `ai_grade` (`Σearned/Σpoints × escala`, mitad hacia arriba).
   - Agregar a la retroalimentación qué se corrigió.
   - En el Corte 1 salieron dos puntajes bajos que no eran fracción (0,5 de 10 y 1 de 15).
4. **Reclamos** (hilos abiertos con la última palabra del estudiante).
   - Revisar contra la rúbrica y contra cómo se calificó al resto en esa pregunta.
   - Si tiene razón, corregir la nota.
   - Responder **como el docente** (con `admin-impersonate`): insertar el comentario con
     `author_role: "teacher"`, `notify_feedback_event` (`comment`), cerrar el hilo y
     `notify_feedback_event` (`closed`).
   - Tuteo, «Hola <nombre>», la nota final y sin tecnicismos.
5. **Sin ninguna asistencia en el corte ⇒ el corte es 0** (decisión del docente, 2026-10-12).
   - Una nota de grupo o de exposición cargada sin estar se pone en 0, con la observación «No
     presentó la exposición: no registra asistencia a clase en el corte.».
   - **Excepción:** quien tiene trabajo PROPIO en línea (examen o taller que entregó él, con
     peso) conserva su nota.
   - Ante un caso que no encaje, preguntar.
6. **Entregas reabiertas que nadie volvió a entregar.** Si el estudiante pregunta, devolverle
   la nota que tenía:
   - status `calificado`, con la `final_grade` y el `submitted_at` originales (los da la
     auditoría `integrity.grade_changed`);
   - más una observación visible.

## D. Reglas del portal (Academusoft Académico 4.0 – Docente)

**Entrar y navegar:**

- Login dentro del marco `mainFrame` (`#loginUsuario`, `#password`, `#btn-login`).
- «Académico Docente» es una imagen: se abre con `[onclick*="abrirPopAplicacion('3'"]`, en una
  ventana aparte.
- El árbol está en `tree.jsp`: `#join_24625` despliega «Calificaciones», y de ahí sale
  «Ingresar Calificaciones».
- Materia por radio `it`, grupo por radio `itGrupo` y botón `#btCon`. Después `#evaluacion` →
  `#nota`; sin elegir los dos no aparece la lista.

**Cortes y evaluaciones:**

- **Corte 1 = «EVALUACIÓN FORMATIVA I»**, confirmado. El 2026-10-12 el portal SOLO ofrecía
  esa.
- Para los cortes siguientes, `cursos.json` supone «EVALUACIÓN FORMATIVA II/III». Si el
  nombre no existe, el script se detiene y muestra las que ofrece el portal.
- Al confirmarla, agregar el corte a `evaluacionesConfirmadas` o pasar `--evaluacion=`.

**La nota:**

- Lleva **una cifra decimal y punto** («4.5»): la caja tiene `maxlength=3` y `registrar()`
  exige punto.
- **Sin nota ⇒ NP** («NO PRESENTO»). El portal pone 0.0 y bloquea la caja (`bloquearNota`).

**Grupos ya registrados:**

- Traen la caja **y** el estado bloqueados.
- **«Modificar»** (`#btMod`) habilita la caja de cada fila con nota y el estado de todas.
- Para pasar de NP a nota se deja el estado en blanco (libera la caja) y se escribe.

**Nunca:**

- **«Bloquear el grupo»**: es irreversible y lo decide el docente.

**Registrar:**

- «Registrar» (`#btReg`) pide confirmación y responde «El proceso se realizó
  satisfactoriamente».
- El aviso de que no se pudo enviar el correo de notificación es normal.
- **La prueba de que quedó es la relectura**, y por eso el script reabre el grupo.

## E. Informe y mensajes

`informe-corte.py --corte N` arma el Word con la marca de la UNIAJC. Lee:

- `observaciones.json`: `{"<archivo>|<documento>": "texto"}`, o `{"texto", "registrada": "—"}`
  para quien no figura en el listado oficial;
- `ajustes.json`: las frases de la sección de ajustes.

Los dos van en la carpeta del corte. El informe trae nombres y documentos: se entrega como
archivo, **no se publica**.

Mensajes a los estudiantes (de usted, sin vocabulario de la plataforma; ver la skill
`aviso-a-estudiantes`). Correo, en copia oculta; la lista de correos se arma de los CSV y va en
`privado/`:

```
Asunto: Notas del Corte N registradas en el sistema académico de la universidad

Buenas tardes, estudiantes.

Las notas del Corte N ya están registradas en el sistema académico de la universidad (Campus TI). Allí aparecen como «<evaluación del corte>».

Puede consultarlas aquí:
https://aplicaciones.uniajc.edu.co/uniajc/hermesoft/vortal/iniciarSesion.jsp

Tenga en cuenta:
- Es la misma nota que ve en «Mis notas» de ExamLab, registrada con un decimal: por ejemplo, 4,47 queda 4,5.
- NP significa No Presentó: en el corte no hay ninguna actividad suya registrada.

Si encuentra alguna diferencia entre las dos, escríbame en la conversación de la actividad en ExamLab o responda este correo.

Sus notas en ExamLab:
https://uniaj.examlab.workers.dev/app/student/grades
```

WhatsApp: lo mismo en cuatro líneas, con el enlace del Campus TI en su propia línea.

## F. Cada semestre

- `cursos.json`: periodo, cursos, `libro` (el texto con que se elige el curso en el libro),
  `materia` y `grupo` como aparecen en el portal. El grupo del portal va sin el sufijo de
  ExamLab: `641A-2` es `641A`.
- Volver a confirmar las evaluaciones en el portal.
- Correr `revisar-corte.cjs` y `pasar-notas.cjs` en seco: si no encuentran un curso o un grupo,
  lo dicen.

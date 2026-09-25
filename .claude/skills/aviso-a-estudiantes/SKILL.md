---
name: aviso-a-estudiantes
description: >
  Redacta el mensaje que el docente les manda a sus estudiantes por WhatsApp (o por el grupo
  del curso) para avisarles de algo que acaba de quedar abierto en la plataforma: una
  asistencia con código de check-in, un taller publicado, un parcial programado, una encuesta,
  una prueba diagnóstica. Verifica el estado REAL en la base antes de escribir y avisa si la
  plataforma NO va a notificar por su cuenta. Úsalo cuando el usuario pida «dame un mensaje
  para mis estudiantes», «un mensaje para WhatsApp», «un mensaje genérico para los cursos»
  o «avísales de esto».
---

# Aviso a estudiantes

Escribe el mensaje que el docente va a **copiar y pegar** en un grupo de WhatsApp. No es un
resumen para el docente: el lector es un estudiante de pregrado mirando el teléfono.

## Antes de escribir: verificar, no suponer

Un mensaje con una fecha equivocada o un enlace muerto cuesta más que no mandarlo, porque el
curso actúa sobre él. Consultar la base (`node scripts/db-query.mjs …`, solo lectura) y
confirmar **de la fila real**:

1. **Que esté abierto de verdad**: `status` publicado, `deleted_at` nulo, y la ventana
   (`start_date`/`due_date`, `start_time`/`end_time`) conteniendo el momento que vas a anunciar.
2. **Las fechas en hora de Bogotá**, convertidas desde UTC y **con el día de la semana
   verificado**. Si el usuario dijo «jueves 2» y el 2 cae viernes, **decirlo** — no elegir en
   silencio: son dos fechas distintas y el curso se presenta el día equivocado.
3. **Los enlaces y códigos, probados.** Un `curl -o /dev/null -w "%{http_code}"` al enlace y,
   si hay código de asistencia, recalcularlo con la función de la propia base
   (`rpc/compute_attendance_code` con `p_seed` y `p_period`) en vez de copiarlo de una nota.
4. **Si la plataforma va a avisar sola.** Leer `email_settings.enabled_kinds`: con la categoría
   en `false` no sale campanita, ni correo, ni push (ver la sección «Qué avisa la plataforma»
   de CLAUDE.md). Decírselo al docente en una línea: si está apagado, ese mensaje **es** el
   único canal y no puede omitirlo.
5. **Los requisitos que bloquean la acción.** La asistencia, por ejemplo, puede exigir el
   Acuerdo Pedagógico, la encuesta y la diagnóstica; anunciar el código sin nombrarlos genera
   una ola de «a mí no me deja».

## Cómo se escribe

- **Español de Colombia, de usted, y sin vocabulario de la plataforma.** Nunca «tenant»,
  «slug», «poll», «submission», «borrador/draft», «cut_id». Se dice institución, encuesta,
  entrega, corte.
- **Lo accionable primero**: qué tiene que hacer y para cuándo. El contexto va después.
- **Fecha completa y sin ambigüedad**: «viernes 2 de octubre a las 11:59 p. m.», no «el
  viernes» ni «2/10». Si algo tiene tiempo límite propio (un examen de 30 min desde que abre),
  decirlo, porque cambia cuándo conviene empezar.
- **El enlace y el código van SEPARADOS**, cada uno en su línea y sin texto pegado: en WhatsApp
  un código dentro de una URL se vuelve intocable y la gente lo transcribe mal.
- **Corto.** Si pasa de unas 15 líneas, sobra algo. Las listas numeradas solo para lo que el
  estudiante tiene que hacer en orden.
- **Sin emojis decorativos.** A lo sumo uno por bloque si separa secciones de un mensaje largo.
- **Nada de culpar ni amenazar.** «Si te falta la diagnóstica, míra el video y hazla» funciona;
  «los que no han hecho nada» no.

## Credenciales: cuándo sí

La contraseña genérica del curso solo se incluye cuando el docente lo pide **y** el mensaje va
a un grupo cerrado del curso. Al incluirla, decir siempre «si todavía no la has cambiado» y
recordar que el usuario es el correo institucional. Advertirle al docente, en una línea fuera
del mensaje, que no lo publique donde llegue gente ajena al curso.

## Cierre

Entregar el mensaje **listo para copiar**, en un bloque aparte del resto de la respuesta. Si
son varios cursos y solo cambian el enlace y el código, entregar **un** mensaje con esos dos
datos marcados como huecos y una tabla aparte con el valor de cada curso — no siete mensajes
casi idénticos, que es como se termina pegando el de otro curso.

Fuera del bloque, y en pocas líneas: qué verificaste, qué quedó abierto hasta cuándo, y
cualquier discrepancia que encontraste (un día de la semana que no cuadra, un requisito que
media clase no tiene).

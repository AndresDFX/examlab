# Advertencias del examen: que salir por error y volver no cuente

Estado: **plan, sin implementar** (2026-10-08).

## Qué pasa hoy

Cuando la pestaña del examen se cierra o se recarga — a propósito, por error, por un cuelgue del
navegador, por un apagón o porque el teléfono mató la app — `onBeforeUnload`
([TakeExamScreen.tsx](../../src/modules/exams/TakeExamScreen.tsx), ~línea 2185) **suma una
advertencia** y la manda al servidor con un `fetch` keepalive. Si con eso llega al tope, **cierra el
intento** («advertencias»). Tres agravantes:

1. **Es la advertencia más injusta y la menos visible.** Ese camino sube `focus_warnings` pero NO
   agrega un evento a `__warning_events`, así que el docente ve «3/3» con solo dos eventos listados
   y no puede perdonar esa en particular.
2. **Un solo gesto puede sumar varias.** Al cerrar o salir de golpe se disparan `blur`,
   `visibilitychange` y `fullscreenchange` además de `beforeunload`. `recordWarning` deduplica con una
   ventana de 500 ms y `beforeunload` solo mira si hubo un `blur` en los últimos 200 ms; según el
   navegador, el mismo accidente cuenta dos.
3. **Volver no cobra, pero salir sí.** Al reanudar ya hay período de gracia (`hasEverEnteredFullscreenRef`:
   nada suma hasta volver a pantalla completa), y la recarga automática por falta de red ocurre antes
   de que exista el intento, así que no suma. El problema es el momento de la SALIDA.

Lo que sí es incumplimiento dentro del examen, y debe seguir contando: cambiar de pestaña o de
aplicación con el examen abierto, salir de pantalla completa, pantallazo, y pegar cuando la pregunta
lo prohíbe.

## Plan

1. **Salir de la página deja de ser advertencia.** `onBeforeUnload` solo persiste las respuestas
   (keepalive) y registra una **señal blanda** `salida_de_la_pagina` (ya existe
   `registrarSenalBlanda`), con la hora. No toca `focus_warnings` ni cierra el intento.
2. **Un gesto = como mucho una advertencia.** Unificar la deduplicación de `blur` /
   `visibility_hidden` / `fullscreen_exit` en una ventana de ~1,5 s, con una función pura y testeada
   en `proctoring.ts`, en vez de las dos ventanas actuales (500 ms y 200 ms).
3. **Que el docente lo vea.** En el monitor, contar los reingresos («salió y volvió 2 veces») a partir
   de las señales blandas, separado de las advertencias. Si alguien abusa (cierra para buscar en otro
   lado), el docente lo ve y decide; el examen no lo castiga solo.
4. **Opcional por examen, apagado por defecto:** «Cerrar o recargar el examen cuenta como
   advertencia», para el docente que lo quiera estricto. Va en el formulario del examen, junto a las
   demás opciones de supervisión.
5. **Tests**: los helpers puros de deduplicación y un test que lea `TakeExamScreen.tsx` del disco y
   falle si `onBeforeUnload` vuelve a escribir `focus_warnings` (salvo con la opción del punto 4).
6. **Datos existentes**: las advertencias que ya sumó una salida no se pueden distinguir de otras
   (no dejaron evento). Las de los parciales de Corte 1 de Introducción ya se borraron el 2026-10-08.

## Decisiones para el dueño

- ¿Salir de la página no cuenta nunca, o se deja la opción por examen del punto 4?
- ¿Un tope de reingresos (p. ej. 5) que avise al docente, o solo mostrarlos?

## Archivos a tocar

`src/modules/exams/TakeExamScreen.tsx` (`onBeforeUnload`, `recordWarning`, deduplicación),
`src/modules/exams/proctoring.ts` (función pura de deduplicación), el monitor
(`app.teacher.monitor.$examId.tsx`) para los reingresos, y —solo si se aprueba el punto 4— una
migración con la columna del examen y su casilla en el formulario.

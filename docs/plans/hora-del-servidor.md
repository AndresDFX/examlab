# Hora del servidor y zona horaria de Colombia

Estado: **plan, sin implementar** (2026-10-08).

## Problema

Hay dos problemas distintos que se confunden:

1. **Reloj del dispositivo adelantado o atrasado.** Todo lo que depende del «ahora» en el navegador
   usa `Date.now()` / `new Date()` del dispositivo: el reloj del examen y si está abierto, cerrado o
   próximo (`exam-time.ts`, `use-realtime-timer.ts`), «Disponible» / «Vencido» en las listas del
   estudiante (`estaVencido`), las ventanas del check-in de asistencia y las cuentas regresivas. La
   base, en cambio, usa su propia hora (cierre automático de intentos, `exam_attempt_deadline`,
   validación del código de asistencia), así que un alumno con el reloj adelantado ve menos tiempo
   del que tiene y su examen puede entregarse solo antes de tiempo. **Solo el Reto en vivo ya lo
   corrige** (`kahoot_server_now` + `useKahootClock`, incidente FESNA jul-2026).
2. **Zona horaria del dispositivo.** `src/shared/lib/format.ts` fija el idioma (`es-CO`) pero **no la
   zona** (`timeZone`), así que las fechas se pintan en la zona del dispositivo. Los selectores de
   fecha y hora (`DateTimePicker`, `toLocalDateTimeInput`, `localToIso`, `date-range.ts`) también
   interpretan lo escrito en la zona del dispositivo.

## Plan

1. **Una sola hora del servidor para toda la app.** Generalizar `useKahootClock` a un módulo
   compartido (`src/shared/lib/hora-servidor.ts`): al iniciar sesión se pide la hora al servidor una
   vez (RPC `server_now()` genérica, o reusar `kahoot_server_now`), se calcula el desfase con el
   reloj del dispositivo y se re-mide cada tanto y al volver a la pestaña. Expone `ahora()`. Si falla,
   cae a la hora local (comportamiento de hoy).
2. **Usarla en lo que DECIDE algo** (no en los ~120 archivos que tocan fechas): primero examen
   (reloj, abierto/cerrado, entrega automática), listas del estudiante y check-in; después paneles,
   calendario y contadores.
3. **Mostrar siempre la hora de Colombia**: `timeZone: "America/Bogota"` en todos los formatos de
   `format.ts`. Idealmente la zona sale de la institución (`tenants.timezone`, por defecto Bogotá).
4. **Formularios de fecha y hora**: que lo escrito se interprete como hora de Colombia («examen a las
   2:00 pm» = 2:00 pm de Bogotá aunque el computador esté en otra zona). Es la fase más delicada:
   revisar formulario por formulario.
5. **Protección**: tests con reloj adelantado y zona distinta (p. ej. Madrid), un test que falle si
   vuelve un `Date.now()` en los módulos críticos, y un aviso discreto cuando el reloj del dispositivo
   está desfasado más de 2 minutos.

## Riesgos

- El desfase medido tiene un error de medio viaje de red (< 1 s); es suficiente.
- La fase 3 cambia lo que VE quien está fuera de Colombia (es lo buscado).
- La fase 4 cambia lo que se GUARDA: un error ahí corre las fechas de exámenes reales.
- Orden sugerido: 1 → 2 → 3 → 4 → 5. Las fases 1-3 resuelven casi todo con poco riesgo.

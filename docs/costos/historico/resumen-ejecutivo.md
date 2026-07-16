# Análisis de costos — Resumen ejecutivo

> Una página para propuestas comerciales. Detalle completo en [analisis-costos.md](analisis-costos.md).
> Datos reales de producción verificados el 2026-07-07.
>
> **⚠️ Segmentación, planes y precios VIGENTES: ver [propuesta-v2.md](propuesta-v2.md)** (2026-07-15).
> Este one-pager conserva los **datos de costo real** (base de cálculo); su segmentación 250/1.500/5.000
> y sus precios son de **v1**. Facturación vigente por **matrículas**, no por cabezas.

## La estructura de costos en una frase

**Un costo fijo bajo y compartido (~$25/mes de Supabase para todas las instituciones) + un costo
variable de IA que hoy es minúsculo (~$0,32/mes en la institución más grande) y se puede llevar a $0
para ExamLab con BYO API key.**

## Cifras clave (reales)

| | Valor |
|---|---|
| Institución real más grande | FESNA — **190 estudiantes** |
| Costo de IA de esa institución (ritmo real) | **≈ $0,32 / mes** |
| Costo de IA por operación (Gemini 2.5 Flash) | Tutor $0,0015 · examen $0,0027 · taller $0,0044 · proyecto $0,0175 |
| Almacenamiento real total (6 instituciones) | **47 MB** (de 100 GB incluidos) |
| Costo fijo de infraestructura actual | **~$25/mes** (un Supabase Pro para todo) |

## Costo de IA por tamaño de institución (USD/mes)

| Estudiantes | Real medido | Típico maduro | Intensivo (techo) |
|---|---|---|---|
| 190 (real hoy) | $0,32 | $11,8 | $38 |
| 250 (Esencial) | $0,43 | $15,5 | $50 |
| 1.500 (Profesional) | $2,55 | $93 | $300 |
| 5.000 (Institucional) | $8,50 | $310 | $1.000 |

*Real medido = ritmo actual de prod. Típico maduro = 2 exámenes + 4 talleres + 20 msgs tutor/mes.
Intensivo = techo con Gemini Pro + 60 msgs tutor/mes (para dimensionar el peor caso).*

## Palancas comerciales

- **BYO API key** → la institución paga la IA directo a Google; **ExamLab $0 de costo de IA**.
- **IA como add-on medido** → se factura el consumo real + margen.
- **Cola sync/async** → el Admin controla cuándo se ejecuta la IA; evita picos de gasto.
- **Almacenamiento** → incluido en todos los planes (uso real 3 órdenes de magnitud bajo el límite).

## Conclusión

A las escalas objetivo el costo variable es una **fracción minoritaria** del precio del plan (IA
típica: 6–31% según franja y modalidad). El margen es **amplio y predecible**; el único driver a
vigilar es la adopción del Tutor IA (hoy incipiente: 7 mensajes en total).

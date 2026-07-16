# docs/costos/Revision — Modelo económico ExamLab v3 (2026-07)

> **Revisión completa** del modelo de costos y precios de ExamLab.
> Reemplaza a los documentos históricos de `../` (v1 y v2) con precios
> de terceros **verificados 2026-07** y una simplificación radical del
> modelo comercial.
>
> **Regla base:** cada tenant = 1 empresa/universidad distinta, y **la
> IA la paga la universidad** (BYO API key de Gemini). Por eso el
> análisis se centra 100% en costo de INFRA + operación humana en
> modalidad administrada.
>
> **Fecha:** 2026-07-19 · **Locale:** es-CO · **Moneda:** USD/mes

---

## Índice

| Documento | Para qué |
|---|---|
| [resumen-ejecutivo.md](resumen-ejecutivo.md) | **One-pager comercial.** Precios + margen + comparables en una hoja. Empezá acá. |
| [analisis-infra-2026.md](analisis-infra-2026.md) | Costos actualizados de Supabase Pro / Lovable / AWS Lambda / email / dominio. Break-points de cada quota. |
| [modelo-precios-v3.md](modelo-precios-v3.md) | La nueva propuesta: 3 planes visibles (Pequeña / Mediana / Grande) + Enterprise custom + 6 add-ons. Con racional de cada precio. |
| [add-ons.md](add-ons.md) | Detalle de los 6 add-ons: precio, costo real, margen, enforcement técnico. |
| [comparables-mercado.md](comparables-mercado.md) | Precios verificados 2026 de Moodle Cloud, Canvas, Blackboard, Chamilo. Posicionamiento de ExamLab. |
| [escenarios.md](escenarios.md) | Casos concretos: 3 clientes tipo con números reales de ganancia neta y payback. |
| [calculadora.csv](calculadora.csv) | **Hoja de cálculo lista para importar** en Excel/Google Sheets. Simula escala + plan + add-ons + costo real + margen. |
| [riesgos-y-supuestos.md](riesgos-y-supuestos.md) | Supuestos del modelo, riesgos operativos, palancas de mitigación. |

---

## Cambios respecto a v1/v2

| Aspecto | v1/v2 | v3 (esta) |
|---|---|---|
| **Fuente de precios de terceros** | Junio 2026 | **Julio 2026** (verificado en supabase.com/pricing + lovable.dev/pricing + aws.amazon.com/lambda) |
| **Escalera comercial** | 4 planes (Aula Free / Esencial / Profesional / Institucional) o 5 franjas (v2) | **3 planes** (Pequeña / Mediana / Grande) + Enterprise custom |
| **IA en el modelo** | Escenarios detallados de $/estud/mes; BYO como opción | **BYO por defecto en TODOS los planes** — costo IA ExamLab = $0. Add-on "IA administrada" opcional. |
| **Costo fijo actual (todos los tenants)** | ~$25/mes (solo Supabase) | **~$51/mes** (Supabase $25 + Lovable $25 + dominio $1) — Lovable NO se contabilizaba antes |
| **Precios base** | $99 / $299 / $1,000 (auto) | **$149 / $349 / $799** (auto) — más agresivos por debajo del mercado |
| **Free plan** | "Aula" (1 curso, ≤50 alumnos) | **No hay Free.** Starter $79 como piso comercial. |
| **Add-ons** | Ambiguos (mezcla módulos + entitlements) | **6 add-ons claros** con costo y margen documentados |
| **Modalidad administrada** | Recargo x2-3 sobre auto | **+$300/mes fijo** justificado con costo de tech real ($1,500-2,000 cargado, ratio 1 tech : 8 clientes) |

## ¿Por qué la simplificación?

El análisis de infra 2026 (ver [analisis-infra-2026.md](analisis-infra-2026.md)) demuestra que el costo marginal de infra por matrícula adicional es **$0.007-0.020/mes** al escalar. La diferenciación entre planes por "cuánta infra ofrezco" no es defendible económicamente — todos caben cómodamente en un Supabase Pro compartido hasta ~10,000 matrículas totales.

La diferenciación real es **capacidad y soporte**, no infra. Por eso los 3 planes se distinguen por:
1. **Rango de matrículas activas** (cap contractual, no técnico).
2. **Priority de soporte** (email vs SLA).
3. **Add-ons habilitados** (algunos requieren plan mínimo).

## Convención de facturación

**Se factura por MATRÍCULAS ACTIVAS por período**, no por cabezas únicas. Una matrícula = 1 inscripción a materia con acceso a la plataforma en el período. Un alumno en 6 materias = 6 matrículas.

Racional: el costo variable escala con **entregas y sesiones**, no con personas. Un alumno inscrito en 6 materias genera ~6× la carga de un alumno en 1. Facturar por cabezas subfactura el driver real (ver [analisis-infra-2026.md §Break-points](analisis-infra-2026.md)).

Si el cliente exige cobrar por cabezas: aplicar factor 4-6× (típico en educación superior colombiana).

## Precios sujetos a cambio

Los precios de terceros (Supabase, Lovable, AWS) **cambian con frecuencia**. Antes de firmar contrato:
1. Reverificar en las páginas oficiales (linkeadas en [analisis-infra-2026.md](analisis-infra-2026.md)).
2. Recalcular con [calculadora.csv](calculadora.csv).
3. Actualizar este documento con nueva fecha si hubo cambios materiales.

# docs/costos — Análisis de costos de ExamLab

Documentos de análisis de costos de operación, con **datos reales de producción** (verificados por
consulta SQL directa a prod el 2026-07-07) y **precios de terceros** (Gemini, Supabase).

| Documento | Para qué |
|---|---|
| [analisis-costos.md](analisis-costos.md) | Análisis completo: metodología, datos reales, precios, costo de IA por operación / por estudiante / **por tamaño de institución**, almacenamiento, infraestructura, aislamiento regulatorio, conclusiones y monitoreo. |
| [resumen-ejecutivo.md](resumen-ejecutivo.md) | Una página para propuestas comerciales: cifras clave + tabla por tamaño de institución + palancas comerciales. |
| [propuesta-v2.md](propuesta-v2.md) | **v2 (2026-07-15)** — re-segmentación por tamaño (Pequeña ≤1.500 / Mediana ≤10.000 / Grande >10.000), precios sugeridos + costo-beneficio + margen por franja, política de IA (cliente paga BYO vs incluida) y métrica de facturación (matrículas, no cabezas). |

Relacionados:
- [../demos/presentacion/modelo-costos-ia-almacenamiento.md](../demos/presentacion/modelo-costos-ia-almacenamiento.md) — versión para presentación (misma base de datos y cálculos).
- [../demos/presentacion/modelo-negocio-modular.md](../demos/presentacion/modelo-negocio-modular.md) — modelo de negocio / planes.

**Nota:** los precios de terceros (Google, Supabase) están sujetos a cambio — verificar en la fuente
antes de cotizar en firme. Las cifras de uso se recalibran con los datos propios de cada institución
(ver §12 "Monitoreo recomendado" del análisis completo).

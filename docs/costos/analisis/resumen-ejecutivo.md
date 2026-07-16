# Resumen ejecutivo — Modelo económico v3

> Una página para propuestas comerciales. Detalle en los demás documentos de la carpeta.
> **Fecha:** 2026-07-19 · Precios de terceros verificados en la fecha; reverificar antes de firmar.

## La estructura de costos en una frase

**~$51/mes de infra fija cubre TODOS los tenants** (Supabase Pro + Lovable Pro + dominio). La IA la paga la universidad (BYO API key de Gemini) → costo IA para ExamLab = $0. Escalar tenants tiene costo marginal ≈ $0 hasta ~10,000 matrículas activas totales.

## Planes recomendados (modalidad AUTO)

| Plan | Matrículas | USD/mes | $/matrícula/mes | Costo ExamLab | Margen |
|---|---|---|---|---|---|
| **Starter** | ≤ 200 | **$79** | $0.40 | ~$10 | 87% |
| **Pequeña** | 201–1,000 | **$149** | $0.15 | ~$15 | 90% |
| **Mediana** | 1,001–3,000 | **$349** | $0.12 | ~$30 | 91% |
| **Grande** | 3,001–10,000 | **$799** | $0.08 | ~$80 | 90% |
| **Enterprise** | > 10,000 | Custom desde **$1,499** | ~$0.06-0.15 | ~$200+ | 87%+ |

## Modalidad ADMINISTRADA (+$300/mes fijo sobre el auto)

Justificado por costo real de tech junior (~$1,800/mes cargado × 1 tech por 8 clientes = $225/institución). ExamLab absorbe $225, cobra $300 → margen operativo por servicio ~25%.

⚠️ **NO ofrecer administrada en Starter** — la operación humana supera el spread.

| Plan | Auto | Admin | Margen (después de servicio) |
|---|---|---|---|
| Pequeña Admin | $149 | **$449** | 40% |
| Mediana Admin | $349 | **$749** | 55% |
| Grande Admin | $799 | **$1,499** | 60% |

## Comparables del mercado (2026-07)

| Plataforma | $/matrícula/mes | Fuente |
|---|---|---|
| **ExamLab Mediana** | $0.12 | Este doc |
| Moodle Cloud Medium (500 users) | $0.20 | [moodlecloud.com](https://www.moodlecloud.com/standard-plans/) |
| Moodle Cloud Standard (750 users) | $0.23 | idem |
| Canvas LMS (institucional negociado) | $0.42–2.50 | [Vendr Marketplace](https://www.vendr.com/marketplace/canvas) |
| Blackboard | $0.50–3.00 | Enterprise |
| Chamilo self-hosted | $0.00 | Open source (competencia gratis) |

**ExamLab se posiciona ~40% más barato que Moodle Cloud, 3-20× más barato que Canvas.** Justificable por: producto SaaS multi-tenant listo + IA embebida + Reto en vivo/proyectos/anti-plagio en el mismo paquete.

## Ganancia esperada con 20 clientes distribuidos

Mix realista: 5 Starter + 10 Pequeña + 3 Mediana + 2 Grande, todos AUTO:

```
Revenue: 5×$79 + 10×$149 + 3×$349 + 2×$799 = $395 + $1,490 + $1,047 + $1,598 = $4,530/mes
Costo:   ~$100/mes (Supabase + Lovable + dominio + overhead)
Neto:    ~$4,430/mes = $53,160/año (margen 98%)
```

Con la misma mezcla en modalidad ADMIN (asumiendo 30% del mix se pasa a admin):
```
Revenue admin extra: 30% × 20 × ~$300 = $1,800/mes adicionales
Costo tech: 6 admin × $225 = $1,350/mes
Neto admin extra: $450/mes = $5,400/año
Total: $58,560/año
```

## Add-ons (upsell puro)

| Add-on | Precio | Margen |
|---|---|---|
| IA administrada (sin BYO) | $0.10/matrícula/mes | 38% |
| Storage extra (>50 GB) | $10/100 GB/mes | 80% |
| Code runner ilimitado | $49/mes | 90% |
| Aislamiento dedicado (Supabase por tenant) | $99/mes | 60% |
| SSO/SAML | $99 setup + $29/mes | 80% |
| Certificación oficial con QR | $29/mes | 100% |

## Palancas de riesgo

1. **Grabaciones de clase por URL externa** (YouTube/Vimeo/Cloudflare Stream), NO subir al Storage. Contractual.
2. **Alertas automáticas** cuando un tenant supera 80% de su cuota de storage/egress.
3. **Facturar en COP con revisión anual** o USD con cláusula de ajuste por TRM.
4. **NO prometer administrada en Starter** — margen negativo por operación humana.

## Próximo paso comercial

1. Publicar los 3 planes en la landing con [modelo-precios-v3.md §Tabla comercial](modelo-precios-v3.md).
2. Piloto con 3-5 clientes reales para validar la conversión Pequeña → Mediana y el mix esperado.
3. Reverificar precios de terceros a 6 meses (2027-01) — Supabase y Lovable suben con frecuencia.

## Documentos relacionados

- **Análisis técnico completo:** [analisis-infra-2026.md](analisis-infra-2026.md)
- **Racional detallado del pricing:** [modelo-precios-v3.md](modelo-precios-v3.md)
- **Calculadora simuladora:** [calculadora.csv](calculadora.csv)
- **Casos concretos:** [escenarios.md](escenarios.md)
- **Riesgos y supuestos:** [riesgos-y-supuestos.md](riesgos-y-supuestos.md)

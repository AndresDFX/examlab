# Modelo de precios v3 — planes, add-ons, política de venta

> **Reemplaza** las propuestas v1 y v2. Precios basados en [analisis-infra-2026.md](analisis-infra-2026.md).
> **Fecha:** 2026-07-19 · **Moneda:** USD/mes.

## 1. Filosofía

**Simplicidad radical**: 3 planes visibles + Enterprise custom + 6 add-ons opcionales. Nada más.

**Diferenciación por CAPACIDAD (matrículas), no por MÓDULOS**. Todos los planes tienen el mismo producto — lo que cambia es el tope de matrículas y el nivel de soporte.

**IA en BYO por defecto** — la universidad usa su propia API key de Gemini y paga a Google directo. ExamLab tiene $0 de costo de IA. Ver [add-ons.md § IA administrada](add-ons.md) para la excepción.

## 2. Tabla comercial visible (para landing / propuestas)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ExamLab — Planes                            │
│                                                                      │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐            │
│  │   Pequeña     │  │    Mediana    │  │    Grande     │            │
│  │               │  │               │  │               │            │
│  │   $149/mes    │  │   $349/mes    │  │   $799/mes    │            │
│  │               │  │               │  │               │            │
│  │  Hasta        │  │  Hasta        │  │  Hasta        │            │
│  │  1,000        │  │  3,000        │  │  10,000       │            │
│  │  matrículas   │  │  matrículas   │  │  matrículas   │            │
│  │               │  │               │  │               │            │
│  │  Soporte      │  │  Soporte      │  │  Soporte      │            │
│  │  por email    │  │  prioritario  │  │  con SLA 24h  │            │
│  └───────────────┘  └───────────────┘  └───────────────┘            │
│                                                                      │
│  Enterprise (>10,000 matrículas o multi-sede): Contáctenos           │
│                                                                      │
│  Modalidad administrada disponible en Pequeña/Mediana/Grande         │
│  (recargo +$300/mes — incluye onboarding y operación)                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Todos los planes incluyen (equal feature access)

- Cursos, exámenes, talleres, proyectos ilimitados
- Calificación con IA (BYO: usás tu propia clave de Gemini)
- Kahoot, encuestas, pizarra colaborativa
- Foro por curso, banco de preguntas, biblioteca de videos (URL externa)
- Certificados con QR verificable
- Multi-tenant aislado por RLS
- Backups diarios (7 días retention)
- Actualizaciones continuas (fixes y features nuevos)

### Diferencias entre planes (solo estas 3)

| Feature | Pequeña | Mediana | Grande | Enterprise |
|---|---|---|---|---|
| Matrículas activas | ≤1,000 | ≤3,000 | ≤10,000 | >10,000 |
| Soporte | Email 48h | Email 24h + prioridad | SLA 24h + Slack | SLA 4h + gerente cuenta |
| Storage (soft cap) | 50 GB | 100 GB | 200 GB | Custom |
| Backups extra | No | 30 días | 90 días | Custom |
| SSO/SAML | Add-on | Add-on | Incluido | Incluido |
| Reporting API | No | Add-on | Incluido | Incluido |
| Onboarding guiado | Self-service | 4h incluidas | 8h incluidas | Custom |

## 3. Tabla técnica interna (con costos y márgenes)

**Este cuadro NO se muestra al cliente** — es para tu control interno.

### 3.1. Modalidad AUTO (cliente opera solo)

| Plan | Precio | Matrículas máx | $/matrícula/mes | Costo infra ExamLab | Margen | Margen % |
|---|---|---|---|---|---|---|
| Starter (opcional) | $79 | 200 | $0.40 | $10 | $69 | 87% |
| **Pequeña** | **$149** | **1,000** | **$0.15** | **$15** | **$134** | **90%** |
| **Mediana** | **$349** | **3,000** | **$0.12** | **$30** | **$319** | **91%** |
| **Grande** | **$799** | **10,000** | **$0.08** | **$80** | **$719** | **90%** |
| Enterprise desde | $1,499 | >10,000 | $0.06-0.15 | $200+ | $1,299+ | 87%+ |

### 3.2. Modalidad ADMINISTRADA (+$300/mes fijo)

**Costo humano real** (validado con salarios Colombia 2026):
- Tech junior/mid remote: $1,500-2,000 USD/mes cargado (salario + prestaciones + herramientas).
- Ratio realista: 1 tech soporta 8 clientes admin bien.
- **Costo por cliente: $1,800 / 8 ≈ $225/mes**.
- Cobrar **$300** deja $75/mes de margen operativo = 25% sobre el costo humano.

| Plan | Auto | Admin (auto + $300) | Costo infra + humano | Margen | Margen % |
|---|---|---|---|---|---|
| ~~Starter Admin~~ | ~~$79~~ | ~~$379~~ | **NO VIABLE** | — | Pérdida |
| **Pequeña Admin** | $149 | **$449** | $15 + $225 = $240 | $209 | 47% |
| **Mediana Admin** | $349 | **$749** | $30 + $225 = $255 | $494 | 66% |
| **Grande Admin** | $799 | **$1,499** | $80 + $225 = $305 | $1,194 | 80% |
| Enterprise Admin | $1,499+ | Custom | Custom | 70%+ | 70%+ |

**⚠️ NO ofrecer Starter Admin.** El costo humano ($225) supera el spread del plan ($300 sobre $79 = "margen operativo" = $75, pero al menos hay $$$; sin embargo el precio total $379 no es competitivo). Mejor decir "administrada disponible desde plan Pequeña".

## 4. Racional de cada precio

### Starter — $79/mes (≤200 matrículas)

**Objetivo**: piloto de bajo compromiso para colegios pequeños o profes independientes con 2-3 cursos.

**Por qué $79 y no menos**:
- Piso comercial. Bajar de $79 canibaliza Pequeña.
- $0.40/matrícula/mes es más caro que Pequeña ($0.15) — por eso está.
- El cliente que necesita menos de 200 matrículas tiende a valorar más el hand-holding y menos el precio absoluto.

**Cuándo usarlo**: pilotos de venta a colegios pequeños. Después promoverlos a Pequeña cuando escalen.

### Pequeña — $149/mes (201-1,000 matrículas)

**Objetivo**: colegios medianos, academias, cursos online independientes.

**Por qué $149**:
- Competitivo con Moodle Cloud ~$1,180/año (500 users) = $98/mes. ExamLab es +50% pero incluye IA + Kahoot + proyectos + anti-plagio que Moodle NO tiene out-of-the-box.
- A 1,000 matrículas = $0.15/matrícula/mes → **~2× más barato que Moodle Cloud** y ~5× más barato que Canvas.

**Costo real**: ~$15/mes (fracción del $51 fijo + algo de storage/egress marginal). Margen 90%.

### Mediana — $349/mes (1,001-3,000 matrículas)

**Objetivo**: universidades pequeñas/medianas, institutos técnicos con 3-6 carreras.

**Por qué $349** (no $299 ni $499):
- $349 = $0.12/matrícula/mes a 3,000 matrículas. Percibido como "3× la Pequeña por 3× la escala" — mental model limpio.
- Comparable Canvas negociado a esa escala: $50k-$150k/año = $4k-$12k/mes → ExamLab es **10-30× más barato**. Espacio para captura de mercado.

**Costo real**: ~$30/mes. Margen 91%.

### Grande — $799/mes (3,001-10,000 matrículas)

**Objetivo**: universidades medianas/grandes, con 6+ carreras.

**Por qué $799**:
- $0.08/matrícula/mes a 10,000. Alineado con el rango bajo de Canvas ($5/estudiante/año) pero incluye IA + anti-plagio + code runner en la misma cuota.
- Precio psicológico bajo mil (contra $999) — evita fricción con procurement de universidades públicas.

**Costo real**: ~$80/mes (Supabase Pro + Lovable + overage estimado egress y edge). Margen 90%.

### Enterprise — Custom desde $1,499

**Objetivo**: universidades grandes (>10,000 matrículas), multi-sede, o con requerimientos regulatorios (SOC2, data residency).

**Por qué "custom"**:
- Diferentes clientes tienen diferentes drivers de costo (algunos tienen mucho video, otros mucha IA, otros pura carga concurrente). Cotización personalizada.
- Habilita venta consultiva: aislamiento dedicado ($99/mes), SSO/SAML setup ($99), etc.
- Salto a Supabase Team ($599) si se necesita SOC2 → recuperar en el precio.

**Piso $1,499**: nadie con >10,000 matrículas paga menos.

**Costo real**: $200-$400/mes según add-ons habilitados.

## 5. Descuentos y política comercial

### Descuentos publicables

| Descuento | Aplicable a | Racional |
|---|---|---|
| **-10% pago anual** (prepaid) | Todos los planes | Mejora cashflow; incentiva compromiso. |
| **-15% multi-año** (2+ años) | Mediana / Grande / Enterprise | Reduce churn; blinda pricing. |
| **-20% educación pública** (universidades públicas o colegios oficiales) | Solo si el cliente factura como entidad pública | Mercado atractivo con compra recurrente confiable. Documentar en contrato. |
| **-30% early adopter** (primeros 5 clientes por franja) | Cualquier plan | Solo primer año. Después precio full. |

### Descuentos NO publicables (para negociación)

- Hasta -20% adicional en cerrar un cliente estratégico (marca conocida que trae reputación).
- BYO API key confirmada por escrito → posible -5% (ya está en el default, así que es más gesto que descuento real).

### Política de sobreconsumo

Si un cliente **excede su cap de matrículas**:
- Aviso a los 90%: email al Admin del tenant + banner en el UI.
- Al 100%: se PERMITE el uso durante el mes en curso (no cortar el servicio).
- Al mes siguiente, ExamLab factura el upgrade automático al plan siguiente (Pequeña → Mediana, etc.).
- Documentar en contrato: **"Al superar el cap 3 meses consecutivos se aplica upgrade automático al plan siguiente sin necesidad de nueva firma"**.

## 6. Modalidad Administrada — qué incluye exactamente

Justificación del +$300/mes:

| Servicio incluido | Frecuencia | Valor equivalente |
|---|---|---|
| Onboarding guiado inicial | 1 vez, 4-8h según plan | $200-400 (una vez) |
| Configuración de branding + emails | 1 vez | $150 |
| Bulk import de usuarios/cursos | Al inicio + 2 semestres/año | $100 × 3 = $300/año |
| Soporte por Slack/WhatsApp con SLA 4h | Continuo | Base del servicio |
| Reunión mensual de revisión (1h) | Mensual | $100/mes valor de mercado consultor |
| Reportes mensuales de uso | Mensual | Incluido |
| Backup extra semanal a S3 externo | Semanal | $10/mes costo real |

**Costo real de operación (tech ExamLab)**: ~4-6h de tech senior por cliente por mes ≈ $200-$300 valorizados. Alineado con el $300 cobrado.

## 7. Add-ons (upsell independiente del plan)

Ver detalle completo en [add-ons.md](add-ons.md).

Resumen:

| Add-on | Precio | Aplicable a | Uso típico |
|---|---|---|---|
| IA administrada (sin BYO) | $0.10/matrícula/mes | Todos | Universidad no quiere gestionar API key Gemini |
| Storage extra (>50 GB) | $10/100 GB/mes | Todos | Cliente que sube muchos videos |
| Code runner ilimitado | $49/mes | Mediana+ | Facultad de ingeniería con exámenes de código |
| Aislamiento dedicado (Supabase por tenant) | $99/mes | Grande / Enterprise | Data residency Colombia (Habeas Data), SOC2 |
| SSO/SAML | $99 setup + $29/mes | Mediana+ | LDAP institucional, Azure AD, Google Workspace |
| Certificación oficial | $29/mes | Todos | Programas con certificado formal (diplomados) |

## 8. Comparación express contra el mercado

| Plataforma | Plan comparable | Precio | ExamLab Mediana |
|---|---|---|---|
| Moodle Cloud Medium | 500 users | $1,180/año = **$98/mes** | $349/mes (3× más caro pero 6× más matrículas) |
| Canvas negociado | 3,000 estudiantes @$10/user/año | **$2,500/mes** | $349/mes (7× más barato) |
| Blackboard | 3,000 estudiantes | **$3,000-8,000/mes** | $349/mes (10-25× más barato) |
| Chamilo self-hosted | Ilimitado | $0 + costo VPS y ops | ExamLab evita "self-host tax" |

**Posicionamiento**: "Mediano entre Moodle Cloud (barato pero limitado) y Canvas (potente pero enterprise). Con IA y features modernas por el 20-40% del precio Canvas."

## 9. Ejemplo de propuesta comercial

```
Cliente: Universidad Los Andes (Bogotá)
Escala: 4,500 matrículas activas por semestre
Requerimientos: IA de calificación, exámenes de programación,
                aislamiento por Habeas Data (Ley 1581/2012)

Propuesta:
- Plan Grande Auto:                       $799/mes
- Add-on Aislamiento dedicado:            $ 99/mes
- Add-on Code runner ilimitado:           $ 49/mes
- Descuento pago anual (-10%):           -$ 94/mes
                                          ─────────
Total mensual:                            $853/mes
Total anual:                              $10,236/año

Comparable Canvas Instructure:            $45,000-$135,000/año
Ahorro estimado:                          78-92%

Migración estimada:
- Setup + branding:                       incluido (Admin)
- Import de 4,500 matrículas:             incluido
- Capacitación docentes (8h):             incluido en Admin
- Ir a Grande Admin? +$300/mes:           opcional
```

Nota: al agregar Admin ($300), Grande sube a **$1,153/mes = $13,836/año**, aún un décimo del precio Canvas.

## Documentos relacionados

- [analisis-infra-2026.md](analisis-infra-2026.md) — costos exactos que sustentan estos precios
- [add-ons.md](add-ons.md) — detalle de cada add-on
- [escenarios.md](escenarios.md) — 3 casos con números
- [calculadora.csv](calculadora.csv) — simulador
- [riesgos-y-supuestos.md](riesgos-y-supuestos.md) — límites del modelo

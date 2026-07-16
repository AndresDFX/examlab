# Análisis de infraestructura — costos verificados 2026-07

> Todos los precios verificados en las páginas oficiales el **2026-07-19**.
> Reverificar antes de firmar contrato con cualquier cliente — Supabase y Lovable
> ajustan precios ~2 veces por año.

## 1. Componentes de la stack de ExamLab

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Cliente (browser) ──── Lovable (hosting SPA)                │
│                              │                               │
│                              ▼                               │
│                     Supabase Pro (proyecto único)            │
│                     ├── PostgreSQL (RLS multi-tenant)        │
│                     ├── Storage (buckets compartidos)        │
│                     ├── Edge Functions (24 fns)              │
│                     ├── Auth (bulk import, SSO)              │
│                     ├── Realtime (Kahoot en vivo, chat)      │
│                     └── pg_cron (17 jobs programados)        │
│                              │                               │
│                              ▼                               │
│                     AWS Lambda (code runner)                 │
│                     ├── Java (CheerpJ + fallback)            │
│                     └── Python (tkinter GUI)                 │
│                              │                               │
│                              ▼                               │
│                     Google Gemini API (BYO cliente) 🔑        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## 2. Precios oficiales 2026-07 (uno por uno)

### 2.1. Supabase Pro — $25/mes base

Fuente: [supabase.com/pricing](https://supabase.com/pricing) (verificado 2026-07-19).

| Recurso | Incluido | Overage |
|---|---|---|
| Compute credit | $10/mes (cubre 1 Micro instance) | según instancia |
| Database size | 8 GB | $0.125/GB/mes |
| Storage | 100 GB | $0.0213/GB/mes |
| Egress (network) | 250 GB | $0.09/GB |
| Cached egress | 250 GB | $0.03/GB |
| Edge Functions | 2M invocaciones/mes | $2/1M |
| Realtime connections | 500 concurrentes | $10/1000 |
| Auth MAUs | 100,000/mes | $0.00325/MAU |
| Backups | 7 días retention | plans superiores |
| Log retention | 7 días | plans superiores |

**Auto-scaling automático**: los overages se facturan al mes. No se corta el servicio si te pasas.

### 2.2. Supabase Team — $599/mes (para futuro)

Cuando ExamLab tenga clientes que exijan compliance formal (SOC2, ISO 27001), se salta a Team:
- Mismas quotas que Pro **× 1** (no incluye más recursos, solo compliance)
- Backups 14 días, logs 28 días
- SLA con priority support
- Costo justifica solo si un cliente Enterprise paga por el compliance.

**Cuándo migrar**: cuando 1 sola universidad grande exija SOC2 por contrato. Antes no.

### 2.3. Lovable — $25 Pro / $50 Business

Fuente: [lovable.dev/pricing](https://lovable.dev/pricing) (verificado 2026-07-19).

| Plan | Precio | Créditos build | Créditos Cloud | Features |
|---|---|---|---|---|
| Free | $0 | 5/día (hasta 30/mes) | 20/mes | Uso personal |
| **Pro** | **$25/mo** | 100/mes + 5/día | Incluido | Custom domain, hosting, colaboración |
| Business | $50/mo | 100/mes + 5/día | Incluido | + SSO + security center |
| Enterprise | Custom | Volumen | Volumen | + SLA |

**⚠️ Nota importante**: Lovable factura en 2 capas — subscription + créditos Cloud/AI consumidos por la app en producción. Si el tráfico sube mucho, la app consume créditos extras (facturación variable no incluida en el $25).

**Alternativa si el consumo escala**: migrar hosting a Vercel/Netlify (más baratos por tráfico) manteniendo Lovable solo para el editor visual. Break-even estimado: cuando la factura Lovable pasa de ~$100/mes total.

### 2.4. AWS Lambda — code runner de exámenes con programación

Fuente: [aws.amazon.com/lambda/pricing](https://aws.amazon.com/lambda/pricing/) (verificado 2026-07-19).

| Recurso | Free tier | Overage |
|---|---|---|
| Requests | 1,000,000/mes | $0.20/1M |
| Compute time | 400,000 GB-seconds/mes | $0.0000167/GB-s (x86) o $0.0000133 (ARM) |

Uso real ExamLab: **11 ejecuciones en 2 meses**. Está DENTRO del free tier con margen enorme.

Escala esperada: 10,000 estudiantes con exámenes de programación (Java/Python) 2 veces al mes = 20,000 ejecuciones/mes → aún dentro del free tier.

**No se convierte en driver de costo salvo a >5M ejecuciones/mes** (~500,000 estudiantes activos con exámenes de código).

### 2.5. Email / SMTP

- Cliente configura su Gmail/SMTP institucional en el panel de Admin.
- ExamLab NO paga por email → **$0**.

### 2.6. Dominio + SSL

- Dominio `.com` o `.co`: ~$12/año → **~$1/mes**.
- SSL: incluido en Lovable/CloudFlare gratis.

## 3. Costo TOTAL fijo actual (todos los tenants)

| Concepto | Costo mensual |
|---|---|
| Supabase Pro | **$25** |
| Lovable Pro | **$25** |
| AWS Lambda | $0 (free tier) |
| Email SMTP | $0 (cliente) |
| Dominio | $1 |
| Google Gemini API | $0 (BYO cliente) |
| **TOTAL FIJO** | **~$51/mes** |

## 4. Costo marginal al agregar tenants (asumiendo IA=BYO)

**El costo NO escala linealmente con tenants** porque los recursos están compartidos. Escala con el **uso agregado** de todos los tenants.

### 4.1. Break-points de cada quota de Supabase Pro

| Quota | Rompe a X matrículas activas TOTALES | Costo del overage |
|---|---|---|
| **DB size 8 GB** | ~50,000 (0.16 MB/matrícula: perfiles + entregas texto) | $0.125/GB → despreciable a esta escala |
| **Storage 100 GB** | ~15,000 (material 6 MB/curso + ZIPs 5 MB × ~2/año/matrícula) | $0.02/GB → **~$1/100 GB extra** |
| **Egress 250 GB** | ~5,000–10,000 (varía si suben videos) | $0.09/GB → **~$9/100 GB extra** |
| **Edge Functions 2M** | ~15,000 (heartbeat Kahoot + autosave + notifs + cron) | $2/1M → **~$2/1M extra** |
| **Realtime 500 conex** | Kahoot en vivo simultáneo en 5+ cursos con 100+ alumnos c/u | $10/1000 → raro en producción |
| **Auth MAUs 100k** | 100,000 matrículas activas únicas por mes | $3.25/1000 → **muy lejos** |

### 4.2. Curva de costo real por escala

| Matrículas TOTALES (todos los tenants) | Costo mensual ExamLab | $/matrícula/mes | $/1000 matrículas/mes |
|---|---|---|---|
| 250 (hoy) | $51 | $0.204 | $204 |
| 500 | $51 | $0.102 | $102 |
| 1,000 | $51 | $0.051 | $51 |
| 2,500 | $53 (algo edge) | $0.021 | **$21** |
| 5,000 | $65 (egress + edge) | $0.013 | **$13** |
| 10,000 | $90 (+$25 egress + $10 Lambda) | $0.009 | $9 |
| 25,000 | $180 (egress serio) | $0.007 | **$7** ← óptimo |
| 50,000 | ~$700 ($599 Team + overage) | $0.014 | $14 |

**Punto de eficiencia máxima: 10,000-25,000 matrículas totales** entre todos los tenants — costo por matrícula = $0.007-0.009/mes.

**Salto costoso: al saltar a Supabase Team ($599)** — se justifica solo si un cliente exige compliance/SOC2.

## 5. Regla de dedo para cotizar

Con IA=BYO y grabaciones por URL externa:

> **Cobrar mínimo 10× el costo marginal por matrícula.**
>
> Si mi costo marginal es $0.01/matrícula/mes, cobrar mínimo $0.10/matrícula/mes.

Los precios del [modelo-precios-v3.md](modelo-precios-v3.md) usan este piso ($0.08-$0.40/matrícula/mes según franja) — margen 87-91%.

## 6. Costos NO incluidos en esta tabla (a considerar)

Aunque no son infra pura, afectan la rentabilidad:

| Rubro | Impacto | Cómo tratarlo |
|---|---|---|
| **Operación humana** (soporte, onboarding) | ~$225/mes por cliente admin | Solo aplica a modalidad Administrada. Ver [add-ons.md](add-ons.md). |
| **CAC (adquisición de cliente)** | ~40h × $25/h = $1,000 por piloto | Payback: Pequeña $149 → 7 meses. Aceptable. |
| **Impuestos Colombia** | IVA 19% + retenciones 4-11% | Precios publicados "más IVA". Neto real 20-30% menor. |
| **Tipo de cambio USD/COP** | Swing típico 10-15% anual | Facturar en COP con revisión anual, o USD con cláusula de ajuste. |
| **Desarrollo/mantenimiento** | ~1 developer full-time (~$3-5k/mes) | No es "por cliente" — es costo de existir. Distribuir sobre revenue total. |
| **Monitoreo/observabilidad** | Sentry/PostHog free tier hoy | $0-$50/mes según crecimiento |

## 7. Validaciones antes de escalar

Cuando ExamLab tenga >2,000 matrículas totales, ejecutar:

```sql
-- Métricas de uso real (Supabase SQL Editor):

-- 1. Almacenamiento total por bucket
SELECT bucket_id, sum((metadata->>'size')::bigint) / 1024 / 1024 AS mb
FROM storage.objects GROUP BY bucket_id;

-- 2. Egress: usar Supabase Dashboard → Reports → Usage → Egress

-- 3. Edge functions invocations: Dashboard → Reports → Functions

-- 4. Realtime connections peak: Dashboard → Reports → Realtime
```

Si alguna quota está >70% en promedio 3 meses seguidos, empezar a plantear:
- Migración de storage a Cloudflare R2 (más barato)
- Migración de hosting a Vercel (mejor egress)
- Compra de bloque adicional Supabase (compute up)

## 8. Alternativas si la stack sube de precio

**Contingencia por si Supabase o Lovable duplican precios en 2027**:

| Componente actual | Alternativa | Costo comparable | Trabajo migrar |
|---|---|---|---|
| Supabase Pro ($25) | Self-hosted PostgreSQL + PostgREST en VPS ($10-20) | Similar | Medio (~2 semanas dev) |
| Supabase Storage | Cloudflare R2 (menos egress) | 30% más barato | Bajo (misma API S3) |
| Lovable ($25) | Vercel Free + build local | $0-20 | Bajo (repo estándar) |
| Google Gemini | OpenAI o Anthropic (ya en fallback) | Similar | Ya soportado |

Ninguno es urgente hoy — pero documentado por si.

## Sources

- [Supabase Pricing 2026](https://supabase.com/pricing)
- [Supabase Pricing 2026: Free Tier Limits & Real Costs](https://designrevision.com/blog/supabase-pricing)
- [Lovable Pricing 2026](https://lovable.dev/pricing)
- [Lovable Pricing 2026: Plans, Credits & Hidden Costs](https://laracopilot.com/blog/lovable-pricing-2026-review/)
- [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)
- [AWS Lambda Pricing 2026](https://go-cloud.io/aws-lambda-pricing/)

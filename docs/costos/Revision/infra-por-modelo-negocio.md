# Costo de infraestructura por modelo de negocio — ExamLab

> Base: modelo v3 (`docs/costos/Revision/`). Moneda **USD/mes** salvo donde se indique anual. IA = **BYO** (cliente paga Gemini con su propia key → $0 para ExamLab). Videos por URL externa → no consumen storage. Costo fijo compartido actual ≈ **$51/mes** (Supabase Pro $25 + Lovable $25 + dominio $1; Lambda $0 free tier; Gemini $0).

Las tres escalas de referencia se leen distinto según el modelo:

- **Modelo 1 (self-host):** matrículas = tamaño del *único* cliente → estima la infra que **él** paga.
- **Modelo 2 (dedicada gestionada):** matrículas = tamaño de *ese* cliente aislado → estima **mi** costo (infra dedicada + humano).
- **Modelo 3 (SaaS compartido):** matrículas = **total agregado** de todos los clientes → estima **mi** costo marginal sobre el $51 fijo.

---

## Modelo 1 — Licencia SIN administración mía (cliente self-host)

El cliente corre su propia instancia mono-tenant. **Mi costo de infra ≈ $0.** Yo entrego el software y las actualizaciones; el cliente paga y opera su infra.

### Qué paga el cliente (dos rutas de despliegue)

**Ruta A — Supabase Pro propio + hosting estático** (la más barata, recomendada para la mayoría):

| Matrículas (1 cliente) | Supabase | Hosting SPA (Vercel/Netlify/CloudFront) | Dominio | Gemini | **Total cliente/mes** |
|---|---|---|---|---|---|
| 200 | $25 (base) | $0 (free) | $1 | $0 (BYO) | **~$26** |
| 1.000 | $25 (dentro de quotas) | $0–20 | $1 | $0 | **~$26–46** |
| 3.000 | $25–30 (algo de compute/egress) | $20 | $1 | $0 | **~$45–55** |
| 10.000 | $25 base + ~$10–15 egress + ~$15 compute Small | $20 | $1 | $0 | **~$70–90** |

*Racional break-points mono-tenant:* egress 250GB rompe a ~5–10k (overage $0.09/GB); storage 100GB y edge 2M no se tocan hasta ~15k; DB 8GB no se toca hasta ~50k. Un solo cliente de 10k queda cómodo en Pro con overage menor de egress + subir compute.

**Ruta B — AWS full-stack** (RDS/Aurora + S3 + CloudFront + Cognito/GoTrue + Lambda; solo si exigen residencia/compliance propia):

| Matrículas | Base de datos (RDS/Aurora) | S3 + CloudFront | Cognito/Lambda | **Total cliente/mes** |
|---|---|---|---|---|
| 200 | db.t4g.micro ~$25–35 | ~$3–8 | free tier | **~$50–80** |
| 1.000 | micro/small ~$35–60 | ~$8–15 | ~$0–10 | **~$70–120** |
| 3.000 | small/medium ~$70–120 | ~$20–40 | ~$10–20 | **~$120–200** |
| 10.000 | medium (+Multi-AZ) ~$180–320 | ~$50–100 | ~$20–40 | **~$250–450** |

**Lo que entrego yo (costo marginal ~$0):** paquete de despliegue (repo build + migraciones SQL versionadas + seed de roles/plantillas), documentación de instalación, actualizaciones periódicas (fixes + features), soporte **de licencia** (no operativo: bugs del software, dudas de despliegue), y una guía de hardening RLS. **No** opero su servidor ni respondo por su uptime.

### Estructura de precio de licencia sugerida

Recomiendo **suscripción de licencia anual** (no perpetua):

| Tier (cap matrículas) | Licencia anual | Equiv. mensual | Setup one-time (deploy + training) |
|---|---|---|---|
| Pequeña (≤1.000) | **$1.000/año** | ~$83 | $1.500 |
| Mediana (≤3.000) | **$2.500/año** | ~$208 | $2.000 |
| Grande (≤10.000) | **$6.000/año** | ~$500 | $3.000 |
| Enterprise (>10.000) | **desde $12.000/año** | desde $1.000 | custom |

**Racional:**
- Anclado a **~55–65% del SaaS gestionado equivalente** (Pequeña SaaS = $149×12 = $1.788/año; Grande = $9.588/año). El descuento refleja que el cliente absorbe infra + operación; yo cedo el markup operativo pero conservo el valor del IP.
- Como mi costo marginal es $0, incluso al 55% el margen bruto es ~100% (menos amortización de desarrollo, que es costo de existir, no por-cliente).
- **Suscripción > perpetua** porque: (a) ata las actualizaciones a estar al día en el pago, (b) evita el problema de cobranza/enforcement del "perpetuo + mantenimiento 20%", (c) calza con el ciclo presupuestal anual de educación.
- El **setup one-time** cubre el handoff real (deploy asistido, aplicar migraciones, capacitación), que sí tiene costo humano (8–24h).
- Alternativa perpetua si el cliente la exige: **one-time ≈ 1,8–2× el SaaS anual + 20% mantenimiento anual** (ej. Grande ~$18.000 + $3.600/año). Menos recomendable.

---

## Modelo 2 — Licencia CON administración mía (instancia dedicada por cliente)

Cada cliente tiene su **propio proyecto Supabase aislado** y **yo lo opero**. Mi costo = infra dedicada + humano. Framing v3 limpio: **Plan + Admin ($300) + add-on Aislamiento dedicado ($99)**.

### Mi costo por cliente

| Matrículas (1 cliente) | Infra dedicada (Supabase Pro + overage + ops del deploy) | Humano (admin, 1 tech : 8 clientes) | **Mi costo/mes** |
|---|---|---|---|
| 200 | $25 base + ~$5 ops = **~$30** | $225 | **~$255** |
| 1.000 | ~$30–40 | $225 | **~$255–265** |
| 3.000 | ~$45–60 (compute up + algo storage/egress) | $225 | **~$270–285** |
| 10.000 | ~$100–150 (egress + edge + compute Small + storage) | $225 | **~$325–375** |

*Nota:* el add-on de aislamiento en v3 estima "$25 infra + $50 ops" = $75 de costo dedicado; a 200–3.000 el componente infra queda cerca de eso, y crece con la escala del cliente.

### Precio y margen (bundle dedicado gestionado)

| Escala del cliente | Precio bundle (Plan + $300 Admin + $99 aislamiento) | Mi costo | **Margen $** | **Margen %** |
|---|---|---|---|---|
| 200 → Pequeña | $149 + $300 + $99 = **$548** | $255 | $293 | **53%** |
| 1.000 → Pequeña | **$548** | $260 | $288 | 53% |
| 3.000 → Mediana | $349 + $300 + $99 = **$748** | $278 | $470 | **63%** |
| 10.000 → Grande | $799 + $300 + $99 = **$1.198** | $350 | $848 | **71%** |
| >10.000 → Enterprise | desde $1.499 + $300 + $99 = **desde $1.898** | $400–600 | $1.300–1.500 | **~70%+** |

**Sub-variante "dedicada sin operación" (aislada pero self-service):** Plan + $99 aislamiento, **sin** el $300 de Admin. Mi costo baja a solo la infra dedicada ($30–150), sin humano. Ej. Grande: $799+$99 = $898, costo ~$130 → margen **86%**. Útil para un cliente que quiere aislamiento físico (Habeas Data/SOC2) pero tiene su propio equipo de TI.

**Observación de margen:** el modelo dedicado-gestionado es el de **menor margen %** (53–71%) porque carga el humano; pero es el de **mayor margen absoluto por cliente** ($288–$848) y el que habilita ventas Enterprise reguladas. No ofrecer en escala <200 (el $225 humano se come el spread).

---

## Modelo 3 — Independientes con mi administración (SaaS compartido multi-tenant)

Muchos clientes chicos sobre **un** Supabase + RLS. El costo NO escala por cliente sino por **uso agregado**. Aquí "escala" = **suma de matrículas de todos los tenants**.

### Mi costo total de infra (todos los clientes juntos)

| Matrículas TOTALES | Mi costo infra total/mes | $/matrícula/mes | $/1.000 matrículas/mes |
|---|---|---|---|
| 200 (arranque) | $51 | $0.255 | $255 |
| 1.000 | $51 | $0.051 | $51 |
| 3.000 | ~$53 (algo de edge) | $0.018 | ~$18 |
| 10.000 | ~$90 (+egress +Lambda) | $0.009 | ~$9 |
| *(ref.)* 25.000 | ~$180 | $0.007 | ~$7 ← óptimo |

### Margen según cómo se venden esas matrículas

Ejemplos ilustrativos (mismo costo infra total, distinto revenue según empaquetado en planes v3, modalidad AUTO):

| Escala total | Composición ejemplo | Revenue/mes | Mi costo infra | **Margen $** | **Margen %** |
|---|---|---|---|---|---|
| 200 | 1× Pequeña | $149 | $51 | $98 | **66%** |
| 1.000 | 1× Pequeña (llena) | $149 | $51 | $98 | 66% |
| 1.000 | 5× Pequeña (200 c/u) | $745 | $51 | $694 | **93%** |
| 3.000 | 3× Pequeña (1k c/u) | $447 | $53 | $394 | 88% |
| 3.000 | 1× Mediana (llena) | $349 | $53 | $296 | 85% |
| 10.000 | 10× Pequeña (1k c/u) | $1.490 | $90 | $1.400 | **94%** |
| 10.000 | 1× Grande (llena) | $799 | $90 | $709 | 89% |

**Observación:** cuantos **más clientes chicos** repartan las matrículas, **mayor el margen %** (el $51 fijo se diluye sobre más suscripciones). El punto de eficiencia de costo está en 10k–25k matrículas totales ($0.007–0.009/matrícula). El único salto brusco es a 50k (Supabase Team $599, solo si un Enterprise exige SOC2 y lo paga).

---

## Tabla resumen comparativa de los 3 modelos

| Dimensión | 1 · Licencia self-host | 2 · Licencia dedicada gestionada | 3 · SaaS compartido |
|---|---|---|---|
| **Mi costo de infra** | **~$0** | Alto: $255–375/cliente (infra $30–150 + humano $225) | Muy bajo: marginal $0.007–0.05/matrícula sobre $51 fijo |
| **Aislamiento** | Físico (infra del cliente) | Físico (Supabase por tenant) | Lógico (RLS) |
| **Precio típico** | $1.000–6.000/año + setup | $548–$1.898/mes (bundle) | $149–$799/mes (plan) |
| **Margen bruto %** | ~100% (menos amortización dev) | 53–71% (86% si sin operar) | 66–94% |
| **Margen absoluto/cliente** | Medio-bajo ($83–500/mes equiv.) | **Alto** ($288–$848/mes) | Bajo-medio ($98–$709/mes) |
| **Carga operativa mía** | Nula (solo releases + soporte de licencia) | **Alta** (yo opero cada instancia) | Media (opero 1 plataforma para todos) |
| **Escalabilidad de mi tiempo** | Excelente (no toco su infra) | Pobre (1 tech : 8 clientes; humano lineal) | Excelente (1 plataforma, N clientes) |
| **Riesgo de compliance** | Del cliente | Cubierto (aislamiento real) | **Mi riesgo** (Ley 1581/SOC2 si un cliente lo exige) |
| **Cuándo conviene** | Cliente con TI propio, exige control/residencia total, o presupuesto CAPEX | Universidad grande/regulada que exige aislamiento **y** que yo opere (Habeas Data, SOC2) | Colegios/academias/institutos chicos y medianos, alto volumen de clientes, venta rápida self-service |

---

## Recomendación de mix

**Base del negocio → Modelo 3 (SaaS compartido).** Es donde el margen % es más alto (89–94% con varios clientes), el costo marginal es casi nulo y mi tiempo escala. Debe ser el **70–80% de la cartera** en número de clientes: colegios, academias e institutos que caben en Pequeña/Mediana sin exigir aislamiento físico.

**Palanca de margen absoluto → Modelo 2 (dedicada gestionada), acotado.** Reservarlo para los **pocos** clientes grandes/regulados (Grande/Enterprise) que exigen aislamiento físico **y** operación. A esa escala el margen absoluto ($848–$1.500/cliente) justifica el humano y el margen % sigue en 70%+. **No** ofrecerlo bajo 200 matrículas ni en Pequeña (el $225 humano destruye el spread). Es venta consultiva, ~**10–15%** de la cartera, pero puede aportar el 30–40% del revenue.

**Modelo 1 (licencia self-host) → oportunista, no core.** Úsalo cuando un cliente **rechaza** el SaaS por política de datos o quiere CAPEX en vez de OPEX. Margen ~100% y cero carga operativa, pero cede el revenue recurrente pleno y me ata a dar updates sin controlar su entorno. **≤10%** de la cartera; conviértelo en canal secundario, no en la propuesta por defecto.

**Regla de asignación práctica:**
- Cliente ≤3.000 matrículas, sin exigencia de aislamiento → **Modelo 3** (planes AUTO; ofrecer Admin +$300 si no tiene equipo).
- Cliente >3.000 con exigencia de Habeas Data/SOC2 y que quiere que yo opere → **Modelo 2** (Grande/Enterprise + aislamiento + admin).
- Cliente con TI propio que exige correr su infra, o política anti-SaaS → **Modelo 1** (suscripción de licencia anual + setup).

Todas las cifras derivan del costo fijo compartido de $51/mes, el marginal de $0.007–0.02/matrícula, los overages Supabase Pro y los precios/planes v3; ninguna los contradice.
# Costo de infraestructura por modelo de negocio — ExamLab

> Base: modelo v3 (`docs/costos/analisis/`). Moneda **USD/mes** salvo donde se indique anual. IA = **BYO** (cliente paga Gemini con su propia key → $0 para ExamLab). Videos por URL externa → no consumen storage. Costo fijo compartido actual ≈ **$51/mes** (Supabase Pro $25 + Lovable $25 + dominio $1; Lambda $0 free tier; Gemini $0).

## Premisa que corrige todo el documento: la infra es SIEMPRE mía

**No existe modalidad self-host. El cliente NUNCA hospeda su propia infraestructura ni corre su propio Supabase/AWS.** En los tres modelos yo (ExamLab) proporciono la infra, el software y las actualizaciones, y doy **soporte básico como SuperAdmin** (alta del tenant, licencias, incidencias, updates — incluido en TODOS los planes).

Los 3 modelos se diferencian por **QUIÉN ADMINISTRA el tenant** (la operación diaria: crear cursos, importar usuarios, configurar branding), **NO por quién pone la infra**:

1. **Sin administración mía** — mi infra + licencias; el **cliente auto-administra** su tenant (self-service). Yo solo doy soporte básico SuperAdmin. Equivale al plan **AUTO** del v3.
2. **Con administración mía** — mi infra + licencias + **yo opero el tenant** por el cliente. Equivale a **ADMINISTRADA** (+$300/mes).
3. **Independientes con mi administración** — sub-segmento de (2) para docentes/profesionales independientes o instituciones muy chicas, sobre mi infra **compartida**, con mi administración (ligera).

**Consecuencias transversales (invariantes):**

- **Mi costo de infra NUNCA es $0.** El piso es el ~$51/mes fijo compartido + marginal **$0.007–0.02/matrícula**. Lo que cambia entre modelos es la operación humana, no la infra.
- **El aislamiento (Habeas Data Ley 1581 / SOC2) se resuelve SIEMPRE en MI infra:** RLS lógico compartido (default) o **Supabase dedicado por tenant, gestionado por MÍ** (add-on **$99/mes**). Nunca en infra del cliente. La "migración a dedicado" es para que **YO** pueda ofrecer aislamiento físico, no para que el cliente hospede.
- **Todos los planes incluyen soporte básico SuperAdmin.** La diferencia "sin/con administración" es la OPERACIÓN del tenant (self-service vs. yo lo opero), no la infra ni el soporte básico.

Cómo se lee la escala de referencia (matrículas) en cada modelo:

- **Modelo 1 (sin admin):** matrículas = tamaño de *ese* cliente self-service → mi costo marginal de infra atribuido + soporte básico.
- **Modelo 2 (con admin):** matrículas = tamaño de *ese* cliente que yo opero → mi costo = infra + humano.
- **Modelo 3 (independientes):** clientes chicos sobre infra compartida, con admin ligera batcheada.

---

## Modelo 1 — Licencia SIN administración mía (cliente auto-administra)

Mi infra (compartida por RLS, o dedicada si contrata el add-on de aislamiento) + entrego las licencias. El **cliente administra su propio tenant**: crea cursos, gestiona usuarios, configura branding, todo self-service. Yo doy **soporte básico como SuperAdmin** (alta del tenant, licencias, incidencias, updates), **sin operación diaria**. Es el plan **AUTO** del v3.

**Mi costo = infra marginal atribuida sobre el $51 fijo + soporte básico mínimo (bajo, no dedicado).** No hay humano operativo asignado por cliente.

### Mi costo por cliente (infra compartida RLS)

| Matrículas (1 cliente) | Infra marginal atribuida | Soporte básico SuperAdmin (amortizado) | **Mi costo/mes** | Plan AUTO | Precio |
|---|---|---|---|---|---|
| 200 | ~$10 | ~$5 | **~$15** | Pequeña | $149 |
| 1.000 | ~$15 | ~$5 | **~$20** | Pequeña | $149 |
| 3.000 | ~$30 | ~$8 | **~$38** | Mediana | $349 |
| 10.000 | ~$80 | ~$10 | **~$90** | Grande | $799 |

*La infra marginal atribuida ya contempla la porción del $51 fijo + overages estimados (storage/egress/edge) que aporta ese cliente al pool compartido. El soporte básico es una asignación baja y no dedicada (respuesta a incidencias + updates), no un tech por cliente.*

### Precio y margen (modalidad AUTO)

| Escala del cliente | Plan / precio | Mi costo | **Margen $** | **Margen %** |
|---|---|---|---|---|
| 200 → Pequeña | $149 | $15 | $134 | **90%** |
| 1.000 → Pequeña | $149 | $20 | $129 | **87%** |
| 3.000 → Mediana | $349 | $38 | $311 | **89%** |
| 10.000 → Grande | $799 | $90 | $709 | **89%** |
| >10.000 → Enterprise | desde $1.499 | $200+ | $1.299+ | **~87%+** |

**Sub-variante "AUTO con aislamiento dedicado" (auto-administrada pero aislada):** Plan AUTO **+ add-on aislamiento $99**. El cliente sigue operando su tenant solo, pero su data vive en un **Supabase dedicado gestionado por mí** (no compartido por RLS). Mi costo sube ~$25–30 (base del segundo proyecto Supabase Pro + ops mínima de provisión — **sin** humano operativo). Ej. Grande AUTO + aislamiento: $799 + $99 = **$898**, costo ~$90 + $30 = **$120** → margen **87%**. Útil para el cliente con equipo de TI propio que exige aislamiento físico (Habeas Data/SOC2) pero no necesita que yo opere el día a día.

**Observación:** este es el modelo de **mayor margen % y menor carga operativa**, porque no hay humano por cliente. Mi único costo recurrente es la infra marginal (siempre >$0) + soporte básico. Es el core del negocio.

---

## Modelo 2 — Licencia CON administración mía (yo opero el tenant)

Mi infra + licencias + **yo administro el tenant por el cliente**: creo cursos, importo usuarios/cursos, configuro branding y emails, capacito docentes y doy soporte pleno. Es la modalidad **ADMINISTRADA** del v3 (**+$300/mes**).

**Mi costo = infra + humano operativo.** El humano validado con salarios Colombia 2026: tech mid remote ~$1.800/mes cargado, ratio realista **1 tech : 8 clientes admin** → **~$225/cliente/mes**.

### Mi costo por cliente

| Matrículas (1 cliente) | Infra atribuida (compartida RLS) | Humano (1 tech : 8) | **Mi costo/mes** |
|---|---|---|---|
| 200 | ~$10 | $225 | **~$235** |
| 1.000 | ~$15 | $225 | **~$240** |
| 3.000 | ~$30 | $225 | **~$255** |
| 10.000 | ~$80 | $225 | **~$305** |

### Precio y margen (modalidad ADMINISTRADA)

| Escala del cliente | Precio (Plan + $300 Admin) | Mi costo | **Margen $** | **Margen %** |
|---|---|---|---|---|
| 200 → Pequeña Admin | $149 + $300 = **$449** | $235 | $214 | **48%** |
| 1.000 → Pequeña Admin | **$449** | $240 | $209 | 47% |
| 3.000 → Mediana Admin | $349 + $300 = **$749** | $255 | $494 | **66%** |
| 10.000 → Grande Admin | $799 + $300 = **$1.499** | $305 | $1.194 | **80%** |
| >10.000 → Enterprise Admin | desde $1.499 + custom | $400–600 | $1.100–1.300+ | **~75%+** |

### Con aislamiento dedicado gestionado por mí (Admin + $99)

Para la universidad regulada que exige aislamiento físico **y** que yo opere. El aislamiento es siempre en **mi** infra (Supabase dedicado por tenant gestionado por mí), nunca en infra del cliente. Suma ~$25–30 de infra dedicada a mi costo.

| Escala | Precio (Plan + $300 Admin + $99 aislamiento) | Mi costo | **Margen $** | **Margen %** |
|---|---|---|---|---|
| 3.000 → Mediana | $349 + $300 + $99 = **$748** | $255 + $30 = $285 | $463 | **62%** |
| 10.000 → Grande | $799 + $300 + $99 = **$1.198** | $305 + $30 = $335 | $863 | **72%** |
| >10.000 → Enterprise | desde $1.499 + $300 + $99 = **desde $1.898** | $430–630 | $1.270–1.470 | **~70%+** |

**Observación de margen:** ADMINISTRADA es el modelo de **menor margen %** (47–80%) porque carga el humano, pero el de **mayor margen absoluto por cliente** ($209–$1.194) y el que habilita ventas Enterprise reguladas. **No ofrecer bajo 200 matrículas** en su forma dedicada (el $225 humano se come el spread de un plan chico) — para ese caso está el Modelo 3 con admin ligera.

---

## Modelo 3 — Independientes con mi administración (infra compartida, admin ligera)

Sub-segmento del Modelo 2 para **docentes/profesionales independientes o instituciones muy chicas**, sobre mi infra **compartida por RLS** (nunca dedicada a esta escala) y con **mi administración**. La diferencia con el Modelo 2 es la escala: cada cliente es tan pequeño (1–3 cursos) que la operación es **ligera y batcheada** — un tech atiende **muchos más** independientes que instituciones (ratio **1 : 20–25** en vez de 1:8), porque cada uno demanda poca operación.

**Mi costo = infra compartida marginal (muy baja) + humano de admin ligera (ratio alto → ~$60–90/cliente).** El aislamiento aquí es siempre lógico (RLS); a esta escala no aplica dedicado.

### Mi costo por cliente

| Perfil | Matrículas | Infra marginal | Admin ligera (ratio 1:20–25) | **Mi costo/mes** |
|---|---|---|---|---|
| Docente independiente | ≤100 | ~$3 | ~$72 (1:25) | **~$75** |
| Profesional / academia chica | ≤200 | ~$8 | ~$90 (1:20) | **~$98** |
| Instituto chico | ≤500 | ~$12 | ~$120 (1:15) | **~$132** |

### Precio y margen (packaging propuesto — extiende v3)

El v3 no publica un precio "independiente administrado": la modalidad Admin plena (+$300) NO es viable a esta escala (el humano dedicado destruiría el spread). Por eso se propone un **bundle de admin ligera** con recargo reducido sobre el plan chico. *Cifras propuestas, sujetas a validación comercial:*

| Perfil | Precio bundle propuesto (plan chico + admin ligera) | Mi costo | **Margen $** | **Margen %** |
|---|---|---|---|---|
| Docente independiente | Starter $79 + ~$120 admin ligera = **~$199** | $75 | $124 | **62%** |
| Profesional / academia chica | Pequeña $149 + ~$100 admin ligera = **~$249** | $98 | $151 | **61%** |
| Instituto chico | Pequeña $149 + ~$150 admin ligera = **~$299** | $132 | $167 | **56%** |

**Alternativa sin admin (auto-servicio puro):** si el independiente no necesita que yo opere, cae directo al **Modelo 1** (Starter $79 / Pequeña $149 AUTO), con margen ~85–90% y cero humano. Ofrecer siempre esta ruta primero; el bundle administrado es para quien no quiere/puede operar.

**Observación:** el margen % (56–62%) es sano gracias al ratio alto de admin ligera. Si un independiente empieza a demandar operación de institución (más cursos, más soporte), reclasificarlo al Modelo 2 pleno o subirlo de plan.

---

## Tabla resumen comparativa de los 3 modelos

| Dimensión | 1 · Sin administración mía (AUTO) | 2 · Con administración mía (ADMINISTRADA) | 3 · Independientes con mi admin |
|---|---|---|---|
| **Infra** | **Mía** (compartida RLS; dedicada opcional add-on) | **Mía** (compartida RLS; dedicada opcional add-on) | **Mía** (compartida RLS) |
| **Quién opera el tenant** | El cliente (self-service) | **Yo** (operación plena) | **Yo** (operación ligera/batcheada) |
| **Mi costo de infra** | Marginal $15–90/cliente (>$0 siempre) | Infra $10–80 + humano $225 = **$235–305** | Infra $3–12 + admin ligera $72–120 = **$75–132** |
| **Aislamiento** | Lógico (RLS) por defecto · **dedicado gestionado por MÍ** (+$99) | Lógico (RLS) · **dedicado gestionado por MÍ** (+$99) | Lógico (RLS) — dedicado no aplica a esta escala |
| **Soporte básico SuperAdmin** | Incluido | Incluido | Incluido |
| **Precio típico** | $149–$799/mes (plan AUTO) | $449–$1.898/mes (plan + $300 Admin [+ $99]) | ~$199–$299/mes (bundle propuesto) |
| **Margen bruto %** | **87–90%** | 47–80% (62–72% con aislamiento) | 56–62% |
| **Margen absoluto/cliente** | Medio ($129–$709/mes) | **Alto** ($209–$1.194/mes) | Bajo ($124–$167/mes) |
| **Carga operativa mía** | **Baja** (self-service + soporte básico) | **Alta** (yo opero cada tenant) | Media (admin ligera batcheada) |
| **Escalabilidad de mi tiempo** | Excelente (1 plataforma, N clientes) | Pobre (humano lineal, 1 tech : 8) | Buena (1 tech : 20–25 chicos) |
| **Riesgo de compliance** | Mío, cubierto: RLS o dedicado en mi infra | Mío, cubierto: RLS o dedicado en mi infra | Mío (RLS compartido) |
| **Cuándo conviene** | Cliente con equipo propio que quiere auto-servicio; grueso de colegios/academias/institutos | Universidad grande/regulada que quiere que yo opere (Habeas Data, SOC2) y/o no tiene equipo | Docente/profesional independiente o institución muy chica que quiere delegar la operación |

**Nota clave:** en las tres columnas la fila "Infra" dice **mía** y "Mi costo de infra" es **>$0** — no hay ninguna variante self-host. El aislamiento físico, cuando se requiere, siempre es un Supabase dedicado **gestionado por mí** (add-on $99), disponible como upsell tanto en Modelo 1 como en Modelo 2.

---

## Recomendación de mix

**Base del negocio → Modelo 1 (AUTO, sin administración mía).** Es donde el margen % es más alto (87–90%), la carga operativa es baja (soporte básico, sin humano por cliente) y mi tiempo escala sobre una sola plataforma compartida. Debe ser el **70–80% de la cartera** en número de clientes: colegios, academias e institutos que caben en Pequeña/Mediana/Grande y auto-administran su tenant. Upsell natural: aislamiento dedicado (+$99) para quien lo exija sin necesitar operación mía.

**Palanca de margen absoluto → Modelo 2 (ADMINISTRADA), acotado.** Reservarlo para los **pocos** clientes grandes/regulados (Grande/Enterprise) que quieren que yo opere el tenant **y** frecuentemente aislamiento físico. A esa escala el margen absoluto ($863–$1.400+/cliente con aislamiento) justifica el humano y el margen % sigue en 70%+. **No** ofrecer la forma dedicada bajo 200 matrículas (el $225 humano destruye el spread). Venta consultiva, ~**10–15%** de la cartera, puede aportar 30–40% del revenue.

**Nicho de captación → Modelo 3 (independientes con admin ligera).** Docentes y profesionales que quieren delegar la operación pero no llegan a escala institucional. Margen 56–62% gracias al ratio alto de admin batcheada. Útil como **puerta de entrada** y para monetizar el segmento independiente que de otro modo iría solo a Modelo 1 AUTO. ~**10–15%** de la cartera; vigilar que no consuma tiempo desproporcionado (si crece, reclasificar a Modelo 2).

**Regla de asignación práctica:**
- Cliente con equipo propio / que quiere auto-servicio, cualquier escala, sin exigencia de operación mía → **Modelo 1** (plan AUTO; +$99 aislamiento si exige Habeas Data/SOC2).
- Cliente >3.000 (o regulado) que quiere que **yo** opere el tenant → **Modelo 2** (plan + $300 Admin [+ $99 aislamiento dedicado gestionado por mí]).
- Docente/profesional independiente o institución muy chica que quiere delegar la operación → **Modelo 3** (infra compartida + bundle de admin ligera; si no necesita operación, cae a Modelo 1 AUTO).

Todas las cifras derivan del costo fijo compartido de $51/mes (infra **siempre mía**), el marginal de $0.007–0.02/matrícula, los overages de Supabase Pro y los precios/planes v3 (Pequeña $149 · Mediana $349 · Grande $799 · Administrada +$300 · aislamiento dedicado +$99 · storage extra $10/100 GB); ninguna los contradice. En ningún modelo el cliente hospeda infra propia.

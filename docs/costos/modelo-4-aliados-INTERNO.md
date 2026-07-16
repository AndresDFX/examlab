# 🔒 INTERNO — NO enviar al cliente

## Programa de Aliados (canal por comisión) — impacto en MI margen

> Uso interno. Espejo de [`programa-aliados-v3.md`](programa-aliados-v3.md) y [`interno-aliados-v3.md`](interno-aliados-v3.md). Presentación asociada: `ExamLab-Presentacion-Aliados.pptx`. Cifras base en [`modelo-precios-v3.md`](modelo-precios-v3.md), [`infra-por-modelo-negocio.md`](infra-por-modelo-negocio.md), [`add-ons.md`](add-ons.md). Moneda: USD/mes · locale es-CO.

---

## 1. Qué es el modelo

Canal de venta por comisión: un **aliado** trae clientes y gana un **porcentaje sobre el total que el cliente efectivamente paga** (suscripción + modalidad Administrada si aplica + add-ons recurrentes). Tres modalidades: **Referido 10 %** (pago único sobre el 1.er año), **Comercial 15 %** (recurrente) y **Premium 20 %** (recurrente, desde 5 instituciones, con co-branding). La infra es **siempre mía** (nunca self-host) y la comisión NO cambia mi costo de infra ni de operación: es un **costo de canal/adquisición que sale de mi margen bruto**. El punto de este documento es cuánto me cuesta la comisión y cuál es mi **margen neto** después de pagarla.

---

## 2. Mi costo por cliente por escala (infra + comisión de canal)

La comisión se apila **encima** del costo del plan subyacente (AUTO o Administrado). Aquí el costo de infra es idéntico al del modelo directo; la comisión es la capa nueva. Tomo **Comercial 15 %** como referencia (la modalidad más común); Referido y Premium se ven en §3.

### AUTO (IA = BYO ⇒ $0 IA para mí)

| Matrículas | Plan / precio | Infra | Comisión 15 % | **Mi costo total/mes** |
|---|---|---:|---:|---:|
| 200 | Pequeña $149 | ~$15 | $22 | **~$37** |
| 1.000 | Pequeña $149 | ~$20 | $22 | **~$42** |
| 3.000 | Mediana $349 | ~$38 | $52 | **~$90** |
| 10.000 | Grande $799 | ~$90 | $120 | **~$210** |

### ADMINISTRADA (+$300, humano ~$225 con ratio 1 tech : 8)

| Matrículas | Precio (plan + $300) | Infra + humano | Comisión 15 % | **Mi costo total/mes** |
|---|---|---:|---:|---:|
| 3.000 | Mediana Admin $749 | ~$255 | $112 | **~$367** |
| 10.000 | Grande Admin $1.499 | ~$305 | $225 | **~$530** |

> La comisión se calcula sobre el total facturado y **cobrado**, así que la modalidad Administrada (+$300) y los add-ons recurrentes también entran a la base — el aliado gana más y yo pago más comisión en clientes grandes/administrados.

---

## 3. Precio y MARGEN neto por escala (contra precios v3)

Margen neto = margen bruto (precio − costo infra [+ humano]) − comisión. Las tres modalidades comparadas:

### AUTO

| Escala → Plan | Precio | Margen bruto | **Neto Referido 10 %** (año 1) | **Neto Comercial 15 %** | **Neto Premium 20 %** |
|---|---:|---:|---:|---:|---:|
| 1.000 → Pequeña | $149 | $129 (87 %) | ~$114/mes año 1 → $129 luego (77 %→87 %) | **$107 (72 %)** | **$99 (66 %)** |
| 3.000 → Mediana | $349 | $311 (89 %) | ~$276/mes año 1 → $311 luego (79 %→89 %) | **$259 (74 %)** | **$241 (69 %)** |
| 10.000 → Grande | $799 | $709 (89 %) | ~$629/mes año 1 → $709 luego (79 %→89 %) | **$589 (74 %)** | **$549 (69 %)** |

*Referido: 10 % del total del 1.er año en pago único (Grande = $9.588/año → ~$959 una vez); amortizado baja el margen del año 1 y desaparece del año 2 en adelante.*

### ADMINISTRADA (Grande Admin $1.499, margen bruto $1.194 = 80 %)

| Modalidad | Comisión | **Mi margen neto** | Margen neto % |
|---|---:|---:|---:|
| Sin aliado (directa) | $0 | $1.194 | 80 % |
| Comercial 15 % | $225 | **$969** | **65 %** |
| Premium 20 % | $300 | **$894** | **60 %** |

**Lectura:** incluso con **Premium 20 %** el margen neto se mantiene **≥60 %** en todas las escalas — el programa es sostenible. La comisión reemplaza el ~$1.000 de CAC de la venta directa: en clientes que yo **no habría alcanzado**, la comisión es margen incremental puro, no una pérdida de margen.

---

## 4. Costo de IA para MÍ + topes (cuando el cliente del aliado toma IA administrada)

Por defecto los clientes del aliado van **BYO** (usan su propia clave Gemini y pagan a Google) → **$0 de IA para mí**. Pero si el cliente toma el add-on **IA administrada ($0,10/matrícula/mes)**, ese ingreso también entra a la base de comisión, así que la comisión **muerde el margen ya delgado del add-on**:

| Concepto (por matrícula/mes) | Valor |
|---|---:|
| Cobro IA administrada | $0,10 |
| Mi costo Gemini (uso típico) | ~$0,062 |
| Comisión 15 % sobre el $0,10 | $0,015 |
| **Margen neto típico** | **~$0,023 (23 %)** |
| Mi costo Gemini (uso intensivo) | ~$0,20 → **pérdida** aun antes de comisión |

**Topes obligatorios (contrato + enforcement):** 30 mensajes de Tutor IA + 6 calificaciones por matrícula/mes; al superar, se corta la IA in-app hasta el mes siguiente (o overage $0,15/matr). Regla de canal: **priorizar BYO en clientes traídos por aliados**; ofrecer IA administrada solo con el tope firmado. Nunca cotizar IA administrada intensiva + comisión sin tope — la comisión convierte un margen de 38 % (directo) en 23 %, y el uso intensivo en pérdida amplificada.

---

## 5. Palancas de descuento y piso de margen

**No apilar descuentos publicables con comisión Premium sobre planes chicos.** La comisión ya es un descuento efectivo sobre mi margen; sumarle −20 % educación pública o −15 % multi-año puede cruzar el piso.

| Caso | Precio cobrado | Infra | Comisión | Neto | ¿OK? |
|---|---:|---:|---:|---:|---|
| Pequeña + Comercial 15 % | $149 | $20 | $22 | $107 (72 %) | ✅ |
| Pequeña + Premium 20 % | $149 | $20 | $30 | $99 (66 %) | ✅ |
| Pequeña −20 % edu + Premium 20 % | $119 | $20 | $24 | $75 (63 % del cobrado) | ⚠️ límite |
| Pequeña −20 % edu −10 % anual + Premium 20 % | ~$107 | $20 | ~$21 | ~$66 (44 % vs lista) | ❌ no |

**Piso operativo:** margen neto ≥ 50 % del precio de lista. Regla práctica: en clientes con comisión **Premium**, limitar a **un** descuento publicable (o ninguno) y nunca sobre Starter/Pequeña.

**Cuándo conviene / cuándo NO vender por canal:**
- **Referido (10 %, único)** = el más barato para mí; pago solo el 1.er año y después el cliente es 100 % mío. Preferir para clientes que el aliado solo "presenta".
- **Comercial (15 %)** = default sano; margen neto 65–74 % en todas las escalas.
- **Premium (20 %)** = reservar para aliados que traen **volumen real (5+ instituciones)**; el volumen compensa el punto extra. No dar Premium a un aliado con 1 cliente chico.
- **NO combinar** canal + servicio administrado + IA administrada intensiva + descuento profundo en el mismo cliente sin recalcular el neto — es el escenario donde el margen se erosiona en capas.

---

## 6. Riesgos operativos

- **Comisión sobre lo cobrado, no sobre lo facturado:** protege el cashflow, pero exige disciplina de conciliación (facturación ↔ cobro ↔ liquidación al aliado). Un error de conciliación paga comisión sobre impagos.
- **Atribución del cliente:** disputas sobre "quién trajo al cliente" (dos aliados, o aliado vs. lead directo). Necesita registro de referidos con fecha y cierre documentado en contrato.
- **Comisión recurrente perpetua (Comercial/Premium):** la pago mientras el cliente renueve, incluso años después. El neto sigue ≥60 %, pero es una cola larga de costo; revisar en renovaciones si el aliado sigue aportando o si conviene migrar a esquema Referido.
- **Presión a sobre-descontar:** el aliado gana comisión sobre el total, así que le conviene subir el ticket, pero para cerrar puede empujar descuentos que erosionan **mi** margen sin tope. Fijar techo de descuento por rol de aliado.
- **IA administrada en la base:** doble efecto (comisión sobre un add-on de margen fino) — controlar con tope duro obligatorio.
- **Soporte/operación sigue siendo mía:** el aliado vende, no opera. Si el cliente es AUTO, doy soporte básico SuperAdmin; si es Administrado, cargo el humano ($225). El aliado no reduce mi carga operativa — solo el CAC.
- **Premium con co-branding:** riesgo reputacional si el aliado usa mal la marca; regular en contrato (uso de logo, mensajería, exclusividad territorial si aplica).

---

---

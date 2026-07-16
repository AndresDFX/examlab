# 🔒 INTERNO — homólogo de la presentación comercial v3

> **Uso interno (NO mostrar al cliente).** Documento espejo de
> [`../../demos/presentacion/ExamLab-Presentacion-Comercial-v3.pptx`](../../demos/presentacion/ExamLab-Presentacion-Comercial-v3.pptx):
> por cada tema que el deck muestra al cliente, acá está **mi costo real y mi margen**.
> Cifras base en [`modelo-precios-v3.md`](modelo-precios-v3.md), [`analisis-infra-2026.md`](analisis-infra-2026.md),
> [`add-ons.md`](add-ons.md), [`infra-por-modelo-negocio.md`](infra-por-modelo-negocio.md). USD/mes.

## 1. Planes — precio cliente vs. mi costo/margen (modalidad AUTO)

El cliente ve solo el precio. Yo veo esto (infra siempre mía; IA=BYO ⇒ $0 IA para mí):

| Plan | Precio | Mi costo infra | Margen $ | Margen % |
|---|---|---|---|---|
| Pequeña | $149 | ~$15–20 | ~$130 | **~88%** |
| Mediana | $349 | ~$38 | ~$311 | **~89%** |
| Grande | $799 | ~$90 | ~$709 | **~89%** |
| Enterprise | desde $1.499 | $200+ | $1.299+ | ~87%+ |

Modalidad **Administrada +$300**: suma ~$225 de costo humano (1 tech : 8 clientes) → margen operativo ~$75 sobre el humano; ver [`infra-por-modelo-negocio.md`](infra-por-modelo-negocio.md).

## 2. ⚠️ Costo de IA para MÍ (cuando NO es BYO / cuando yo administro)

El deck cliente dice "recargo de IA en tu plan: $0" — **eso es cierto SOLO en BYO** (el cliente
paga Google/OpenAI directo). Pero en dos casos **la IA sí me cuesta a MÍ**:

1. **Add-on "IA administrada"** — yo gestiono la clave y pago el consumo de Gemini.
2. **Clientes administrados** que además toman IA administrada (típico: institución sin equipo técnico).

**Mi costo de IA (Gemini Flash) por escala** — lo pago yo a Google:

| Matrículas | Uso típico (~$0.062/matr) | Uso intensivo (~$0.20/matr) | Cobro (IA admin $0.10/matr) | Margen típico | Margen intensivo |
|---|---:|---:|---:|---:|---:|
| 200 | ~$12 | ~$40 | $20 | +$8 (40%) | **−$20 (pérdida)** |
| 1.000 | ~$62 | ~$200 | $100 | +$38 (38%) | **−$100 (pérdida)** |
| 3.000 | ~$186 | ~$600 | $300 | +$114 (38%) | **−$300 (pérdida)** |
| 10.000 | ~$620 | ~$2.000 | $1.000 | +$380 (38%) | **−$1.000 (pérdida)** |

**Conclusión operativa:**
- En **uso típico** la IA administrada deja ~38% de margen. En **uso intensivo se vuelve PÉRDIDA**.
- **Protección obligatoria (contrato + enforcement técnico):** tope de **30 mensajes de Tutor IA + 6 calificaciones por matrícula/mes**. Al superarlo, se corta la IA in-app hasta el mes siguiente (o se cobra overage $0.15/matr extra). Sin este tope, un cliente intensivo me hace perder dinero.
- **Empujar BYO por defecto** (IA administrada solo a quien no tenga equipo técnico y acepte el tope). En las primeras 20 firmas priorizar BYO para blindar margen.
- En **modelo administrado + IA administrada**, mi costo total por cliente = infra (~$15–90) + humano (~$225) + **IA ($12–620 típico)**. Cotizar sumando la IA como línea aparte (o exigir BYO).

## 3. Storage — costo vs. cobro

Cliente ve el soft-cap por plan (50/100/200 GB) + extra $10/100GB. Mi realidad:
- Costo real Supabase: **$2,13/100GB**. Cobro **$10/100GB** → margen **79%**.
- El cap incluido cubre >99% (uso real 3–7 MB/matrícula). Ver [`almacenamiento-esperado.md`](almacenamiento-esperado.md).

## 4. Comparativa / ahorro (lo que NO digo)

El deck muestra ahorro 78–92% vs Canvas/Blackboard. Interno: ese "ahorro" es mi espacio de captura de precio — hay margen para subir en negociación con clientes grandes sin perder la ventaja. No revelar mis costos ($51 fijo + marginal) que sustentan el 87–91%.

## 5. Regla de cotización rápida

- BYO (default) → mi costo IA = $0. Cobrar el plan tal cual.
- IA administrada o administrado-con-IA → **sumar mi costo de IA (§2)** al costeo y verificar que el tope esté en el contrato. Nunca cotizar IA administrada intensiva sin tope.

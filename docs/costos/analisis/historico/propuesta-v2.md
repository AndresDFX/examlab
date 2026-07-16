# Propuesta económica — v2 (segmentación por tamaño de institución)

> **v2** de las propuestas comerciales. Reemplaza la grilla v1 (Esencial 250 / Profesional 1.500 /
> Institucional 5.000) por 3 franjas alineadas a la realidad del mercado educativo.
> Basada en los datos reales de [analisis-costos.md](analisis-costos.md) (prod verificada 2026-07-07).
> **Fecha:** 2026-07-15 · Precios de terceros (Google/Supabase) sujetos a cambio — reverificar antes de cotizar en firme.

## 0. Qué cambió y por qué

El cliente (Jefferson Bedoya) pidió re-segmentar con criterios de mercado reales:

- **PEQUEÑA:** hasta **1.500** · **MEDIANA:** hasta **10.000** · **GRANDE:** más de **10.000**.
- Realidad que lo motiva: **una sola carrera** tipo Ing. de Sistemas = 10 semestres × 6 materias × ~50 cupos = **~3.000 cupos-materia por ciclo**. Las instituciones manejan **varias carreras y varios ciclos** y **aún así no son "grandes"**. Los planes v1 subdimensionan: 5.000 ya es apenas mediana.

**Hallazgo central que gobierna toda la propuesta:** la **infraestructura NO es la restricción** — un Supabase Pro de ~$25/mes cubre HOY las 6 instituciones, el storage cabe en los 100 GB incluidos hasta ~62 GB (5.000), y sumar una institución cuesta ~$0 marginal. **El único costo variable relevante de ExamLab es la IA**, y su magnitud la define la **intensidad de uso**, no el tamaño.

> A precio auto-administrado, la IA en uso **TÍPICO** ($0,062/matrícula/mes) consume **~31 %** del ingreso por asiento (absorbible), pero en uso **INTENSIVO** ($0,20/matrícula) consume **~100 %** y **rompe el margen en cualquier franja**. Por eso la palanca de diseño es **quién paga la IA**, no cuánta infra se vende.

## 1. Métrica de facturación (decisión clave)

**Facturar por MATRÍCULAS / cupos-materia activos por período — NO por estudiantes únicos (cabezas).**

El costo variable (IA) escala con **entregas y mensajes de tutor**, que ocurren **por matrícula-materia**, no por cabeza. Un alumno en 6 materias genera ~6× la carga de IA que uno en 1 materia. Los **~3.000 de una carrera son cupos-materia**, no personas.

- Definir el tope de cada franja en **matrículas activas concurrentes por período**.
- Documentar en contrato "matrícula activa" = inscripción a materia con acceso a la plataforma en el período de facturación.
- Si el cliente exige cobrar por cabezas (simplicidad comercial), aplicar un **factor matrículas/cabeza** (típico 4–6 en educación superior) para no subfacturar.
- Modelo recomendado: **base + precio por matrícula-seat** (~$0,15–0,30/seat/mes) que reproduce la tabla y alinea precio con el driver real de costo.

## 2. Planes v2 (USD/mes)

| Franja | Rango (matrículas) | Auto-administrada | Administrada | Costo ExamLab (típico · intensivo · BYO) | Margen auto (típico) | ¿IA incluida? |
|---|---|---|---|---|---|---|
| **Pequeña — entrada** | ≤ 500 | **$149** | **$349** | $35 · $104 · $4 | $114 (77 %) | Sí, con tope |
| **Pequeña — techo** | 501–1.500 | **$299** | **$649** | $97 · $304 · $4 | $202 (68 %) | Sí, con tope (envelope típico) |
| **Mediana — baja** (~3.000, 1 carrera) | 1.501–5.000 | **$599** | **$1.199** | $211 · $625 · $25 | $388 (65 %) | Incluida con cap (≤5.000) |
| **Mediana — alta** (~10.000) | 5.001–10.000 | **$1.499** | **$2.499** | $645,50 · $2.025,50 · $25,50 | $853,50 (57 %) | BYO por defecto / add-on medido |
| **Grande** (~20.000) | > 10.000 | **$2.500** | **$4.900** | $1.282 · $4.042 · $42 | $1.218 (49 %) | BYO por defecto; IA administrada solo medida |

**Cómo leer la tabla:**
- *Auto-administrada* = la institución administra su instancia; *administrada* = ExamLab la opera (el margen de administrada **no** descuenta la mano de obra de operación — el margen real es menor pero amplio).
- *Costo ExamLab* = infra + storage + IA. **Típico** = adopción madura realista (2 exám + 4 talleres + 0,5 proy + 20 msgs tutor/mes por matrícula). **Intensivo** = techo (Gemini Pro + 60 msgs tutor/mes) — define el **riesgo**, no el caso realista. **BYO** = la institución paga la IA directo a Google → costo de IA de ExamLab **$0**.
- Con **BYO API key** el margen sube a **96–99 %** en toda franja.
- Descuento por volumen (auto): ~$0,40/matrícula (entrada) → **$0,125/matrícula** (Grande).

## 3. Costo–beneficio por franja

La infraestructura es casi gratis y constante; el driver económico es **100 % la IA**.

- **Pequeña (@1.500):** costo ~$97/mes (infra $4 + IA típica $93). Auto $299 → **margen $202 (68 %)**; administrada $649 → **$552 (85 %)**. Único punto negativo de toda la propuesta: auto + IA absorbida + **intensivo** ($304) → −$5 (−2 %) — escenario techo improbable, justifica BYO como default.
- **Mediana baja (@3.000 = una carrera):** costo $211/mes (infra $25 + IA típica $186). Auto $599 → **$388 (65 %)**; administrada $1.199 → **$988 (82 %)**. Intensivo absorbido ($625) → auto en pérdida (−4 %). BYO → 96–98 %.
- **Mediana alta (@10.000):** costo $645,50/mes. Auto $1.499 → **$853,50 (57 %)**; administrada $2.499 → **$1.853,50 (74 %)**. Intensivo absorbido ($2.025,50) → auto −35 %, solo la administrada aguanta (+19 %). Storage excedente a 10.000 = apenas **$0,50/mes**.
- **Grande (@20.000):** fijo infra+storage $42 + IA típica $1.240 = $1.282/mes. Auto $2.500 → **$1.218 (49 %)**; administrada $4.900 → **$3.618 (74 %)**. **Hallazgo crítico:** con IA intensiva absorbida el costo de IA solo ($4.000) **supera el precio del plan** — a esta escala la IA **no puede ir incluida sin techo**. BYO → 98–99 %.

**Conclusión:** en el escenario **típico** (el realista) los márgenes son **57–95 %** en toda la escala. El escenario **real medido hoy** es aún más favorable (IA de $0,85–$34/mes). El riesgo de margen está **concentrado exclusivamente** en absorber IA a intensidad intensiva sobre planes auto-administrados; se neutraliza con **BYO** o **tope de consumo**.

## 4. Política de IA por franja (¿la paga el cliente o va incluida?)

Modelo: **"incluida hasta un sobre de consumo (envelope típico) con tope duro; por encima, BYO o add-on medido"**.

- **Pequeña (≤1.500): IA INCLUIDA por defecto.** Absorber ~$93/mes (típico) es barato como gancho de adquisición y diferenciador. Tope mensual por matrícula (~$0,07 = envelope típico) + cola **async** para amortiguar picos. Nunca ilimitada: un intensivo ($300) ya supera el plan ($299).
- **Mediana (≤10.000): mixta.** Incluida-con-cap en la banda baja (≤~5.000); en la banda alta (5.000–10.000) **BYO por defecto** o add-on medido. Absorber $620–$2.000/mes amenaza el margen; a este tamaño el cliente gestiona su propio billing sin fricción. Posicionar BYO como **"control de costos y datos"**, no como recorte.
- **Grande (>10.000): BYO API key por DEFAULT** — ExamLab $0 de IA, sin exposición a picos. IA administrada solo como **add-on medido** (consumo real Gemini + markup 30–50 %). Empaquetar con el tier **Enterprise/regulado** (Supabase dedicado ya incluido → aislamiento como valor).

**Transversal:** el toggle **sync/async** de la cola de IA es la palanca operativa para contener picos (mantener en `async` con tope activo donde la IA va incluida). La lista de **fallback keys** ya implementada mitiga el agotamiento de cuota en BYO (requiere monitoreo + aviso al cliente).

## 5. Cambios vs v1

1. **Eje de segmentación:** de "cuánta infra" (casi gratis) a **"cuántas matrículas + qué intensidad de IA"**.
2. **Se cierra el vacío >5.000:** v1 topaba en 5.000 ($1.000/$1.900); se añaden Mediana-alta ($1.499/$2.499 @10.000) y Grande ($2.500/$4.900 @20.000).
3. **Precios:** Esencial(250) desaparece → absorbido en Pequeña con entrada opcional $149/$349 (≤500). Profesional(1.500) se conserva como techo de Pequeña. Institucional(5.000) se reemplaza por la escala Mediana.
4. **Política de IA explícita por franja** (antes implícita).
5. **Métrica formalizada:** matrículas/cupos, no "estudiantes" (ambiguo), documentado en contrato.
6. **Aislamiento:** en v2 el Supabase dedicado va **incluido de facto en Grande** (a 20.000 ya se necesita por egress/aislamiento) — valor del tier, no cargo extra.

## 6. Riesgos

- **IA intensiva absorbida rompe el margen en TODAS las franjas** (~100 % del ingreso por asiento). Sin tope duro, un solo cliente intensivo da margen negativo (Pequeña $304 > $299; Grande $4.042 > $2.500). Mitigación: BYO por defecto en franjas altas + tope+async donde va incluida.
- **Métrica cabezas vs matrículas:** cobrar por cabezas subfactura el driver real. Fijar por matrículas **antes de firmar**.
- **Cambio de precio de Google:** el intensivo asume Gemini Pro (~8× Flash). Un alza de Google impacta directo el margen del escenario "IA incluida".
- **Subdimensión del rango extrapolado (>5.000):** validar con 1–2 clientes piloto antes de publicar la lista.
- **Fricción de BYO:** traslada costo pero añade soporte (rotación/agotamiento de cuota). Mitigado por fallback keys; requiere monitoreo.
- **Percepción de BYO como recorte:** posicionar como control de costos/datos + siempre ofrecer add-on medido administrado.
- **Concentración de infra / egress:** una institución Grande (o que suba video pesado en vez de URL externa) puede superar egress/edge incluidos → proyecto dedicado desde Mediana-alta; mantener grabaciones como URL externa.
- **Margen de "administrada" sobrestimado:** las cifras no descuentan la mano de obra de operación; dimensionarla antes de comprometer el precio administrado.

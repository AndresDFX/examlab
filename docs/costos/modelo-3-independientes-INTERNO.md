# 🔒 INTERNO — NO enviar al cliente
## Modelo: Docentes/profesionales independientes con mi administración (ligera)

> Uso interno. Contiene mis costos, márgenes y topes. Cifras base en [`infra-por-modelo-negocio.md` §Modelo 3](infra-por-modelo-negocio.md), [`modelo-precios-v3.md`](modelo-precios-v3.md), [`add-ons.md`](add-ons.md), [`almacenamiento-esperado.md`](almacenamiento-esperado.md). Los precios de bundle son **propuestos, sujetos a validación comercial** (el v3 no publica un precio "independiente administrado").

## 1. Qué es este modelo

Sub-segmento del modelo Administrado (Modelo 2) pensado para **docentes o profesionales independientes e instituciones muy chicas** (1–3 cursos, ≤500 matrículas), sobre mi infra **compartida por RLS** (nunca dedicada a esta escala), donde **yo opero el tenant pero de forma ligera y batcheada**. La diferencia clave con el Modelo 2 pleno es el **ratio humano**: como cada cliente demanda muy poca operación, un tech atiende **1:20–25 independientes** (en vez de 1:8 instituciones), lo que baja el costo humano por cliente de ~$225 a ~$60–120 y mantiene el margen sano pese al precio bajo. El aislamiento físico no aplica a esta escala; el compliance se cubre siempre con RLS compartido en mi infra.

## 2. Mi costo por cliente por escala

Infra marginal (muy baja) + humano de admin ligera batcheada. IA = BYO ⇒ **$0 de IA para mí** salvo que tome el add-on administrada (ver §4).

| Perfil | Matrículas | Infra marginal | Admin ligera (ratio) | **Mi costo/mes** |
|---|---|---:|---:|---:|
| Docente independiente | ≤100 | ~$3 | ~$72 (1:25) | **~$75** |
| Profesional / academia chica | ≤200 | ~$8 | ~$90 (1:20) | **~$98** |
| Instituto chico | ≤500 | ~$12 | ~$120 (1:15) | **~$132** |

**Nota sobre los puntos de escala estándar (200 / 1.000 / 3.000 / 10.000):** este modelo **solo aplica hasta ~500 matrículas**. En el punto de 200 el costo es ~$98 (perfil "profesional/academia chica"). **A partir de ~1.000 matrículas el cliente deja de ser "independiente"** y se reclasifica al Modelo 1 (AUTO, plan Pequeña $149+) o al Modelo 2 pleno (Administrada +$300) — no se debe operar un cliente de 1.000/3.000/10.000 con admin ligera batcheada porque el ratio 1:20–25 se rompe (más cursos, más soporte) y el humano se dispara. Regla dura: **si un independiente pide operación de institución, reclasificarlo hacia arriba, no absorberlo en este bundle.**

## 3. Precio y margen por escala (bundle propuesto)

Bundle = plan chico (Starter $79 / Pequeña $149) + recargo de **admin ligera** reducido (NO el +$300 de la Administrada plena, que destruiría el spread a esta escala).

| Perfil | Bundle propuesto | Precio | Mi costo | **Margen $** | **Margen %** |
|---|---|---:|---:|---:|---:|
| Docente independiente | Starter $79 + ~$120 admin ligera | **~$199** | $75 | $124 | **62%** |
| Profesional / academia chica | Pequeña $149 + ~$100 admin ligera | **~$249** | $98 | $151 | **61%** |
| Instituto chico | Pequeña $149 + ~$150 admin ligera | **~$299** | $132 | $167 | **56%** |

**Ruta alternativa de mayor margen (ofrecer SIEMPRE primero):** si el independiente **no necesita** que yo opere, cae directo al **Modelo 1 AUTO** (Starter $79 o Pequeña $149 self-service), donde mi costo es solo infra (~$15–20), **margen 85–90% y cero humano**. El bundle administrado ligero es la excepción para quien no quiere/puede operar, no el default.

- Margen absoluto por cliente ($124–$167/mes) es **bajo** — este modelo es **puerta de entrada y nicho de captación (~10–15% de la cartera)**, no motor de revenue.
- Margen % (56–62%) es sano **solo mientras se sostenga el ratio 1:20–25**. Si un tech termina atendiendo <15 independientes por consumir demasiada operación, el margen cae por debajo del 50% → señal de reclasificar o subir precio.

## 4. Costo de IA para MÍ (solo si toma IA administrada)

Por defecto es **BYO** (el docente paga a Google con su propia clave de Gemini, ~$0,06/matrícula típico) → **$0 de IA para mí**. Si el independiente no tiene equipo técnico y toma el add-on **IA administrada ($0,10/matrícula/mes)**, la IA me cuesta a mí:

| Matrículas | Costo típico (~$0,062/matr) | Costo intensivo (~$0,20/matr) | Cobro IA admin ($0,10/matr) | Margen típico | Margen intensivo |
|---|---:|---:|---:|---:|---:|
| 100 | ~$6,2 | ~$20 | $10 | +$3,8 (38%) | **−$10 (pérdida)** |
| 200 | ~$12,4 | ~$40 | $20 | +$7,6 (38%) | **−$20 (pérdida)** |
| 500 | ~$31 | ~$100 | $50 | +$19 (38%) | **−$50 (pérdida)** |

**Topes obligatorios (contrato + enforcement técnico):** **30 mensajes de Tutor IA + 6 calificaciones por matrícula/mes**. Al superarlo, se corta la IA in-app hasta el mes siguiente, o se cobra overage **$0,15/matrícula extra**. A esta escala el segmento es especialmente propenso a uso intensivo por matrícula (cursos chicos, alumnos muy activos con el Tutor) → **nunca vender IA administrada sin el tope firmado**. Empujar BYO por defecto.

## 5. Palancas de descuento y piso de margen

| Palanca | Efecto | ¿Aplica a este modelo? | Piso de margen resultante |
|---|---|---|---|
| **-10% pago anual** | Mejora cashflow, reduce churn | **Sí** — recomendado (el independiente valora el flujo predecible) | Docente ~$104 (52%) · Instituto chico ~$137 (49%) |
| **-30% early adopter** (1er año, primeros 5 por franja) | Captación | Con cuidado — combinado con anual erosiona mucho | Docente a −30%: ~$139 precio, costo $75 → margen $64 (**46%**). **Piso aceptable solo como gancho de 1er año.** |
| **-15% multi-año** | Blinda pricing | **No** (reservado a Mediana/Grande/Enterprise) | — |
| **-20% educación pública** | Mercado estatal | **No** típico en independientes | — |

**Cuándo NO vender (o reclasificar):**
- **No** ofrecer Administrada plena (+$300) a esta escala — el humano dedicado se come todo el spread (ver "Starter Admin NO VIABLE" en v3).
- **No** apilar early-adopter -30% + anual -10% en el perfil docente ≤100: el margen combinado cae bajo 40% → no vale la operación.
- Si el cliente exige aislamiento dedicado, SSO o code runner intensivo → **ya no es un independiente**: cotizarlo como Modelo 1/2 con add-ons.

**Cuándo SÍ conviene:** docente/profesional que quiere delegar la operación (no tiene tiempo ni equipo TI), acepta infra compartida (RLS) e IA en BYO. Sirve como **top of funnel**: monetiza el segmento independiente que de otro modo iría solo al AUTO, y algunos escalan a institución con el tiempo.

## 6. Riesgos operativos

1. **Erosión del ratio (el riesgo #1):** el bundle solo es rentable si se sostiene 1:20–25. Un puñado de independientes "necesitados" (soporte constante, muchos cursos) baja el ratio efectivo y convierte el margen 56–62% en pérdida de tiempo. **Mitigación:** SLA de admin ligera acotado por contrato (p. ej. X horas/mes de operación incluidas); excedente → upgrade a Modelo 2.
2. **IA administrada intensiva sin tope = pérdida directa** (§4). Enforcement técnico del tope es no negociable.
3. **Cobros chicos, costo de facturación/cobranza fijo:** $199–$299/mes deja poco colchón para fricción administrativa (impuestos, pasarela, morosidad). Preferir pago anual anticipado para amortizar el costo de gestión de la cuenta.
4. **CAC vs. contract value:** con ganancia $124–$167/mes, un CAC alto no se recupera rápido. **Priorizar canales de bajo CAC** (self-serve, referidos, comunidad docente) para este segmento; no invertir venta consultiva cara aquí.
5. **Churn del segmento independiente** (más volátil que instituciones). Compensar con -10% anual y onboarding rápido.
6. **Compliance:** aislamiento siempre RLS compartido en mi infra; a esta escala no hay exigencia regulatoria típica, pero documentar que los datos viven en infra de ExamLab (Habeas Data se cubre por RLS, no dedicado).

---

# 🔒 INTERNO — NO enviar al cliente
## Modelo 1 · Institución autogestionada (sin administración mía) — AUTO

> Uso interno. Costos y márgenes reales. Cifras base: [`modelo-precios-v3.md`](modelo-precios-v3.md), [`infra-por-modelo-negocio.md`](infra-por-modelo-negocio.md), [`add-ons.md`](add-ons.md), [`almacenamiento-esperado.md`](almacenamiento-esperado.md). Moneda **USD/mes**, locale es-CO.

---

## 1. Qué es el modelo

La institución opera su **propio tenant en mi infraestructura** de forma self-service: crea cursos, importa usuarios, configura branding y gestiona su día a día sin que yo intervenga en la operación. Yo pongo la infra (Supabase + Lovable + dominio), las licencias, las actualizaciones continuas y **soporte básico como SuperAdmin** (alta del tenant, licencias, incidencias, updates), **sin humano operativo asignado por cliente**. Corresponde a la modalidad **AUTO** del v3 (planes Pequeña / Mediana / Grande). Es el **core del negocio**: mayor margen %, menor carga operativa y el que mejor escala mi tiempo sobre una sola plataforma compartida.

---

## 2. Mi costo por cliente, por escala (AUTO, IA = BYO)

Infra siempre mía. Sin humano operativo (solo soporte básico amortizado). IA en BYO ⇒ **$0 de IA para mí**. Costo fijo compartido ≈ $51/mes (Supabase $25 + Lovable $25 + dominio $1); marginal $0,007–0,02/matrícula.

| Matrículas (1 cliente) | Infra marginal atribuida | Soporte básico SuperAdmin (amortizado) | **Mi costo/mes** | Plan AUTO |
|---|---|---|---|---|
| 200 | ~$10 | ~$5 | **~$15** | Pequeña |
| 1.000 | ~$15 | ~$5 | **~$20** | Pequeña |
| 3.000 | ~$30 | ~$8 | **~$38** | Mediana |
| 10.000 | ~$80 | ~$10 | **~$90** | Grande |

*La infra marginal ya contempla la porción del $51 fijo + overages estimados (storage/egress/edge) que aporta ese cliente al pool compartido. El soporte básico es asignación baja y no dedicada; no hay 1 tech por cliente.*

---

## 3. Precio y margen por escala (AUTO)

| Escala del cliente | Plan / precio | Mi costo | **Margen $** | **Margen %** |
|---|---|---|---|---|
| 200 → Pequeña | $149 | $15 | $134 | **90%** |
| 1.000 → Pequeña | $149 | $20 | $129 | **87%** |
| 3.000 → Mediana | $349 | $38 | $311 | **89%** |
| 10.000 → Grande | $799 | $90 | $709 | **89%** |
| >10.000 → Enterprise | desde $1.499 | $200+ | $1.299+ | **~87%+** |

**Sub-variante AUTO + aislamiento dedicado (add-on $99):** el cliente sigue autogestionando, pero su data vive en un Supabase dedicado gestionado por mí (Habeas Data Ley 1581 / SOC2). Mi costo sube ~$25–30 (base del 2º proyecto Supabase Pro + provisión, sin humano). Ej. **Grande AUTO + aislamiento = $898**; costo ~$90 + $30 = **$120** → margen **~87%**. Es el upsell natural para el cliente con equipo de TI propio que exige aislamiento físico pero no quiere que yo opere.

---

## 4. Costo de IA para MÍ + topes

**Default de este modelo = BYO ⇒ $0 de IA para mí.** La institución usa su propia clave de Gemini y le paga a Google directo (~$0,062/matrícula típico). **Empujar BYO siempre** — es el escenario nativo de la autogestionada (tiene equipo que puede manejar la clave).

**Excepción:** si la institución autogestionada toma el **add-on IA administrada ($0,10/matrícula/mes)**, la IA pasa a costarme a MÍ (pago Gemini con mi clave):

| Matrículas | Costo típico (~$0,062/matr) | Costo intensivo (~$0,20/matr) | Cobro ($0,10/matr) | Margen típico | Margen intensivo |
|---|---:|---:|---:|---:|---:|
| 200 | ~$12 | ~$40 | $20 | +$8 (40%) | **−$20 (pérdida)** |
| 1.000 | ~$62 | ~$200 | $100 | +$38 (38%) | **−$100 (pérdida)** |
| 3.000 | ~$186 | ~$600 | $300 | +$114 (38%) | **−$300 (pérdida)** |
| 10.000 | ~$620 | ~$2.000 | $1.000 | +$380 (38%) | **−$1.000 (pérdida)** |

**Tope obligatorio (contrato + enforcement técnico):** 30 mensajes de Tutor IA + 6 calificaciones por matrícula/mes. Al superarlo, se corta la IA in-app hasta el mes siguiente o se cobra overage $0,15/matr. **Nunca vender IA administrada intensiva sin tope** — el uso intensivo es pérdida directa. En este modelo la IA administrada debe ser la excepción, no el default.

---

## 5. Palancas de descuento, piso de margen y cuándo (no) vender

**Palancas y su piso de margen** (sobre AUTO, IA=BYO, sin add-ons):

| Palanca | Aplica a | Impacto en precio | Margen resultante aprox. |
|---|---|---|---|
| −10% pago anual | Todos | Pequeña $149→$134 / Mediana $349→$314 / Grande $799→$719 | Pequeña **~85%** · Mediana **~88%** · Grande **~87%** |
| −15% multi-año (2+ años) | Mediana / Grande | Mediana →$297 / Grande →$679 | Mediana **~87%** · Grande **~87%** |
| −20% educación pública | Solo entidad pública | Grande $799→$639 | Grande **~86%** |
| −30% early adopter (1er año) | Cualquiera | Pequeña →$104 | Pequeña **~81%** |

Los descuentos **apilables extremos** (ej. −30% early + −10% anual sobre Pequeña) llevan Pequeña a ~$94, margen ~79% — **piso aceptable, no bajar más**. Sobre Mediana/Grande hay muchísimo colchón (margen se mantiene >85% con casi cualquier combinación publicable).

**Cuándo conviene vender:** este es el modelo por defecto. Debe ser el **70–80% de la cartera**. Cualquier colegio, academia, instituto o universidad con equipo TI propio que quiera auto-servicio. Margen 87–90% y cero humano.

**Cuándo NO / cuándo reclasificar:**
- Si el cliente pide que yo opere el tenant (importar usuarios cada semestre, crear cursos, soporte de operación) → **NO es AUTO**: reclasificar a Modelo 2 (Administrada +$300) o Modelo 3 (independiente con admin ligera). No regalar operación dentro del AUTO — destruye el margen y sienta precedente.
- Aislamiento dedicado: **no ofrecer bajo Grande** (el add-on $99 tiene margen 24% y complejidad operativa que no justifica a escala Pequeña/Mediana).
- IA administrada intensiva sin tope firmado → **no vender**.

---

## 6. Riesgos operativos

- **Sobreconsumo de matrículas:** cliente que supera su cap sin migrar. Enforcement: aviso al 90%, se permite el mes en curso, upgrade automático al plan siguiente al 3er mes consecutivo (documentar en contrato). Riesgo bajo de margen, alto de fricción si no se avisa.
- **Storage agregado, no individual:** el tenant AUTO individual casi nunca aprieta (uso real 3–7 MB/matr; Grande a 10k usa ~70 GB sobre 200 GB de cap). El riesgo real es el **pool compartido de 100 GB de Supabase** al sumar varios tenants (>15.000 matrículas agregadas) → planificar migración a Cloudflare R2 (elimina egress, el verdadero cuello de botella) desde el primer Grande con material pesado.
- **Abuso de storage (video interno):** clientes subiendo video como archivo en vez de URL externa. Mitigación: alertas 80/100% + empujar externalización antes de vender storage extra.
- **Soporte "básico" que se convierte en operación:** el mayor riesgo del modelo. El cliente AUTO que empieza a pedir tareas de operación erosiona el ratio no-dedicado. Guardrail: cualquier operación recurrente se cotiza como Administrada o como servicio one-time (import legacy $300–800, training $200/sesión).
- **IA administrada:** solo si el cliente autogestionado la toma — pérdida en uso intensivo sin tope. Riesgo cubierto con el enforcement de §4.

---

# Plan del módulo SuperAdmin — Calculadora de costos y precio de venta

> Feature interna de ExamLab (React 18 + TanStack Router + TS + Supabase). Solo rol **SuperAdmin**. Permite cotizar un cliente (por matrículas/licencias) devolviendo costo de infra estimado y precio de venta sugerido con margen parametrizable, para los 3 modelos de negocio (licencia self-host, licencia administrada dedicada, SaaS compartido).

---

## 1. Objetivo y user story

**Objetivo.** Dar al SuperAdmin una herramienta que, ingresando el tamaño del cliente y unas pocas variables comerciales, calcule en **≤30 s** el costo de infraestructura aproximado y el **precio de venta sugerido** con un margen predeterminado (editable), y lo contraste contra el precio de lista v3 y el comparable de mercado.

**User story principal**
> *Como SuperAdmin, quiero ingresar el nº de matrículas activas de un prospecto, elegir plan/modalidad/add-ons y un margen objetivo, para obtener al instante el costo real que me genera ese cliente y un precio de venta defendible, y así cerrar la cotización en la misma llamada.*

**Stories secundarias**
- Como SuperAdmin, quiero **editar los supuestos de costo** (fijo mensual, $/GB, $/matrícula, costo humano, márgenes default) sin tocar código, para reflejar cambios de precios de Supabase/Lovable/salarios.
- Como SuperAdmin, quiero una **tabla por escala** (250 → 100k matrículas) y **export CSV**, para adjuntar la cotización a una propuesta.
- Como SuperAdmin, quiero que el cálculo **cambie según el modelo de negocio** (licencia self-host vs administrada dedicada vs SaaS compartido), porque la estructura de costo es distinta en cada uno.

---

## 2. Ruta y RBAC

**Ruta:** `/app/superadmin/pricing-calculator`
Archivo: `src/routes/app.superadmin.pricing-calculator.tsx` (file-routing TanStack).

**RBAC (`src/shared/lib/rbac.ts`).** El prefijo `/app/superadmin` ya está restringido a `["SuperAdmin"]`. Como la ruta cuelga de ese prefijo, **no requiere regla nueva**: `checkAccess` aplica la regla de prefijo más largo y `rule.roles.includes(activeRole)` corta a cualquier no-SuperAdmin hacia `/app/unauthorized`. Verificar que exista la regla genérica:

```ts
{ prefix: "/app/superadmin", roles: ["SuperAdmin"] }
```

No hay herencia Admin aquí (Admin NO debe ver costos internos). A diferencia de otros módulos superadmin, **este NO se expone a Admin** ni por herencia de nav.

**Nav item (`src/shared/components/AppLayout.tsx`).** Agregar al bloque de items superadmin del `nav.map`, junto a Instituciones/Sistema:

```ts
{
  to: "/app/superadmin/pricing-calculator",
  label: t("nav.pricingCalculator"), // "Calculadora de precios"
  icon: Calculator, // lucide-react
  roles: ["SuperAdmin"],
}
```

- Como `roles: ["SuperAdmin"]` estricto, el gate `visibleNav` (que abre items `["Admin"]` al SuperAdmin) no aplica a la inversa: nunca aparece para Admin.
- Atributo `data-tour-nav="/app/superadmin/pricing-calculator"` por consistencia, aunque SuperAdmin **no tiene tour** (decisión de producto) → no se agrega step.
- Claves i18n nuevas: `nav.pricingCalculator`, más las de la pantalla bajo `pricingCalc.*` en `es` (y `en` mínimo).

Encabezado: `<PageHeader>` top-level (sin `backTo`) con `icon={Calculator}`, `title`, `subtitle` = resumen del último cálculo.

---

## 3. Inputs del formulario

Todos con componentes del design system (`Label required`, `DecimalInput`, `Select`, `HelpHint`, `Switch`). Layout `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4` dentro de un `<Card>` "Parámetros".

| Campo | Componente | Detalle |
|---|---|---|
| **Modo de dimensionamiento** | `Select` | `matriculas` (directo) \| `licencias` (licencias de estudiante × factor materias/alumno) |
| **Nº matrículas activas** | `DecimalInput` (entero) | visible si modo = matrículas. `min 0` |
| **Licencias de estudiante** | `DecimalInput` | visible si modo = licencias |
| **Factor materias/alumno** | `DecimalInput` | default `6` (1 alumno en 6 materias = 6 matrículas). `matriculas = licencias × factor` |
| **Plan** | `Select` | Starter / Pequeña / Mediana / Grande / Enterprise |
| **Modalidad** | `Select` | `Auto` \| `Administrada` (+costo humano) |
| **Modelo de negocio** | `Select` | `1 Licencia self-host` \| `2 Licencia administrada (dedicada)` \| `3 SaaS compartido` |
| **Margen objetivo %** | `DecimalInput` (coma) | default desde `pricing_assumptions` (90%). Rango 0–99 |
| **Descuento pago anual** | `Switch` | −10% al precio final |
| **Add-on: IA administrada** | `Switch` | $0.10/matr/mes (costo real $0.062) |
| **Add-on: Storage extra (GB)** | `DecimalInput` | GB sobre el cap del plan; $10/100GB |
| **Add-on: Code runner ilimitado** | `Switch` | $49/mes |
| **Add-on: Aislamiento dedicado** | `Switch` | $99/mes (auto-forzado en modelo 2) |
| **Add-on: SSO/SAML** | `Switch` | $99 setup (amortizado) + $29/mes |
| **Add-on: Certificación oficial** | `Switch` | $29/mes |

**Comportamiento reactivo**
- `matriculas` derivado con `useMemo` de `licencias × factor` cuando modo = licencias.
- Al elegir **plan**, se sugiere automáticamente por `matriculas` (chip "Plan sugerido: Mediana") pero el SuperAdmin puede overridear.
- **Modelo 2** fuerza `aislamiento = true` y habilita costo humano si modalidad = Administrada.
- **Modelo 1** oculta modalidad Administrada (self-host = el cliente opera) y cambia el motor a "estimación de infra del cliente + precio de licencia".
- Patrón `let cancelled = false` no aplica (cálculo es puro/local); el fetch de `pricing_assumptions` sí lleva el guard estándar.

---

## 4. Motor de cálculo (fórmulas exactas)

Todo el motor vive en un **helper puro testeable** `src/modules/pricing/pricing-engine.ts` (sin React, sin `Date.now`) → habilita `bun test` sin jsdom. La UI solo lo invoca.

### 4.1 Constantes base (de `pricing_assumptions`, valores v3)

```
COSTO_FIJO_MENSUAL      = 51      // Supabase 25 + Lovable 25 + dominio 1
COSTO_HUMANO_ADMIN      = 225     // tech $1800/mes ÷ 8 clientes
STORAGE_OVERAGE_USD_GB  = 0.0213  // Supabase overage
EGRESS_OVERAGE_USD_GB   = 0.09
MARGEN_DEFAULT          = 0.90    // margen sobre precio (gross margin)

// Curva de costo marginal por matrícula (todos los tenants juntos) — Sección 7 CSV
scale = [
  {matr: 1000,   infra: 51,  usdPerMatr: 0.051},
  {matr: 2500,   infra: 53,  usdPerMatr: 0.021},
  {matr: 5000,   infra: 65,  usdPerMatr: 0.013},
  {matr: 10000,  infra: 90,  usdPerMatr: 0.009},
  {matr: 15000,  infra: 120, usdPerMatr: 0.008},
  {matr: 25000,  infra: 180, usdPerMatr: 0.007},
  {matr: 50000,  infra: 700, usdPerMatr: 0.014},  // salto a Supabase Team $599
  {matr: 100000, infra: 900, usdPerMatr: 0.009},
]

// Catálogo de planes
plans = {
  Starter:    {cap: 200,    gb: 25,  listAuto: 79,   listAdmin: null, infraEst: 10, adminOfrecido: false},
  Pequena:    {cap: 1000,   gb: 50,  listAuto: 149,  listAdmin: 449,  infraEst: 15, adminOfrecido: true},
  Mediana:    {cap: 3000,   gb: 100, listAuto: 349,  listAdmin: 749,  infraEst: 30, adminOfrecido: true},
  Grande:     {cap: 10000,  gb: 200, listAuto: 799,  listAdmin: 1499, infraEst: 80, adminOfrecido: true},
  Enterprise: {cap: null,   gb: 500, listAuto: 1499, listAdmin: null, infraEst: 200,adminOfrecido: true},
}

// Add-ons: [precioLista, costoReal]
addons = {
  iaAdmin:      {list: 0.10, cost: 0.062, unidad: "por matrícula/mes"},
  storageExtra: {list: 10,   cost: 2.13,  unidad: "por 100 GB/mes"},
  codeRunner:   {list: 49,   cost: 5,     unidad: "por mes"},
  aislamiento:  {list: 99,   cost: 75,    unidad: "por mes"},   // Supabase Pro dedicado + ops
  ssoSetup:     {list: 99,   cost: 50,    unidad: "una vez"},   // amortizar /12
  ssoMensual:   {list: 29,   cost: 0,     unidad: "por mes"},
  certificacion:{list: 29,   cost: 0,     unidad: "por mes"},
}
```

### 4.2 Costo de infra atribuido al cliente `costoInfra(N)`

Interpolación **lineal por tramos** sobre `usdPerMatr` de la curva, más piso de fijo:

```
if (N <= 0) costoInfra = COSTO_FIJO_MENSUAL           // solo fijo, sin marginal
else:
  usd = interp(N, scale, "usdPerMatr")                // interpolación entre puntos
  costoMarginal = N × usd
  costoInfra = max(COSTO_FIJO_MENSUAL, costoMarginal)  // el fijo domina hasta ~1000 matr
```

Cross-check con `plans[plan].infraEst` (mostrar ambos; si difieren >30% marcar `StatusBadge` "revisar plan vs volumen").

### 4.3 Storage overage

```
gbNecesario   = gbBasePorMatricula × N        // gbBasePorMatricula ≈ 0.006 (6MB material/curso) + 0.01 (ZIPs) → constante editable
gbIncluido    = plans[plan].gb
gbSobre       = max(0, gbNecesario - gbIncluido + gbExtraManual)
storageOverage = gbSobre × STORAGE_OVERAGE_USD_GB
```
Si `gbSobre > 0` sin add-on de storage marcado → warning "storage rompe el plan, agregar add-on o subir plan".

### 4.4 Costo humano

```
costoHumano = (modalidad === "Administrada") ? COSTO_HUMANO_ADMIN : 0
```
Bloqueado si `plan === "Starter"` (admin no ofrecido) → ver casos borde.

### 4.5 Costo de add-ons (costo real a ExamLab)

```
addonCost =
  (iaAdmin      ? addons.iaAdmin.cost × N : 0) +
  (codeRunner   ? addons.codeRunner.cost  : 0) +
  (aislamiento  ? addons.aislamiento.cost : 0) +
  (sso          ? addons.ssoMensual.cost + addons.ssoSetup.cost/12 : 0) +
  (certificacion? addons.certificacion.cost : 0)
// storageExtra ya contabilizado en storageOverage
```

### 4.6 Costo total y precio — por modelo de negocio

**Modelo 3 — SaaS compartido (marginal, el modelo actual):**
```
costoTotal = costoInfra(N) + costoHumano + addonCost + storageOverage
```

**Modelo 2 — Licencia administrada, instancia dedicada:**
```
// aislamiento forzado (Supabase dedicado por tenant, costo real 75)
costoTotal = COSTO_FIJO_MENSUAL + addons.aislamiento.cost + costoHumano
           + costoInfra_marginal_dedicado(N) + addonCost' + storageOverage
// addonCost' no doble-cuenta aislamiento
```
> El costo humano es ineludible aquí; si modalidad = Auto en modelo 2, warning "una instancia dedicada casi siempre implica operación → considerar Administrada".

**Modelo 1 — Licencia self-host (ExamLab NO hospeda):**
```
costoExamLab      = onboardingAmortizado + soporteMensual   // ≈ 0 infra; solo horas
costoInfraCliente = 25 (Supabase Pro) + 20 (hosting Vercel/estático) + 1 (dominio)
                    + IA BYO (cliente) ≈ $46–70/mes    // se MUESTRA para justificar la licencia
```
En este modelo el "precio sugerido" es la **licencia** (no un SaaS mensual):
```
precioLicenciaMensualEquivalente = plans[plan].listAuto × factorLicencia   // factorLicencia default 0.70
precioLicenciaAnual = precioLicenciaMensualEquivalente × 12 + setupOneTime
```
Racional del `0.70`: el cliente asume su propia infra/ops → se descuenta ~30% del precio SaaS de lista. Parametrizable en `pricing_assumptions`.

### 4.7 Precio sugerido (modelos 2 y 3) — margen **sobre precio**

Se usa **margen bruto sobre precio** (no markup sobre costo):

```
precioSugerido = costoTotal / (1 - margen)        // margen ∈ [0, 0.99)
margenUSD      = precioSugerido - costoTotal
margenPct      = margenUSD / precioSugerido        // = margen (control)
```

**Por qué margen-sobre-precio y no `costo×(1+markup)`:** (1) así se derivó la lista v3 —ej. Mediana: costo $30, lista $349 → margen `(349−30)/349 = 91.4%`, coincide con el 91% del CSV—; (2) es la convención de gross margin con la que se negocia SaaS; (3) queda acotado <100% y no explota. El markup se ofrece solo como columna informativa secundaria: `markup% = margenUSD/costoTotal`.

**Descuento anual:** `precioFinal = precioSugerido × (descuentoAnual ? 0.90 : 1)`.

### 4.8 Comparación contra lista v3

```
precioLista = (modalidad==="Administrada") ? plans[plan].listAdmin : plans[plan].listAuto
deltaVsLista = precioSugerido - precioLista
// StatusBadge: precioSugerido ≤ precioLista → "dentro de lista" (ok)
//              precioSugerido  > precioLista → "sobre lista, revisar" (warning)
```
El precio de lista es el **piso comercial**: si el cálculo por margen da menos que la lista, se recomienda cobrar la lista (mostrar ambos).

---

## 5. Persistencia — tabla `pricing_assumptions`

Se opta por **tabla en DB** (no constantes en front) para que el SuperAdmin edite supuestos sin deploy. Singleton (una fila) con columnas tipadas + JSONB para catálogos (curva de escala, planes, add-ons).

**Pros tabla vs front:** editable sin build/Publish; auditable (`updated_by`/`updated_at`); un solo origen de verdad para el motor y futuros reportes.
**Cons:** requiere migración + fetch inicial. Mitigación: el front trae un **fallback hardcodeado idéntico** al seed (mismo patrón que `FALLBACK_TEMPLATE` del tutor) para que la calculadora funcione aunque la tabla no exista todavía en el entorno.

### Migración `supabase/migrations/20261200000000_pricing_assumptions.sql`

```sql
-- Tabla de supuestos de costo/precio para la calculadora del SuperAdmin.
-- Singleton: una sola fila activa. Solo SuperAdmin lee/escribe.
DO $$
BEGIN
  IF to_regclass('public.pricing_assumptions') IS NULL THEN
    CREATE TABLE public.pricing_assumptions (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      singleton                boolean NOT NULL DEFAULT true,
      costo_fijo_mensual       numeric NOT NULL DEFAULT 51,
      costo_humano_admin       numeric NOT NULL DEFAULT 225,
      storage_overage_usd_gb   numeric NOT NULL DEFAULT 0.0213,
      egress_overage_usd_gb    numeric NOT NULL DEFAULT 0.09,
      gb_base_por_matricula    numeric NOT NULL DEFAULT 0.016,   -- ~16MB/matrícula/año
      margen_default           numeric NOT NULL DEFAULT 0.90,    -- margen sobre precio
      factor_materias_default  numeric NOT NULL DEFAULT 6,
      factor_licencia_selfhost numeric NOT NULL DEFAULT 0.70,
      descuento_anual          numeric NOT NULL DEFAULT 0.10,
      scale_curve              jsonb  NOT NULL,   -- [{matr, infra, usdPerMatr}, ...]
      plans                    jsonb  NOT NULL,   -- {Starter:{cap,gb,listAuto,...}, ...}
      addons                   jsonb  NOT NULL,   -- {iaAdmin:{list,cost}, ...}
      updated_at               timestamptz NOT NULL DEFAULT now(),
      updated_by               uuid REFERENCES auth.users(id),
      CONSTRAINT pricing_assumptions_singleton UNIQUE (singleton)
    );

    ALTER TABLE public.pricing_assumptions ENABLE ROW LEVEL SECURITY;

    -- RLS: SuperAdmin-only en TODAS las operaciones (contiene lógica comercial sensible).
    CREATE POLICY pricing_assumptions_select ON public.pricing_assumptions
      FOR SELECT TO authenticated USING (public.is_super_admin());
    CREATE POLICY pricing_assumptions_insert ON public.pricing_assumptions
      FOR INSERT TO authenticated WITH CHECK (public.is_super_admin());
    CREATE POLICY pricing_assumptions_update ON public.pricing_assumptions
      FOR UPDATE TO authenticated
        USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
    -- Sin DELETE: singleton no se borra.

    -- Seed con valores v3.
    INSERT INTO public.pricing_assumptions (scale_curve, plans, addons) VALUES (
      '[{"matr":1000,"infra":51,"usdPerMatr":0.051},
        {"matr":2500,"infra":53,"usdPerMatr":0.021},
        {"matr":5000,"infra":65,"usdPerMatr":0.013},
        {"matr":10000,"infra":90,"usdPerMatr":0.009},
        {"matr":15000,"infra":120,"usdPerMatr":0.008},
        {"matr":25000,"infra":180,"usdPerMatr":0.007},
        {"matr":50000,"infra":700,"usdPerMatr":0.014},
        {"matr":100000,"infra":900,"usdPerMatr":0.009}]'::jsonb,
      '{"Starter":{"cap":200,"gb":25,"listAuto":79,"listAdmin":null,"infraEst":10,"adminOfrecido":false},
        "Pequena":{"cap":1000,"gb":50,"listAuto":149,"listAdmin":449,"infraEst":15,"adminOfrecido":true},
        "Mediana":{"cap":3000,"gb":100,"listAuto":349,"listAdmin":749,"infraEst":30,"adminOfrecido":true},
        "Grande":{"cap":10000,"gb":200,"listAuto":799,"listAdmin":1499,"infraEst":80,"adminOfrecido":true},
        "Enterprise":{"cap":null,"gb":500,"listAuto":1499,"listAdmin":null,"infraEst":200,"adminOfrecido":true}}'::jsonb,
      '{"iaAdmin":{"list":0.10,"cost":0.062},"storageExtra":{"list":10,"cost":2.13},
        "codeRunner":{"list":49,"cost":5},"aislamiento":{"list":99,"cost":75},
        "ssoSetup":{"list":99,"cost":50},"ssoMensual":{"list":29,"cost":0},
        "certificacion":{"list":29,"cost":0}}'::jsonb
    );
  END IF;
END $$;
```

- Envuelto en `DO $$ ... to_regclass ... $$` por la defensiva de Lovable (CLAUDE.md).
- `is_super_admin()` ya bypassa/gate en el resto de RLS; aquí se usa como único predicado.
- **UI de edición de supuestos:** panel `AdminPricingAssumptionsPanel` (o tab "Supuestos" dentro de la calculadora) con `DecimalInput` por constante numérica + editor JSON simple para curva/planes/add-ons. Guardar = `update` sobre la fila singleton (fire-and-forget con `friendlyError`).

---

## 6. Salida / UI

### 6.1 Tarjeta de resultado (hero)
`<Card>` "Resultado" con grid de tiles (mismo patrón que `<Stat>` de dashboards):

| Tile | Valor |
|---|---|
| Costo total / mes | `$costoTotal` (StatusBadge tono según margen) |
| **Precio sugerido / mes** | `$precioSugerido` (destacado, tamaño grande) |
| Margen | `$margenUSD` · `margenPct %` |
| $ / matrícula | `precioSugerido / N` |
| Precio de lista v3 | `$precioLista` + `deltaVsLista` |
| Comparable mercado | rango de `comparables-mercado.md` (StatusBadge "competitivo" / "caro" / "barato") |

- Modelo 1 reemplaza "Precio sugerido/mes" por **"Licencia anual sugerida"** + tile "Infra que paga el cliente/mes".
- `StatusBadge`: margen ≥ objetivo → `default/ok`; margen < objetivo → `warning`; precioSugerido > lista → `warning "sobre lista"`.

### 6.2 Tabla por escala
`<Table resizable>` con `usePagination` + `useTableSort`, columnas: Matrículas · Plan sugerido · Costo infra · $/matrícula · Precio sugerido (auto) · Precio sugerido (admin) · Margen %. Filas = puntos de la curva (250, 500, 1k, 2.5k, 5k, 10k, 25k, 50k, 100k) recalculados con los supuestos actuales. Sirve para ver a partir de qué volumen conviene qué plan.

### 6.3 Export CSV
Botón en `actions` del `PageHeader` (patrón `ImportExportMenu`): exporta (a) los inputs, (b) el desglose de costo (fijo/marginal/humano/addons/storage), (c) precio sugerido y comparativa vs lista, (d) la tabla por escala. Nombre `cotizacion-<cliente>-<fecha>.csv` (fecha vía `formatDateOnly`).

### 6.4 Desglose editable
Acordeón "Supuestos de este cálculo" que muestra los valores tomados de `pricing_assumptions` con opción de **override efímero** (solo para esta cotización, no persiste) — útil para simular "¿y si Supabase sube 25%?". Los cambios persistentes van al panel de Supuestos (§5).

Toda cifra monetaria formateada con `Intl` es-CO / helpers; fechas por `src/lib/format.ts`. Nada de `toLocaleString` inline.

---

## 7. Casos borde

| Caso | Manejo |
|---|---|
| **0 matrículas** | `costoInfra = COSTO_FIJO_MENSUAL`, sin marginal. `precioSugerido` = piso = `plans[plan].listAuto`. Guardar contra división por cero en `$/matrícula` → mostrar "—". |
| **N > cap del plan** | Warning "volumen excede el cap del plan; sugerir plan superior o Enterprise". Autoselección de plan sugerido por `cap`. |
| **Escala Enterprise (>10k)** | Precio pasa a "custom (desde $1499)". A **~50k matrículas** avisar el salto a **Supabase Team $599** (costo infra da $700 en la curva) → el $/matrícula sube; recomendar renegociar. |
| **Storage rompe el plan** | Si `gbSobre > 0` y no hay add-on storage → `StatusBadge warning` + CTA "agregar Storage extra ($10/100GB) o subir plan". El overage se suma igual al costo para no subestimar. |
| **Modalidad Admin en Starter** | Bloqueada (`plans.Starter.adminOfrecido = false`, CSV: "NO OFRECER"). El `Select` de modalidad deshabilita "Administrada" con `HelpHint` "Starter no admite modalidad administrada; el costo humano ($225) no cierra margen a $79". |
| **Margen ≥ 100%** | Validación `DecimalInput` clamp a 99% (evita división por cero/negativa en `1 - margen`). |
| **Modelo 2 con Auto** | Warning "instancia dedicada casi siempre implica operación; considerar Administrada". |
| **Modelo 1 (self-host)** | Oculta costo humano/modalidad admin; muestra infra del cliente ($46–70/mes) + licencia anual. No compara contra lista SaaS mensual, sino contra "SaaS anual × factor". |
| **`pricing_assumptions` ausente** | El front cae al fallback hardcodeado (idéntico al seed) y muestra badge "usando valores por defecto (tabla no encontrada)". |

---

## 8. Plan de implementación por fases

### Fase 1 — MVP calculadora (motor + resultado) — **~1.5 días**
- `pricing-engine.ts` puro con todas las fórmulas §4 (constantes hardcodeadas = fallback). **Tests** `pricing-engine.test.ts` (cross-check contra lista v3: Mediana costo 30 → margen 91%; curva de escala; casos borde 0/cap/Starter-admin).
- Ruta + nav item + i18n. Form con inputs §3.
- Tarjeta de resultado §6.1 (modelos 2 y 3). Comparativa vs lista.
- **Sin DB todavía** (constantes en front).
- Esfuerzo: motor 0.5d, UI form+resultado 0.75d, tests 0.25d.

### Fase 2 — Parametrizable (DB + supuestos + modelo 1) — **~1 día**
- Migración `pricing_assumptions` §5 + fetch con guard + fallback.
- Panel/tab "Supuestos" editable (RLS SuperAdmin).
- Modelo 1 (licencia self-host): infra cliente + licencia anual.
- Override efímero §6.4.
- Esfuerzo: migración 0.25d, fetch+fallback 0.25d, panel edición 0.5d.

### Fase 3 — Escala + export + pulido — **~0.75 día**
- Tabla por escala §6.2 (`usePagination` + `useTableSort` + `Table resizable`).
- Export CSV §6.3.
- Comparable de mercado (leer rangos de `comparables-mercado.md` → constante en `pricing_assumptions.plans` o JSON aparte).
- StatusBadges de warnings, HelpHints, responsive (grid 1→3 col).
- Esfuerzo: tabla 0.3d, CSV 0.2d, pulido/QA 0.25d.

**Total estimado: ~3.25 días** de un dev familiarizado con el repo. Ruta crítica = motor puro + tests (Fase 1); todo lo demás es UI reusando el design system existente.

### Dependencias / notas
- Reusa 100% design system (`Card`, `DecimalInput`, `Select`, `Switch`, `StatusBadge`, `PageHeader`, `Table`, `usePagination`, `useTableSort`, `ImportExportMenu`, `HelpHint`) → sin componentes nuevos salvo la pantalla.
- Sin edge functions ni IA: cálculo 100% client-side puro → instantáneo, testeable, sin costo.
- Invariante a mantener: si cambian los precios v3 (`modelo-precios-v3.md` / `calculadora.csv`), actualizar el **seed** de `pricing_assumptions` Y el fallback del front (documentar el par en la tabla de invariantes cross-file de CLAUDE.md).
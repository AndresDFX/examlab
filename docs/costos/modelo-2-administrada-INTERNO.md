# 🔒 INTERNO — NO enviar al cliente
## Modelo: Institución administrada (con administración mía)

> Uso interno. Contiene costos, márgenes y topes de protección. Cifras v3 (USD/mes, locale es-CO). Base: [modelo-precios-v3.md](modelo-precios-v3.md), [infra-por-modelo-negocio.md](infra-por-modelo-negocio.md) (Modelo 2), [add-ons.md](add-ons.md), [interno-comercial-v3.md](interno-comercial-v3.md), [escenarios.md](escenarios.md).

---

### 1. Qué es el modelo

Institución donde **yo opero el tenant** por el cliente: creo cursos, importo usuarios y estructura académica, configuro branding y correos, capacito docentes y doy soporte pleno. La infra es **siempre mía** (Supabase + Lovable compartidos por RLS; dedicado opcional). Comercialmente es un **plan base (Pequeña/Mediana/Grande/Enterprise) + recargo Administrada de +$300/mes**. Es el de **menor margen % pero mayor margen absoluto por cliente**, y el que habilita ventas Enterprise reguladas.

---

### 2. Mi costo por cliente por escala

Costo = infra atribuida (siempre >$0) + humano operativo. Humano validado con salarios Colombia 2026: tech mid remote ~$1.800/mes cargado, ratio realista **1 tech : 8 clientes admin** → **~$225/cliente/mes**. IA = $0 para mí **solo si BYO** (ver §4).

| Matrículas | Infra atribuida (RLS compartido) | Humano (1 tech : 8) | **Mi costo/mes** |
|---|---:|---:|---:|
| 200 | ~$10 | $225 | **~$235** |
| 1.000 | ~$15 | $225 | **~$240** |
| 3.000 | ~$30 | $225 | **~$255** |
| 10.000 | ~$80 | $225 | **~$305** |

Con **aislamiento dedicado gestionado por mí (+$99 al cliente)** el costo sube ~$30 de infra (segundo proyecto Supabase Pro + ops de provisión): 3.000 → ~$285; 10.000 → ~$335.

---

### 3. Precio y margen por escala (contra precios v3)

Precio = plan AUTO + $300 Administrada.

| Escala | Precio (plan + $300) | Mi costo | **Margen $** | **Margen %** |
|---|---:|---:|---:|---:|
| 200 → Pequeña Admin | $149 + $300 = **$449** | $235 | $214 | **48%** |
| 1.000 → Pequeña Admin | **$449** | $240 | $209 | **47%** |
| 3.000 → Mediana Admin | $349 + $300 = **$749** | $255 | $494 | **66%** |
| 10.000 → Grande Admin | $799 + $300 = **$1.499** | $305 | $1.194 | **80%** |
| >10.000 → Enterprise Admin | desde $1.499 + custom | $400–600 | $1.100–1.300+ | **~75%+** |

**Con aislamiento dedicado (+$99):**

| Escala | Precio (plan + $300 + $99) | Mi costo | **Margen $** | **Margen %** |
|---|---:|---:|---:|---:|
| 3.000 → Mediana | **$748** | $285 | $463 | **62%** |
| 10.000 → Grande | **$1.198** | $335 | $863 | **72%** |
| >10.000 → Enterprise | desde **$1.898** | $430–630 | $1.270–1.470 | **~70%+** |

**Racional del +$300:** el humano me cuesta ~$225 → el recargo deja ~$75/mes de margen operativo directo sobre el humano (25%). El resto del margen del cliente lo aporta el spread altísimo del plan base (infra ~$15–90). Por eso el margen % **crece con la escala**: el humano es fijo (~$225) y el precio del plan sube.

---

### 4. Costo de IA para MÍ + topes

En este modelo el cliente típico es una institución **sin equipo técnico**, así que frecuentemente toma también el **add-on IA administrada ($0.10/matrícula/mes)** — y ahí **la IA sí me cuesta a mí** (pago Gemini con mi clave).

| Matrículas | IA típico (~$0.062/matr) | IA intensivo (~$0.20/matr) | Cobro IA admin ($0.10/matr) | Margen IA típico | Margen IA intensivo |
|---|---:|---:|---:|---:|---:|
| 200 | ~$12 | ~$40 | $20 | +$8 (40%) | **−$20 (pérdida)** |
| 1.000 | ~$62 | ~$200 | $100 | +$38 (38%) | **−$100 (pérdida)** |
| 3.000 | ~$186 | ~$600 | $300 | +$114 (38%) | **−$300 (pérdida)** |
| 10.000 | ~$620 | ~$2.000 | $1.000 | +$380 (38%) | **−$1.000 (pérdida)** |

**Tope obligatorio (contrato + enforcement técnico):** **30 mensajes de Tutor IA + 6 calificaciones por matrícula/mes**. Al superarlo se corta la IA in-app hasta el mes siguiente, o se cobra overage $0.15/matr extra. **Sin este tope, un cliente intensivo con IA administrada me hace perder dinero** — y este modelo es donde más se junta (institución sin equipo → admin + IA administrada).

**Costo total real del cliente administrado con IA administrada** = infra (~$15–90) + humano (~$225) + **IA ($12–620 típico)**. Cotizar la IA como **línea aparte**, nunca embebida en el $300. Empujar BYO cuando el cliente tenga cómo gestionar la clave.

> Ejemplo real (Escenario 3): Universidad 3.000 Mediana Admin + IA administrada = **$1.049/mes** cobrado; costo $30 infra + $225 humano + $186 IA = **$441** → ganancia **$608/mes (58%)**.

---

### 5. Palancas de descuento y piso de margen

| Palanca | Efecto | Piso de margen | Cuándo |
|---|---|---|---|
| −10% pago anual | −$45 (Peq) / −$75 (Med) / −$150 (Gr) | Peq Admin baja a ~$164/mes margen (**~40%**) — sigue sano | Default: siempre ofrecer, mejora cashflow |
| −15% multi-año | Med/Grande | Grande Admin aún ~72%+ | Blindar clientes grandes 2+ años |
| −20% educación pública | Solo entidad pública | **NO combinar con Admin en Pequeña**: $449 −20% = $359 vs costo $240 → margen cae a ~33%. Aceptable solo desde Mediana | Universidades estatales; fijar pago a 90 días |
| −30% early adopter | Solo 1er año | En Pequeña Admin destruye el margen (queso el humano) — **evitar en franja chica** | Solo Mediana/Grande y solo año 1 |

**Reglas de "cuándo NO vender":**
- **NUNCA Starter Admin ni Administrada bajo 200 matrículas** en forma dedicada: el humano ($225) se come el spread de un plan chico. Para ese perfil → **Modelo 3 (independientes, admin ligera)** o **Modelo 1 (AUTO)**.
- **No ofrecer IA administrada intensiva sin tope firmado.** Preferir BYO.
- **Administrada conviene** desde Mediana en adelante (margen 66–80%), y muy especialmente en Grande/Enterprise regulados donde además se vende aislamiento (+$99) → mayor margen absoluto ($863–$1.470/cliente).
- Reservar este modelo al **10–15% de la cartera** (venta consultiva); puede aportar 30–40% del revenue.

---

### 6. Riesgos operativos

- **Humano lineal (no escala):** 1 tech : 8 clientes admin. Si crece la cartera administrada más rápido que la contratación, la calidad de operación cae o el ratio se rompe (margen se erosiona). Vigilar el ratio como KPI.
- **Cliente intensivo de IA administrada** sin tope enforced → pérdida directa (§4). El enforcement técnico del tope debe estar activo antes de firmar.
- **Concentración de dependencia:** al operar yo el tenant, el cliente depende de mí para todo → churn caro para ambos, pero cualquier caída de servicio es 100% responsabilidad mía (SLA 4h).
- **Sobreconsumo de horas:** un cliente "administrado" demandante puede consumir más de las ~4–6h/mes previstas → reclasificar de plan o renegociar antes de que el margen operativo ($75 sobre humano) se vuelva negativo.
- **Aislamiento dedicado:** setup 8–16h de tech senior la primera vez + CI/CD sincronizado. Subestimar ese one-time reduce el payback. Cotizar setup aparte ($300–800 según scope).
- **Educación pública:** pago a 90 días → factorar el flujo; el descuento −20% combinado con Admin en franjas chicas es antieconómico.

---

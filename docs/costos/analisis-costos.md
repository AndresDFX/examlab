# Análisis de costos — ExamLab

> **Propósito:** documento formal de análisis de costos de operación de la plataforma, para sustentar
> el modelo de negocio y las propuestas comerciales con **datos reales de producción** + **precios
> exactos de terceros** + **proyecciones por tamaño de institución**.
>
> **Fecha:** 2026-07-08 · **Datos:** producción (proyecto Supabase `uxxpzfsfcnqiwwdxoelm`, 6 tenants),
> verificados por consulta SQL directa el 2026-07-07. **Precios de terceros:** Gemini API y Supabase
> (tier pago) a la fecha — verificar en la fuente antes de cotizar en firme.
>
> Complementa (y formaliza) [modelo-costos-ia-almacenamiento.md](modelo-costos-ia-almacenamiento.md).

---

## 1. Resumen ejecutivo

- **La estructura de costos es muy favorable.** El único costo que escala con el uso es la **IA de
  calificación/tutoría**, y hoy es **minúsculo**: la institución real más grande (190 estudiantes)
  gasta **≈ $0,32/mes** de IA al ritmo medido.
- **La infraestructura base es fija y compartida:** un solo proyecto **Supabase Pro (~$25/mes)**
  cubre HOY las 6 instituciones (DB + storage + edge functions + realtime). El almacenamiento real
  total es **47 MB** — tres órdenes de magnitud por debajo de la base incluida (100 GB).
- **La IA se puede llevar a costo $0 para ExamLab** con *BYO API key* (la institución pone su clave
  de Google y paga directo), o facturarse como **add-on medido**. La **cola sync/async** acota picos.
- **Conclusión:** a las escalas objetivo (250 / 1.500 / 5.000 estudiantes) el costo variable es una
  **fracción minoritaria** del precio del plan; el margen es amplio y predecible.

---

## 2. Metodología

Base de datos **temprana y pequeña**, por eso NO extrapolamos totales crudos. En su lugar:

1. **Medición real por operación** — tokens reales del Tutor IA y tamaños reales de objetos en Storage.
2. **Conteo real de operaciones** — calificaciones IA y mensajes de tutor efectivamente ejecutados.
3. **Tres intensidades de uso** — `real medido` (hoy) · `típico maduro` (proyección de adopción
   plena) · `intensivo` (techo para dimensionar) — escaladas al **tamaño de la institución**.

Cada cifra se marca como **REAL** (medida en prod) o **EST** (estimada por estructura del prompt).

---

## 3. Datos reales de producción (verificados 2026-07-07)

| Métrica | Valor real |
|---|---|
| Instituciones (tenants) | 6 — mayor real **FESNA: 190 estudiantes**; resto ≤ 19 |
| Usuarios (profiles) | 276 (273 Estudiante · 58 Docente · 5 Admin · 1 SuperAdmin; multi-rol) |
| Cursos activos | 11 (13 incl. papelera) · Matrículas | 249 |
| Exámenes / Talleres / Proyectos activos | 13 / 13 / 2 |
| Entregas de examen | 113 (75 con calificación IA) |
| **Calificaciones IA totales** | **179** — 75 exámenes · 90 talleres · 14 proyectos |
| Ventana de actividad medida | ~2 meses (2026-05-01 → 2026-06-30) |
| **Tutor IA — tokens/mensaje (REAL)** | **entrada 3.522 · salida 190** (máx 7.420 / 522) |
| **Tutor IA — volumen real** | **7 mensajes** en 3 sesiones → adopción incipiente |
| Almacenamiento total | **47 MB** / 86 objetos (`generated-contents` 26,3 MB + 1 video 18,8 MB) |
| Material por curso (REAL) | 6,57 MB/curso (promedio de 4 cursos con material) |

---

## 4. Precios de terceros

### 4.1. Gemini API (tier pago, por 1M tokens)

| Modelo | Entrada | Salida (incl. thinking) |
|---|---|---|
| **Gemini 2.5 Flash** *(default de ExamLab)* | **$0,30** | **$2,50** |
| Gemini 2.5 Flash-Lite | $0,10 | $0,40 |
| Gemini 2.5 Pro | $1,25 (≤200k) / $2,50 (>200k) | $10,00 / $15,00 |

`costo_USD = (tokens_entrada × precio_in + tokens_salida × precio_out) / 1.000.000`

### 4.2. Supabase (proyecto Pro)

| Concepto | Incluido en Pro (~$25/mes) | Excedente |
|---|---|---|
| Base de datos | 8 GB | $0,125/GB/mes |
| Almacenamiento (Storage) | 100 GB | $0,021/GB/mes |
| Egress (descargas) | 250 GB | $0,09/GB |
| Edge Functions | 2 M invocaciones | $2,00/1M |
| Realtime | 5 M mensajes / 500 conexiones concurrentes | según uso |

### 4.3. Otros

- **Email (SMTP):** se usa el servidor del cliente (p. ej. Gmail/SMTP institucional) → **~$0** para ExamLab.
- **AWS Lambda (runner de código):** por invocación; uso real 11 ejecuciones en 2 meses → **despreciable**.

---

## 5. Costo de IA por operación (Gemini 2.5 Flash)

| Operación | tok entrada | tok salida | **Costo/op** | Fuente |
|---|---|---|---|---|
| Tutor IA — 1 mensaje | 3.522 | 190 | **$0,00153** | REAL |
| Calificar entrega de examen | 4.000 | 600 | **$0,00270** | EST |
| Calificar taller (completo) | 8.000 | 800 | **$0,00440** | EST |
| Calificar proyecto (ZIP ~50k tok) | 50.000 | 1.000 | **$0,01750** | EST |
| Generar ~10 preguntas | 1.500 | 2.500 | **$0,00670** | EST |
| Generar contenido didáctico | 1.000 | 3.000 | **$0,00780** | EST |
| Detección de copia (por par) | 4.000 | 300 | **$0,00195** | EST |

- **Con Gemini 2.5 Pro** la salida cuesta ~4× ($10 vs $2,50): calificar examen ≈ **$0,011** (vs $0,0027).
- **Con Flash-Lite** baja ~5×: tutor ≈ **$0,00043/mensaje**.

---

## 6. Costo de IA por estudiante/mes — tres intensidades

| Intensidad | Derivación | **$/estud./mes** |
|---|---|---|
| **Real medido (hoy)** | 179 calificaciones + 7 msgs de tutor en ~2 meses sobre 249 matrículas → **0,36 calificaciones** + **~0,01 msgs tutor** por estud./mes; costo ponderado real por calificación **$0,0047** | **≈ $0,0017** |
| **Típico maduro** | 2 exámenes + 4 talleres + 0,5 proyectos + 20 msgs tutor / mes | **≈ $0,062** |
| **Intensivo (techo)** | calificación con Pro + 60 msgs tutor / mes | **≈ $0,20** |

> El **driver** del escenario típico es el Tutor IA (20 msgs ≈ 50% del costo/estudiante). Como hoy el
> tutor está casi sin usar, el costo real se mantiene cerca del piso medido hasta que la adopción suba.

---

## 7. Costo de IA por tamaño de institución  ⭐

Estudiantes × intensidad (Gemini 2.5 Flash). La institución real más grande hoy es FESNA (190).

| Institución (estudiantes) | Real medido ($0,0017) | Típico maduro ($0,062) | Intensivo ($0,20) |
|---|---|---|---|
| **FESNA — real hoy (190)** | **$0,32** | $11,8 | $38 |
| Esencial (250) | $0,43 | **$15,5** | $50 |
| Mediana (500) | $0,85 | $31 | $100 |
| Grande (1.000) | $1,70 | $62 | $200 |
| Profesional (1.500) | $2,55 | **$93** | $300 |
| Institucional (5.000) | $8,50 | **$310** | $1.000 |

**Contra el precio del plan** (plataforma auto-administrada: $99 / $299 / $1.000; administrada: $249 / $649 / $1.900):

| Plan | IA típico | IA típico como % del plan (auto / admin) |
|---|---|---|
| Esencial (250) | ≈ $16/mes | 16% / 6% |
| Profesional (1.500) | ≈ $93/mes | 31% / 14% |
| Institucional (5.000) | ≈ $310/mes | 31% / 16% |

Estrategia para neutralizar el costo de IA:
- **BYO API key** — la institución pone su clave de Google; paga ~$16–$310/mes **directo a Google** →
  ExamLab **$0 de costo de IA**, margen intacto.
- **Add-on medido** — se factura el consumo real (fórmula §5) + margen; el escenario intensivo es el techo.
- **Cola sync/async** — en `async` la IA corre por lotes/cron y el Admin controla cuándo drena → sin picos.

---

## 8. Almacenamiento

**Supuestos** (ajustar al crecer): material ~10 MB/curso (real 6,57); ZIP de proyecto ~5 MB; ~2 proyectos/
estudiante/año; videos subidos ~20 MB c/u (las grabaciones de clase suelen ser **URL externa** y no ocupan storage).

| Plan | Cursos aprox. | Material | ZIPs | Videos | **Total** |
|---|---|---|---|---|---|
| Esencial (250) | ~10 | 100 MB | 2,5 GB | ~0,5 GB | **≈ 3 GB** |
| Profesional (1.500) | ~60 | 600 MB | 15 GB | ~3 GB | **≈ 19 GB** |
| Institucional (5.000) | ~200 | 2 GB | 50 GB | ~10 GB | **≈ 62 GB** |

- Los 3 planes **caben en los 100 GB incluidos** → **storage ≈ incluido/insignificante**.
- Solo instituciones que superen 100 GB pagan excedente trivial (150 GB → 50 × $0,021 ≈ **$1/mes**).
- **El almacenamiento NO es un driver de costo** a estas escalas.

---

## 9. Infraestructura base (costo fijo)

| Componente | Costo | Nota |
|---|---|---|
| Supabase Pro | **~$25/mes** | Cubre HOY **todas** las instituciones (proyecto compartido, aislamiento por RLS) |
| Edge Functions | incluidas | 2 M invocaciones/mes; el uso real está muy por debajo |
| Email SMTP | ~$0 | Servidor del cliente |
| AWS Lambda (código) | despreciable | 11 ejecuciones reales en 2 meses |

**Costo fijo total actual ≈ $25/mes para las 6 instituciones.** A medida que se sumen instituciones/uso,
el único crecimiento material es la IA (§7) y, eventualmente, storage sobre 100 GB (§8, trivial).

---

## 10. Aislamiento por institución (regulación / data residency)

Requisito: separar lógicamente cada institución (p. ej. **Ley 1581/2012 — Habeas Data** en Colombia).

| Nivel | Qué separa | Cambio técnico | Costo incremental |
|---|---|---|---|
| **Hoy — lógico (RLS)** | Datos por `tenant_id` + RLS + convención de path en Storage | ninguno (ya implementado y auditado) | $0 |
| **1. Lógico reforzado** | Prefijo por institución + export/borrado por tenant | convención de path + job de export/purge | bajo (solo desarrollo) |
| **2. Bucket dedicado** | Bucket por institución (aísla ACLs, export/borrado regulatorio) | bucket por tenant + migración | bajo–medio |
| **3. Proyecto dedicado** | DB + storage + backups físicamente separados, opcional región específica | proyecto Supabase por institución | **~$25/mes por institución** → upsell "Enterprise/regulado" |

**Recomendación:** aislamiento lógico por RLS para la generalidad; **proyecto dedicado (Nivel 3)** como
**add-on Enterprise** con su costo trasladado, para quien lo exija por ley o contrato.

---

## 11. Conclusiones

1. **Costo variable = IA, y es pequeño.** Al ritmo real, la mayor institución gasta ~$0,32/mes; incluso
   en el escenario "típico maduro" el costo de IA es 6–31% del precio del plan según franja y modalidad.
2. **Costo fijo = un Supabase Pro (~$25/mes)** para todas las instituciones actuales; storage y email
   no son drivers.
3. **Palancas de margen:** BYO API key (IA a $0 para ExamLab), add-on medido, y la cola sync/async.
4. **Escalabilidad:** el modelo multi-tenant compartido soporta el crecimiento; la separación física por
   institución existe como add-on regulado con costo propio.

## 12. Monitoreo recomendado

Para recalibrar con datos propios a medida que crece la adopción:
- **`tutor_chat_messages`** (`prompt_tokens` / `completion_tokens`) → tokens reales del tutor.
- **Calificaciones IA** (`submissions`/`workshop_submissions`/`project_submissions` con `ai_grade`) → volumen real.
- **`storage.objects`** (suma de `metadata->>'size'`) → crecimiento de almacenamiento vs 100 GB incluidos.
- **`audit_logs`** acciones `ai.*` → frecuencia de operaciones de IA por tenant.

_Precios de terceros (Google, Supabase) sujetos a cambio — verificar en la fuente antes de cotizar en firme._

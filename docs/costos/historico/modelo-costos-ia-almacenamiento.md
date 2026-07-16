# Modelo de costos — IA y Almacenamiento (basado en datos)

> **Propósito:** sustentar el modelo de negocio de las propuestas comerciales con **datos reales**
> de la plataforma + **precios exactos** de Gemini + proyecciones por plan. Todo cálculo muestra
> su aritmética y marca qué es dato real vs supuesto.
>
> **Fecha:** 2026-07-07 · **Fuente de precios:** [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) (tier pago).
> **Snapshot de datos:** producción (6 tenants) al 2026-07-07.
>
> **⚠️ Planes y precios VIGENTES: ver [propuesta-v2.md](propuesta-v2.md)** (2026-07-15). Los
> **cálculos de costo** de abajo (IA por operación, por estudiante/matrícula, storage) siguen
> válidos y sustentan la v2; los nombres de plan (Esencial/Profesional/Institucional) y precios
> ($99/$299/$1.000…) son de **v1** — las columnas 250/500/1.000/1.500/5.000 son **tamaños de
> proyección**, no la grilla comercial vigente.

---

## 1. Datos reales de la plataforma (hoy)

| Métrica | Valor real (prod) |
|---|---|
| Tenants (instituciones) | 6 (mayor real: FESNA **190** estudiantes; resto ≤19) |
| Usuarios (profiles) | 276 (273 Estudiante · 58 Docente · 5 Admin · 1 SuperAdmin — hay multi-rol) |
| Cursos activos | 11 (13 incl. papelera) |
| Matrículas | 249 |
| Exámenes / Talleres / Proyectos (activos) | 13 / 13 / 2 |
| Entregas de examen | 113 (75 con calificación IA) |
| **Calificaciones IA totales (exam+taller+proyecto)** | **179** (75 exámenes · 90 talleres · 14 proyectos) |
| Calificaciones IA en cola | 71 `done` |
| Ventana de actividad real medida | **~2 meses** (2026-05-01 → 2026-06-30) |
| **Tutor IA — tokens por mensaje (REAL)** | **entrada 3.522 · salida 190** (7 mensajes assistant; máx 7.420 / 522) |
| **Tutor IA — volumen real** | **7 mensajes en total** en 3 sesiones (≈ uso incipiente) |
| Almacenamiento total | **47 MB** (86 objetos, 6 tenants — `generated-contents` 26,3 MB + 1 video 18,8 MB) |
| Material por curso (REAL) | **6,57 MB/curso** (promedio, 4 cursos con material) |
| Tamaño objeto: material / video / ZIP proyecto | 657 KB avg (máx 4 MB) / 19 MB / 24 KB avg (máx 94 KB) |

> Es una base **temprana y pequeña**; por eso el modelo usa **medición real por operación** (tokens
> del tutor, tamaños de objeto reales) y **proyecta** a las franjas de los planes (250 / 1.500 / 5.000).
>
> **Verificado el 2026-07-07** consultando producción directamente (SQL sobre la DB del proyecto
> `uxxpzfsfcnqiwwdxoelm`): las cifras de tenants/usuarios/roles/almacenamiento y los **tokens del
> tutor (3.522 / 190 exactos)** coinciden. La **intensidad de uso real** (§4.1) es hoy **muy inferior**
> a la proyección "típica" de §4 — la plataforma está en adopción temprana (parte de un semestre),
> así que las proyecciones son **techos conservadores**, no subestimaciones.

---

## 2. Precios exactos de Gemini (tier pago, por 1M tokens)

| Modelo | Entrada (texto) | Salida (incl. thinking) |
|---|---|---|
| **Gemini 2.5 Flash** *(default de ExamLab)* | **$0,30** | **$2,50** |
| Gemini 2.5 Flash-Lite | $0,10 | $0,40 |
| Gemini 2.5 Pro | $1,25 (≤200k) / $2,50 (>200k) | $10,00 (≤200k) / $15,00 (>200k) |

Fórmula de costo por llamada:

```
costo_USD = (tokens_entrada × precio_in + tokens_salida × precio_out) / 1.000.000
```

---

## 3. Costo de IA por operación (Gemini 2.5 Flash)

`REAL` = tokens medidos en prod. `EST` = estimado por la estructura del prompt (system prompt +
rúbrica/material + respuesta). Cámbialos por tus tokens reales en la fórmula de §2.

| Operación | tok entrada | tok salida | Aritmética | **Costo/op** |
|---|---|---|---|---|
| Tutor IA — 1 mensaje `REAL` | 3.522 | 190 | (3.522×0,30 + 190×2,50)/1e6 = (1.056,6+475)/1e6 | **$0,00153** |
| Asistente IA de plataforma — 1 msg `EST` | 6.000 | 300 | (1.800+750)/1e6 | **$0,00255** |
| Calificar entrega de examen `EST` | 4.000 | 600 | (1.200+1.500)/1e6 | **$0,00270** |
| Calificar taller (completo) `EST` | 8.000 | 800 | (2.400+2.000)/1e6 | **$0,00440** |
| Calificar proyecto (ZIP grande ~50k tok) `EST` | 50.000 | 1.000 | (15.000+2.500)/1e6 | **$0,01750** |
| Generar ~10 preguntas `EST` | 1.500 | 2.500 | (450+6.250)/1e6 | **$0,00670** |
| Generar contenido didáctico `EST` | 1.000 | 3.000 | (300+7.500)/1e6 | **$0,00780** |
| Detección de copia (por par) `EST` | 4.000 | 300 | (1.200+750)/1e6 | **$0,00195** |

**Con Gemini 2.5 Pro** (para calificación más exigente) el costo sube ~4× por la salida ($10 vs
$2,50): p. ej. calificar una entrega de examen ≈ (4.000×1,25 + 600×10)/1e6 = **$0,011** (vs $0,0027
con Flash). **Flash-Lite** baja ~5×: tutor ≈ $0,00043/mensaje.

---

## 4. Costo de IA por estudiante / mes

**Escenario típico (Flash)** — carga mensual realista de un estudiante activo:

| Uso mensual | Cantidad | Costo unit. | Subtotal |
|---|---|---|---|
| Exámenes calificados | 2 | $0,00270 | $0,00540 |
| Talleres calificados | 4 | $0,00440 | $0,01760 |
| Proyectos calificados | 0,5 | $0,01750 | $0,00875 |
| Mensajes al Tutor IA | 20 | $0,00153 | $0,03060 |
| **Total** | | | **≈ $0,062 / estudiante / mes** |

- **Escenario intensivo** (calificación con Pro + 60 mensajes de tutor) ≈ **$0,20 / estudiante / mes**.
- **Costo del docente** (generación): ~20 generaciones/mes × $0,007 ≈ **$0,14 / docente / mes** → despreciable.

**Rango de trabajo: $0,05–$0,20 por estudiante/mes** (típico ~$0,06 con Flash).

---

## 4.1. Uso REAL medido vs proyección, por tamaño de institución

> El escenario de §4 es una **proyección de adopción madura**. Contra los **datos reales** de prod
> (2026-07-07, ~2 meses de actividad) la intensidad de uso es **hoy mucho menor**. Presentamos las
> tres intensidades y las escalamos al tamaño de la institución para mostrar tanto el **piso real
> actual** como el **techo** a dimensionar.

**Intensidades (costo IA por estudiante/mes, Gemini 2.5 Flash):**

| Intensidad | Derivación | $/estud./mes |
|---|---|---|
| **Real medido (hoy)** | 179 calificaciones IA + 7 mensajes de tutor en ~2 meses sobre 249 matrículas → **0,36 calificaciones** y **~0,01 msgs de tutor** por estudiante/mes; costo ponderado real por calificación **$0,0047** (42% examen · 50% taller · 8% proyecto) | **≈ $0,0017** |
| **Típico maduro** (proyección §4) | 2 exámenes + 4 talleres + 0,5 proyectos + 20 msgs tutor / mes | **≈ $0,062** |
| **Intensivo (techo)** | calificación con Pro + 60 msgs tutor / mes | **≈ $0,20** |

**Costo de IA mensual por tamaño de institución** (estudiantes × intensidad):

| Institución (estudiantes) | Real medido ($0,0017) | Típico maduro ($0,062) | Intensivo ($0,20) |
|---|---|---|---|
| **FESNA — real hoy (190)** | **$0,32** | $11,8 | $38 |
| Esencial (250) | $0,43 | **$15,5** | $50 |
| Mediana (500) | $0,85 | $31 | $100 |
| Grande (1.000) | $1,70 | $62 | $200 |
| Profesional (1.500) | $2,55 | **$93** | $300 |
| Institucional (5.000) | $8,50 | **$310** | $1.000 |

**Lecturas:**
- La institución real más grande hoy (FESNA, 190 estudiantes) gastaría **~$0,32/mes de IA** al ritmo
  **medido** — dos órdenes de magnitud por debajo del precio de cualquier plan. El tutor IA está
  prácticamente sin usar (7 mensajes en total), así que su costo hoy es ruido.
- Las columnas "típico" e "intensivo" **coinciden con §5** (250 → $16/$50, 1.500 → $93/$300,
  5.000 → $310/$1.000): §5 dimensiona con el escenario maduro/techo — correcto para no subestimar.
- El **driver** del escenario típico es el tutor IA (20 msgs ≈ 50% del costo/estudiante). Si el tutor
  no despega, el costo real se queda cerca de la fila "real medido". Conviene **monitorear
  `tutor_chat_messages` y las calificaciones IA** para recalibrar la intensidad con datos propios.

---

## 5. Costo de IA por plan (y % del precio del plan)

Franjas de las propuestas: **Esencial 250 · Profesional 1.500 · Institucional 5.000** estudiantes.
Precio de plataforma (auto-administrado): **$99 / $299 / $1.000** al mes. Administrado: **$249 / $649 / $1.900**.

| Plan | Estud. | IA típico (Flash, ~$0,06/est) | IA intensivo (~$0,20/est) | IA típico como % del plan (auto/admin) |
|---|---|---|---|---|
| Esencial | 250 | **≈ $16/mes** | ≈ $50/mes | 16% / 6% |
| Profesional | 1.500 | **≈ $95/mes** | ≈ $300/mes | 32% / 15% |
| Institucional | 5.000 | **≈ $315/mes** | ≈ $1.000/mes | 32% / 17% |

**Lectura comercial:**
- El costo de IA es una fracción **minoritaria** del precio del plan en el escenario típico.
- **BYO API key** (la institución pone su clave de Google): la institución paga esos ~$16–$315/mes
  **directo a Google**, y ExamLab tiene **$0 de costo de IA** → margen intacto.
- **IA como add-on medido**: se factura sobre el consumo real (con la fórmula de §2) + un margen; el
  escenario intensivo es el techo a considerar para dimensionar el add-on.
- La **cola de procesamiento** (sync/async) permite **acotar el gasto**: en `async` la IA corre por
  lotes/cron y el Admin controla cuándo drena la cola → evita picos de consumo.

---

## 6. Almacenamiento — proyección y costo

**Supuestos** (marcados; ajustar con datos reales al crecer): material ~10 MB/curso (real hoy 6,57);
entrega de proyecto (ZIP) ~5 MB; ~2 proyectos/estudiante/año; videos subidos opcionales ~20 MB c/u
(las **grabaciones de clase** normalmente son **URL externa** — `recording_url` — y **no** ocupan storage).

| Plan | Cursos aprox. | Material | ZIPs de entregas | Videos | **Total aprox.** |
|---|---|---|---|---|---|
| Esencial (250) | ~10 | 100 MB | 2,5 GB | ~0,5 GB | **≈ 3 GB** |
| Profesional (1.500) | ~60 | 600 MB | 15 GB | ~3 GB | **≈ 19 GB** |
| Institucional (5.000) | ~200 | 2 GB | 50 GB | ~10 GB | **≈ 62 GB** |

**Costo de storage (Supabase):** el proyecto Pro (~$25/mes) **incluye 100 GB**; excedente a **$0,021/GB/mes**;
egress (descargas) ~$0,09/GB.

- Los 3 planes caben dentro de los **100 GB base** → **costo de almacenamiento ≈ incluido/insignificante**.
- Solo instituciones grandes que superen 100 GB pagan el excedente (p. ej. 150 GB → 50 GB × $0,021 ≈ **$1/mes**).
- **Conclusión:** el storage **no** es un driver de costo relevante a estas escalas; se **incluye en todos los planes**.

---

## 7. Separación por institución (regulación / data residency)

Requisito señalado: *"el día de mañana se debe separar más lógicamente cada institución por temas de
regulación"* (p. ej. **Ley 1581/2012 — Habeas Data** en Colombia, o cláusulas de residencia/segregación
de datos por contrato).

### Hoy — aislamiento **lógico** (un proyecto Supabase compartido)
- **DB:** RLS por `tenant_id` + funciones `current_tenant_id()` / `course_in_my_tenant()`; cada tabla
  hija scope-a al tenant del curso. (Auditado y endurecido; ver `../PLAN-ERRORES.md`.)
- **Storage:** buckets **compartidos**; cada objeto se aísla por RLS + convención de path
  (`<user_id>/...`, `<course_id>/...`, `<ticket_id>/...`). Backups compartidos.
- **Suficiente** para la mayoría de instituciones; el dato de una institución **no** es accesible por otra.

### Mañana — separación escalonada (roadmap, por nivel de exigencia regulatoria)

| Nivel | Qué separa | Cambio técnico | Costo incremental |
|---|---|---|---|
| **1. Lógico reforzado** | Prefijo dedicado por institución en cada bucket (`<tenant_slug>/…`) + retención/backup y **export/borrado por institución** (derecho de supresión) | Convención de path + RLS por prefijo + job de export/purge por tenant | Bajo (solo desarrollo) |
| **2. Bucket dedicado** | Un **bucket por institución** (aísla ACLs, simplifica export/borrado regulatorio y auditoría) | Bucket por tenant + RLS por bucket + migración de objetos | Bajo–medio (desarrollo + migración) |
| **3. Proyecto dedicado** | **DB + storage + backups físicamente separados**, opcionalmente en **región específica** (data residency) | Proyecto Supabase por institución (o por región) + orquestación de despliegue | **~$25/mes por institución** (Supabase Pro) + operación → **upsell "Enterprise/regulado"** |

**Recomendación:** hoy, aislamiento **lógico por RLS** para la generalidad; ofrecer el **proyecto
dedicado** (Nivel 3) como **add-on regulado** para instituciones que lo exijan por ley o contrato,
con su costo trasladado. Los niveles 1–2 son evolución natural del multi-tenant actual sin re-arquitectura.

---

## 8. Resumen para las propuestas

- **IA:** con **Gemini 2.5 Flash** el costo típico es **≈ $0,06/estudiante/mes** (rango $0,05–$0,20);
  por plan **≈ $16 / $95 / $315 al mes** — una fracción del precio. La institución **pone su API key**
  (paga a Google, $0 para ExamLab) **o** la toma como **add-on medido**. La **cola** acota el gasto.
- **Almacenamiento:** uso real bajísimo (47 MB/6 tenants; 6,57 MB/curso). Las proyecciones (3/19/62 GB)
  **caben en la base incluida** → **storage incluido en todos los planes**; excedentes triviales.
- **Regulación:** aislamiento **lógico** hoy (RLS + paths); **proyecto/bucket dedicado por institución**
  como camino para data residency/segregación estricta, ofrecido como **add-on Enterprise** con su costo.

_Precios de terceros (Google, Supabase) sujetos a cambio — verificar en la fuente antes de cotizar en firme._

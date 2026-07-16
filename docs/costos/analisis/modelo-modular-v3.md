# Modelo MODULAR v3 — sin Free, con bundles coherentes

> Reemplaza al histórico `modelo-negocio-modular.md` (v1/v2). Alineado con `modelo-precios-v3.md`, `add-ons.md`, `almacenamiento-esperado.md` e `infra-por-modelo-negocio.md`.
> Moneda **USD/mes** · Locale **es-CO** · IA = **BYO por defecto** ($0 de costo IA en la suscripción).
> **Regla dura de esta versión: NO existe plan Free.** El piso comercial es **Pequeña $149** (o **Starter $79** solo para piloto).

---

## 1. Filosofía modular v3

La modularidad de v3 **no** parte los features en piezas que se venden por separado (todos los planes traen el mismo producto). Parte en dos capas:

```
  BASE (obligatoria)                 +   ADD-ONS (a la carta, opcionales)
  ────────────────────                   ──────────────────────────────────
  Plan por MATRÍCULAS activas            IA administrada · Storage extra
  Pequeña / Mediana / Grande / Ent.      Code runner · Aislamiento dedicado
  (define tope de escala + soporte)      SSO/SAML · Certificación
  Opcional: Administrada +$300/mes
```

**Principios:**

1. **Toda venta arranca en un plan base por matrículas.** No se puede comprar un add-on "suelto" sin plan. El plan define la escala (tope de matrículas), el storage soft-cap y el nivel de soporte.
2. **Sin Free.** El piso es Pequeña $149. Existe **Starter $79 (≤200 matrículas)** como piso opcional **solo para pilotos** — más caro por matrícula ($0.40 vs $0.15 de Pequeña) a propósito, para promover al cliente a Pequeña al escalar. Starter **nunca** se combina con Administrada (el $225 de costo humano destruye el spread).
3. **IA = BYO por defecto.** La institución conecta su propia clave Gemini/OpenAI y le paga al proveedor directo → costo de IA en la suscripción ExamLab = **$0**. Costo típico para la institución con Gemini Flash: **~$0.06/matrícula/mes** (intensivo ~$0.20). Solo si el cliente no quiere gestionar la clave, contrata el add-on **IA administrada $0.10/matrícula/mes**.
4. **Los add-ons tienen sentido por PERFIL, no por antojo.** Cada add-on responde a una necesidad real de un tipo de institución (§2), y hay **reglas de coherencia** que impiden combinaciones que no aportan (§4).
5. **La infra es SIEMPRE de ExamLab.** No hay self-host. El aislamiento físico, cuando la ley lo exige, es un Supabase dedicado **gestionado por ExamLab** (add-on $99), nunca infra del cliente.

**Margen de referencia (modalidad AUTO):** infra fija compartida ≈ $51/mes; margen de planes **87–91%**. Los add-ons aportan **40–100%** de margen (promedio ~70%) y ~15–25% de revenue adicional sobre el plan base.

---

## 2. Catálogo de módulos / add-ons

Todos se venden **sobre un plan base**. La columna "Perfil para el que tiene sentido" es la guía de venta.

### 2.1. Planes base (la capa obligatoria)

| Plan | Precio | Matrículas | Storage | Soporte | Perfil típico |
|---|---|---|---|---|---|
| Starter *(piloto)* | $79 | ≤200 | 20 GB | Email | Colegio muy chico / docente independiente probando la plataforma |
| **Pequeña** | **$149** | ≤1.000 | 50 GB | Email 48h | Colegio mediano, academia, curso online independiente |
| **Mediana** | **$349** | ≤3.000 | 100 GB | Email 24h + prioridad | Instituto técnico, universidad pequeña (3–6 carreras) |
| **Grande** | **$799** | ≤10.000 | 200 GB | SLA 24h + Slack · **SSO + Reporting API incluidos** | Universidad mediana/grande (6+ carreras) |
| Enterprise | desde $1.499 | >10.000 | Custom | SLA 4h + gerente de cuenta | Universidad grande, multi-sede, regulada |

Modalidad **Administrada +$300/mes** disponible desde Pequeña (ExamLab opera el tenant). **NO** en Starter.

### 2.2. Add-ons recurrentes

| Add-on | Precio | Qué desbloquea | Plan mínimo | **Perfil para el que tiene sentido** |
|---|---|---|---|---|
| **IA administrada** | $0.10 / matr / mes | ExamLab gestiona la clave IA (sin BYO). Tope: 30 msgs Tutor + 6 calificaciones/matr/mes | Cualquiera | Institución **sin equipo técnico** que no quiere lidiar con Google Cloud + billing. Colegios, academias, institutos pequeños. **No** tiene sentido si el cliente ya tiene equipo TI (usan BYO gratis) |
| **Storage extra** | $10 / 100 GB / mes | Bloques de 100 GB sobre el soft-cap del plan | Cualquiera | Institución con **material propietario pesado no externalizable** (datasets, PDFs escaneados). *Antes de venderlo, ofrecer siempre externalizar video a URL — es gratis* |
| **Code runner ilimitado** | $49 / mes | Ejecución server-side Java/Python (AWS Lambda), GUI con Xvfb, tkinter, sin depender del navegador | **Mediana+** | **Facultad de ingeniería / programación** con exámenes de código semanales. Sin sentido en colegios de bachillerato o programas no técnicos |
| **Aislamiento dedicado** | $99 / mes | Supabase dedicado por tenant (DB + storage + backups separados), región específica opcional | **Grande / Enterprise** | Universidad **regulada** (Habeas Data Ley 1581/2012, GDPR, SOC2) o que exige data residency. Sin sentido a escala chica (margen no justifica la complejidad) |
| **SSO / SAML** | $99 setup + $29 / mes | Login con credenciales corporativas (Azure AD, Google Workspace, Okta, ADFS) | **Mediana+** *(incluido en Grande+)* | Universidad/instituto con **directorio institucional** y política de seguridad. Sin sentido para el docente independiente |
| **Certificación oficial** | $29 / mes | Certificados PDF con firma digital + QR verificable público, layout personalizable | Cualquiera | Programas con **certificado formal**: diplomados, educación continua, cursos que el alumno comparte en LinkedIn |

### 2.3. Servicios one-time (venta consultiva, no recurrentes)

| Servicio | Precio | Perfil |
|---|---|---|
| Import de datos legacy (Excel/CSV, otro LMS) | $300–800 flat | Cualquiera que migra |
| Branding avanzado (colores/fuentes/logos por rol) | $400 flat | Institución con identidad de marca fuerte |
| Report templates customizados | $500 flat | Institución con reportería regulatoria propia |
| Migración desde Moodle/Canvas | $1.500–3.000 flat | Universidad que abandona un LMS incumbente |
| Training docentes (workshop 2h remoto) | $200 / sesión | Cualquiera en onboarding |
| Consultoría estructura académica | $100 / hora | Universidad con mapeo carreras + pesos complejo |

---

## 3. Bundles recomendados COHERENTES por perfil

Cada combo está construido para que **cada pieza refuerce a la otra** y no haya add-ons huérfanos.

### Combo A — "Colegio pequeño" · plan base solo
> Bachillerato o academia con ≤800 matrículas, sin exámenes de código, sin certificado formal.

| Ítem | $/mes |
|---|---|
| Pequeña (AUTO) | 149 |
| IA: **BYO** (clave propia) | 0 |
| **Total** | **$149/mes** |

*Por qué es coherente:* no necesita code runner (no hay programación), ni aislamiento (no es regulado a esa escala), ni SSO (no hay directorio corporativo). El plan solo es lo correcto. Si no tiene equipo técnico para la clave IA → sumar **IA administrada** (~$50–80/mes a 500–800 matrículas).

---

### Combo B — "Facultad de Ingeniería" · Mediana + Code runner
> Universidad/instituto técnico, 1.500–3.000 matrículas, exámenes de programación Java/Python semanales.

| Ítem | $/mes |
|---|---|
| Mediana (AUTO) | 349 |
| **Code runner ilimitado** | 49 |
| SSO/SAML *(opcional, si hay directorio)* | 29 (+99 setup) |
| IA: **BYO** | 0 |
| **Total (sin SSO)** | **$398/mes** |
| **Total (con SSO)** | **$427/mes** + $99 setup |

*Por qué es coherente:* el code runner es **el** add-on que define este perfil (exige Mediana+, y aquí aplica). IA en BYO porque una facultad de ingeniería tiene equipo técnico. SSO opcional si la universidad ya tiene Azure AD/Google Workspace.

---

### Combo C — "Universidad regulada" · Grande + Aislamiento dedicado
> Universidad mediana/grande, 4.000–10.000 matrículas, sujeta a Habeas Data (Ley 1581/2012) o que exige data residency.

| Ítem | $/mes |
|---|---|
| Grande (AUTO) | 799 |
| **Aislamiento dedicado** (Supabase por tenant, gestionado por ExamLab) | 99 |
| SSO/SAML | **incluido** en Grande |
| Reporting API | **incluido** en Grande |
| Code runner *(si hay ingeniería)* | 49 |
| IA: **BYO** | 0 |
| Descuento pago anual −10% | −95 |
| **Total (con code runner, anual)** | **≈ $852/mes** ($10.224/año) |

*Por qué es coherente:* aislamiento exige Grande+ (aquí cumple). SSO y Reporting API **ya vienen incluidos** en el tier — no se cobran aparte (§4). Comparable Canvas a esa escala: $45k–135k/año → ahorro **78–92%**.

---

### Combo D — "Instituto con certificación" · Mediana + Certificación
> Instituto de educación continua / diplomados, 1.000–3.000 matrículas, emite certificados formales en volumen.

| Ítem | $/mes |
|---|---|
| Mediana (AUTO) | 349 |
| **Certificación oficial** (firma digital + QR) | 29 |
| IA administrada *(sin equipo TI)* | ~0.10 × matr |
| **Total (base)** | **$378/mes** + IA según matrículas |

*Ejemplo con 2.000 matrículas + IA administrada:* $349 + $29 + (2.000 × $0.10) = **$578/mes**.

*Por qué es coherente:* certificación es el add-on núcleo del perfil "diplomado". IA administrada tiene sentido aquí porque los institutos de educación continua rara vez tienen equipo Google Cloud. Sin code runner ni aislamiento (no aplican).

---

### Combo E — "Universidad grande operada por ExamLab" · Grande Admin + Aislamiento
> >6.000 matrículas, regulada, **sin equipo propio para operar** el tenant.

| Ítem | $/mes |
|---|---|
| Grande (AUTO) | 799 |
| **Administrada** (ExamLab opera el tenant) | 300 |
| **Aislamiento dedicado** gestionado por ExamLab | 99 |
| SSO + Reporting API | incluidos |
| **Total** | **$1.198/mes** |

*Por qué es coherente:* combina las dos palancas de mayor valor (operación + aislamiento) sobre el único tier que las soporta. Margen ExamLab ~72% (infra $80 + humano $225 + dedicado $30 = $335 vs $1.198).

---

### Tabla resumen de bundles

| Combo | Perfil | Total $/mes | Add-ons núcleo |
|---|---|---|---|
| A | Colegio pequeño | **$149** | ninguno (BYO IA) |
| B | Facultad de Ingeniería | **$398–427** | Code runner (+SSO opc.) |
| C | Universidad regulada | **≈$852** (anual) | Aislamiento (SSO/Reporting incluidos) |
| D | Instituto con certificación | **$378–578** | Certificación (+IA admin.) |
| E | Universidad grande operada | **$1.198** | Administrada + Aislamiento |

---

## 4. Reglas de coherencia

### 4.1. Add-ons que requieren plan mínimo

| Add-on | Plan mínimo | Motivo |
|---|---|---|
| Code runner ilimitado | **Mediana** | En Pequeña/Starter la ejecución básica ya está incluida (CheerpJ client-side + Lambda dentro del AWS free tier). Solo facultades con volumen semanal necesitan la garantía |
| Aislamiento dedicado | **Grande** | 8–16h de tech senior de setup + $25–30/mes de infra dedicada. A escala chica el margen (24%) no justifica la complejidad operativa |
| SSO/SAML | **Mediana** | Instituciones chicas no tienen directorio corporativo; el setup ($99) no se amortiza |

### 4.2. Add-ons INCLUIDOS sin cargo en tiers altos

| Feature | Incluido desde | Deja de venderse como add-on a partir de |
|---|---|---|
| **SSO/SAML** | **Grande** | Cobrarlo a un cliente Grande/Enterprise es un error de facturación |
| **Reporting API** | **Grande** (add-on en Mediana) | Ídem |
| **Backups extra** (30/90 días) | Mediana (30d) / Grande (90d) | No se vende storage de backup a estos tiers |
| Onboarding guiado (4h/8h) | Mediana / Grande | El training básico ya va incluido |

### 4.3. Combinaciones que NO tienen sentido (evitar venderlas)

| Combinación | Por qué NO |
|---|---|
| **IA administrada + cliente con equipo técnico** | El cliente puede usar BYO gratis (~$0.06/matr) en vez de pagar $0.10/matr. Solo cobrar IA administrada a quien explícitamente no quiere gestionar la clave |
| **Storage extra sin agotar el soft-cap** | Los caps sobran 3–7× para el cliente típico. Vender el bloque antes de agotar el cap incluido es cobro innecesario. **Ofrecer siempre primero externalizar video a URL (gratis)** |
| **Starter + Administrada** | El costo humano ($225) supera el spread del plan; no viable. Administrada arranca en Pequeña |
| **Aislamiento dedicado en Pequeña/Mediana** | No permitido (regla 4.1). El cliente regulado a esa escala debe subir a Grande, no comprar el add-on suelto |
| **Code runner en un colegio de bachillerato** | No hay exámenes de código. Add-on huérfano |
| **SSO en Starter / docente independiente** | No hay directorio corporativo que integrar |
| **IA administrada intensiva sin tope** | A uso intensivo (~$0.20/matr) el add-on da pérdida (−$0.10/matr). Aplicar **siempre** el tope duro (30 msgs Tutor + 6 calificaciones/matr/mes) o cobrar overage $0.15/matr |

### 4.4. Reglas de escalado automático

- **Sobreconsumo de matrículas:** al superar el cap 3 meses consecutivos → upgrade automático al plan siguiente (Pequeña→Mediana→Grande), documentado en contrato, sin nueva firma. No se corta el servicio.
- **Sobreconsumo de storage:** al 80% aviso, al 100% banner (sin cortar subida), mes siguiente se factura bloque de 100 GB.
- **Trigger operativo de storage** (interno, no del cliente): el límite muerde en el **agregado del Supabase compartido** (~15.000 matrículas totales / 100 GB), no en el tenant. A partir de ~10.000 matrículas agregadas → planificar migración de buckets pesados a Cloudflare R2 (elimina egress).

---

## 5. Outline de slides para la presentación (pptx a generar después)

> ~14 slides. Estilo: limpio, numérico, un mensaje por slide. En texto visible usar **"institución"**, nunca "tenant". Marca "Reto en vivo" (no "Kahoot") en material comercial.

1. **Portada** — "ExamLab · Modelo Modular v3 — Planes que crecen con tu institución". Sin Free, sin letra chica.
2. **El problema** — LMS incumbentes: caros (Canvas $45k–135k/año), rígidos, o gratis-pero-limitados (Moodle). ExamLab: el punto medio moderno con IA.
3. **Filosofía modular** — diagrama de 2 capas: BASE (plan por matrículas) + ADD-ONS a la carta. Mensaje: "pagás por escala, no por features fragmentados".
4. **Por qué NO hay Free** — piso $149 = compromiso serio, soporte real, margen sano. Starter $79 solo para piloto.
5. **Los 3 planes visibles** — tarjetas Pequeña $149 / Mediana $349 / Grande $799 + Enterprise. Diferencia = matrículas + soporte, mismo producto completo.
6. **Todo incluido en cualquier plan** — grid de features: cursos/exámenes/talleres/proyectos ilimitados, IA de calificación, Reto en vivo, encuestas, pizarra, foros, banco de preguntas, certificados QR, anti-plagio, multi-tenant aislado por RLS, backups.
7. **IA = BYO por defecto** — "conectá tu propia clave Gemini y pagá ~$0.06/matrícula al proveedor. ExamLab no marca sobreprecio de IA". Add-on IA administrada solo para quien no quiere gestionarla.
8. **Catálogo de add-ons** — tabla de los 6 recurrentes: qué desbloquea + precio + plan mínimo.
9. **Add-ons por perfil** — matriz visual: qué add-on aplica a colegio / instituto técnico / facultad de ingeniería / universidad regulada / programa con certificación.
10. **Bundles recomendados** — las 5 tarjetas de combos (A–E) con su total $/mes. El corazón de la presentación.
11. **Reglas de coherencia** — qué exige plan mínimo, qué viene incluido en tiers altos (SSO/Reporting en Grande), qué combinaciones evitar.
12. **Comparación de mercado** — barras: ExamLab Mediana $349 vs Moodle Cloud $98 (6× más matrículas) vs Canvas $2.500 (7× más barato) vs Blackboard $3k–8k.
13. **Modalidad Administrada** — "¿No tenés equipo para operar? Nosotros lo hacemos (+$300/mes)". Qué incluye (onboarding, bulk import, SLA 4h, reunión mensual).
14. **Cierre / CTA** — ejemplo de propuesta real (Combo C: Universidad regulada $852/mes vs Canvas $45k–135k/año → ahorro 78–92%) + "Agendá una demo".

*Slides opcionales para versión larga:* Programa de Aliados (Referido 10% 1er año · Comercial 15% recurrente · Premium 20% recurrente, ejemplos a precio Grande $799); Política de escalado automático; Servicios one-time de migración.

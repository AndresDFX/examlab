# 💰 Modelo económico ExamLab — documento principal

Hub de **costos, precios y modelos de negocio** de ExamLab. Empezá por acá y navegá
al documento que necesites con la tabla de contenido de abajo.

> **Estado:** la versión vigente es **v3 (2026-07)**, en [`analisis/`](analisis/).
> Los documentos v1/v2 quedaron archivados en [`analisis/historico/`](analisis/historico/) como
> referencia. Moneda **USD/mes** salvo donde se indique. Locale **es-CO**.

---

## 🚀 Empezá acá (según qué necesitás)

| Quiero… | Andá a |
|---|---|
| **Vender / cotizar** un cliente en 1 hoja | [`analisis/resumen-ejecutivo.md`](analisis/resumen-ejecutivo.md) |
| Ver los **planes y precios** vigentes | [`analisis/modelo-precios-v3.md`](analisis/modelo-precios-v3.md) |
| Entender el **costo real de infra** (qué pago yo) | [`analisis/analisis-infra-2026.md`](analisis/analisis-infra-2026.md) |
| Saber cuánto **storage** cubre cada plan y el precio del extra | [`analisis/almacenamiento-esperado.md`](analisis/almacenamiento-esperado.md) |
| Decidir **cómo vender** (licencia vs SaaS vs administrado) | [`analisis/infra-por-modelo-negocio.md`](analisis/infra-por-modelo-negocio.md) |
| Planear la **migración** para aislar clientes | [`analisis/plan-migracion-aislamiento.md`](analisis/plan-migracion-aislamiento.md) |
| **Simular** un número (X licencias → costo/precio) | [`analisis/calculadora.csv`](analisis/calculadora.csv) o el módulo in-app → [`analisis/modulo-superadmin-calculadora.md`](analisis/modulo-superadmin-calculadora.md) |
| Mostrarle la propuesta a un **cliente** | Presentación comercial → [`../demos/presentacion/ExamLab-Presentacion-Comercial-v3.pptx`](../demos/presentacion/ExamLab-Presentacion-Comercial-v3.pptx) |
| Reclutar un **aliado / revendedor** | [`../demos/correos/correo-aliados-asociacion.md`](../demos/correos/correo-aliados-asociacion.md) + [`../demos/presentacion/ExamLab-Presentacion-Aliados.pptx`](../demos/presentacion/ExamLab-Presentacion-Aliados.pptx) |

> ⚠️ **Cliente vs interno.** La **presentación comercial** (client-facing) muestra
> planes, storage y ahorro — **nunca** costos ni márgenes. Todo lo que tenga
> costo/margen (este folder `analisis/`) es de **uso interno**.

---

## 🎯 Los 4 modelos de negocio — un par de documentos por modelo

En la **raíz** de esta carpeta, cada modelo tiene un documento **INTERNO** (detalle de
costos/margen, NO enviar al cliente) y uno **CLIENTE** (para enviar junto con su presentación).

| # | Modelo | 🔒 Interno (costos) | 📤 Cliente (enviar) | 🖥️ Presentación adjunta |
|---|---|---|---|---|
| 1 | **Autogestionada** (sin admin mía — el cliente opera su tenant) | [interno](modelo-1-autogestionada-INTERNO.md) | [cliente](modelo-1-autogestionada-CLIENTE.md) | `ExamLab-Presentacion-Comercial-v3.pptx` |
| 2 | **Administrada** (con admin mía — yo opero el tenant) | [interno](modelo-2-administrada-INTERNO.md) | [cliente](modelo-2-administrada-CLIENTE.md) | `ExamLab-Presentacion-Comercial-Administrada.pptx` |
| 3 | **Independientes** (docente/profesional, con mi admin ligera) | [interno](modelo-3-independientes-INTERNO.md) | [cliente](modelo-3-independientes-CLIENTE.md) | `ExamLab-Presentacion-Independientes.pptx` |
| 4 | **Aliados** (canal por comisión %) | [interno](modelo-4-aliados-INTERNO.md) | [cliente](modelo-4-aliados-CLIENTE.md) | `ExamLab-Presentacion-Aliados.pptx` |

> En **todos** los modelos la **infra la provee ExamLab** (no self-host). La diferencia es
> **quién administra el tenant**. El análisis profundo que sustenta estos números vive en
> [`analisis/`](analisis/) (infra por modelo, precios, add-ons, storage, escenarios).

---

## 📚 Tabla de contenido

### 1. v3 — modelo vigente (`analisis/`)

| Documento | Para qué |
|---|---|
| [`analisis/README.md`](analisis/README.md) | Índice del modelo v3 + cambios vs v1/v2 + convención de facturación (por matrícula activa). |
| [`analisis/resumen-ejecutivo.md`](analisis/resumen-ejecutivo.md) | **One-pager comercial.** Precios + margen + comparables. |
| [`analisis/modelo-precios-v3.md`](analisis/modelo-precios-v3.md) | 3 planes (Pequeña/Mediana/Grande) + Enterprise + 6 add-ons, con racional de cada precio. |
| [`analisis/analisis-infra-2026.md`](analisis/analisis-infra-2026.md) | Costos verificados 2026-07 (Supabase/Lovable/AWS/dominio) + break-points de cada quota. |
| [`analisis/almacenamiento-esperado.md`](analisis/almacenamiento-esperado.md) | **Storage esperado por escala + por plan + precio del extra + Cloudflare R2.** (informe detallado v3) |
| [`analisis/add-ons.md`](analisis/add-ons.md) | Los 6 add-ons: precio, costo, margen, enforcement. |
| [`analisis/comparables-mercado.md`](analisis/comparables-mercado.md) | Moodle / Canvas / Blackboard / Chamilo 2026 + posicionamiento. |
| [`analisis/escenarios.md`](analisis/escenarios.md) | 6 clientes tipo con precio, costo, ganancia y payback. |
| [`analisis/calculadora.csv`](analisis/calculadora.csv) | Simulador para Excel/Sheets. |
| [`analisis/riesgos-y-supuestos.md`](analisis/riesgos-y-supuestos.md) | Supuestos, riesgos y palancas de mitigación. |

### 2. Modelos de negocio + infraestructura + migración (nuevo en v3)

| Documento | Para qué |
|---|---|
| [`analisis/infra-por-modelo-negocio.md`](analisis/infra-por-modelo-negocio.md) | **Costo de infra aproximado por cada modelo de negocio** (licencia sin admin mía / licencia con admin mía / SaaS independientes) a 200–10.000 matrículas, con margen y recomendación de mix. |
| [`analisis/plan-migracion-aislamiento.md`](analisis/plan-migracion-aislamiento.md) | **Plan de migración** Lovable → AWS / Supabase dedicado para aislar clientes (Habeas Data/SOC2), por fases, con recomendación por modelo. |
| [`analisis/modulo-superadmin-calculadora.md`](analisis/modulo-superadmin-calculadora.md) | **Plan de la feature in-app** (SuperAdmin) que calcula costo + precio de venta con margen parametrizable para X licencias. |

### 3. Presentaciones (`../demos/presentacion/`)

| Deck | Audiencia | Estado |
|---|---|---|
| `ExamLab-Presentacion-Comercial-v3.pptx` | Cliente | **Vigente (v3)** — planes, **storage por plan + extra**, comparativa, ahorro. Generado por [`analisis/_gen-presentacion.py`](analisis/_gen-presentacion.py). |
| `ExamLab-Presentacion-Aliados.pptx` | Aliados/revendedores | Programa de comisiones (Referido 10% / Comercial 15% / Premium 20%) con ejemplos a precio v3. |
| `ExamLab-Presentacion-General.pptx` | General (v1/v2) | Histórica — recorrido de producto. |
| `ExamLab-Presentacion-Modelo-Modular.pptx`, `-Comercial.pptx`, `-Comercial-Administrada.pptx`, `-Independientes.pptx` | Varias (v1/v2) | Históricas. |

### 4. Histórico v1/v2 (`analisis/historico/`)

Modelo v1/v2 (precios y escalera anteriores) — **superado por `analisis/`**, se conserva como referencia:
[`analisis/historico/resumen-ejecutivo.md`](analisis/historico/resumen-ejecutivo.md) ·
[`analisis/historico/analisis-costos.md`](analisis/historico/analisis-costos.md) ·
[`analisis/historico/modelo-costos-ia-almacenamiento.md`](analisis/historico/modelo-costos-ia-almacenamiento.md) ·
[`analisis/historico/modelo-negocio-modular.md`](analisis/historico/modelo-negocio-modular.md) ·
[`analisis/historico/propuesta-v2.md`](analisis/historico/propuesta-v2.md).

---

## 🔑 Fundamentos del modelo v3 (resumen de una línea)

- **Stack:** Lovable (hosting SPA, $25) + Supabase Pro ($25) + AWS Lambda (code runner, free tier) + dominio ($1) ⇒ **~$51/mes fijo compartido**. IA = **BYO** (la paga el cliente) ⇒ $0 IA para ExamLab.
- **Facturación por matrícula activa** (no por cabezas). Costo marginal $0.007–0.02/matrícula/mes al escalar.
- **Planes:** Pequeña $149 (≤1.000, 50 GB) · Mediana $349 (≤3.000, 100 GB) · Grande $799 (≤10.000, 200 GB) · Enterprise custom. Administrada +$300/mes. Storage extra $10/100 GB.
- **Tres modelos de negocio** (ver [`infra-por-modelo-negocio.md`](analisis/infra-por-modelo-negocio.md)): licencia self-host (mi infra ≈ $0), licencia dedicada gestionada (aislada, yo opero), SaaS compartido (independientes).

> Los precios de terceros cambian ~2×/año — reverificá en las páginas oficiales antes de firmar (links en `analisis/analisis-infra-2026.md`).

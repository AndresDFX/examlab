# Modelo de negocio modular — ExamLab

> Documento de producto · versión final recomendada
> Autor: Liderazgo de producto · Locale: es-CO · Moneda: USD/mes
>
> **⚠️ Segmentación, precios y métrica VIGENTES: ver [propuesta-v2.md](propuesta-v2.md)** (2026-07-15).
> Este doc aporta la **arquitectura modular de gating/planes**; la segmentación por tamaño
> (Pequeña ≤1.500 / Mediana ≤10.000 / Grande >10.000), los precios y la facturación por **matrículas**
> vigentes están en la v2. **Reconciliación resuelta** en §2 ("Reconciliación con propuesta-v2").

---

## 1. Resumen ejecutivo

### Estrategia elegida: **escalera de valor** (con criterio de corte por persona)

De las cuatro propuestas evaluadas, la de **valor** obtuvo el puntaje más alto (40/50) por ser la escalera más limpia, comercialmente madura y técnicamente honesta. La adoptamos como **columna vertebral**, pero le injertamos las mejores ideas de las otras tres:

- **De `persona`** (39/50): el criterio de *qué entra en cada plan* no es arbitrario — es el *job-to-be-done* real del segmento. El docente independiente no toca `users`/`academic`/`audit_logs`; la institución sí. Esto hace el upsell intuitivo y defendible.
- **De `mercado`** (38/50): nombres de plan que mapean un modelo mental limpio y `upsellHook` que nombran *la capacidad que falta*. Rescatamos también la disciplina de la narrativa "cada plan deja ganas de subir".
- **De `costo`** (36/50): el rigor de aislar **los tres únicos drivers de costo variable** (IA/Gemini, code-runner AWS Lambda, almacenamiento de video) y venderlos como *gate de tier* **y** *add-on medido* a la vez. Y el uso de **BYOK** (API key propia del tenant) como palanca de margen.

### La decisión estratégica central (rescatada de las 4 evaluaciones)

Las cuatro `mejorIdea` convergen en **el mismo hallazgo**, y es el eje de todo el modelo:

> **La IA embebida (generar + calificar) NO es un módulo del sidebar: es el ancla de upsell.**
> Es simultáneamente **el mayor diferenciador** de ExamLab **y su mayor costo variable**. Gatearla en el borde Free→pago deja el Free a **costo marginal casi cero** para nosotros, mientras concentra todo el deseo de upgrade en un solo dolor sentido: **"dejá de calificar a mano"**.

Esa coincidencia *deseo-máximo = costo-máximo* en el mismo umbral es lo que hace del Free un **gancho sostenible** en vez de un centro de costo. Y su corolario — **BYOK lleva el costo de IA a ~$0** — convierte la palanca de costo en palanca de margen en los planes altos.

### Correcciones aplicadas sobre la propuesta ganadora

1. **`whiteboards` + `polls` bajan a Esencial** (crítica de "justicia" en la evaluación de valor): engagement en vivo (pizarra, encuestas/Kahoot) es pedagogía activa básica y de **bajo costo** (Excalidraw es client-side, las encuestas son filas de DB). Ponerlo detrás de la barrera de IA castiga a un colegio chico que solo quiere encuestas en vivo.
2. **El "missing middle"** entre Profesional ($299) e Institucional ($999) se desactiva con **add-ons de code-runner y proctoring sobre Profesional** (ya contemplado; lo hacemos explícito).
3. **Traducción de slugs a beneficios**: las tablas comerciales NO exponen `teacher_students`/`ai_cron`/`trash`; se muestran como bundles de beneficio (ver §2). Los `module_key` reales viven en el mapeo técnico (§4).

### Advertencia de factibilidad que condiciona el lanzamiento

Verificado contra el código (`src/hooks/use-module-visibility.ts` + `tg_provision_tenant_defaults`):

- **`module_visibility` es un gate de NAV/route-guard, no un paywall duro.** Oculta el sidebar y la ruta, pero la RLS gatea por **rol + tenant**, no por plan. No frena llamadas REST directas.
- **NO existe el concepto "plan"** (no hay `tenants.plan` ni tabla de planes). Hay que construirlo (columna + templates por plan + applier de re-seed).
- **Default-true = fuga de gating**: "sin fila" significa **VISIBLE**. Cada módulo gateado exige sembrar `enabled=false` explícito por rol.
- **Las dos palancas que de hecho monetizan no son `module_key`**: la IA embebida (generar/calificar) y `proctoring`/`code-runner`. Se gatean con **flags de entitlement a nivel plan + enforcement server-side**, no con `module_visibility`.

Todo esto está desarrollado en §4 y §7.

---

## 2. Los planes finales

Cuatro planes en escalera acumulativa (cada tier = el anterior + más), sobre un eje de escala legible: **50 / 250 / 1.500 / 5.000 estudiantes**.

| Plan | A quién apunta | Precio (USD/mes) | Incluye (en lenguaje de beneficio) | Bloqueado (gated) | Gancho de upsell |
|---|---|---|---|---|---|
| **Aula** *(Gratis)* | Docente individual, colegio en piloto, academia probando la plataforma. **Cap duro: 1 curso activo, ≤50 estudiantes.** | **$0** | Dar clase completo: cursos, contenidos, exámenes y talleres, libro de calificaciones, notas, asistencia, calendario, mensajería y notificaciones. **Calificación 100% manual (sin IA).** | Proyectos, foro, banco de preguntas, videos, IA, tutor, analítica, certificados, integridad de examen, soporte PQRS. | "Podés dar clase y evaluar, pero calificás a mano y topás en 1 curso / 50 alumnos. Para proyectos, banco de preguntas, foro y quitar el tope → **Esencial**." |
| **Esencial** | Colegio pequeño, instituto, academia. Hasta **250 estudiantes**. Evaluación digital completa pero **manual**. | **~$79** *(franja 250)* | Todo lo de Aula **+ proyectos, foro, banco de preguntas, biblioteca de videos, pizarras y encuestas/Kahoot en vivo, soporte PQRS, auditoría básica.** Sin límite de cursos. | IA (generar/calificar/tutor), estructura académica, estadísticas, integridad de examen, code-runner, certificados, informes con variables, asistente IA de plataforma. | "Evaluás y das clase completo, con engagement en vivo — pero generás y calificás **a mano**. El día que querés que la IA lo haga, más tutor para el alumno → **Profesional**." |
| **Profesional** | Universidad pequeña/mediana o institución con evaluación digital seria y estructura académica. Hasta **1.500 estudiantes**. | **~$299** self · *(managed con recargo de servicio)* | Todo lo de Esencial **+ IA embebida (generar + calificar + detección de copia), Tutor IA para el alumno, estructura académica (sílabo/pesos/periodos), personalización y gobierno de prompts de IA, cola/monitor de IA, estadísticas.** | Proctoring anti-fraude, ejecución de código (Java/Python), certificados oficiales, informes con variables, asistente IA de plataforma, soporte administrado. | "Ya tenés IA + engagement + analítica. Pero tus exámenes no tienen anti-fraude ni ejecución de código, no emitís certificados oficiales ni informes con variables → **Institucional**." |
| **Institucional** | Universidad grande o institución acreditada, con exámenes de alto riesgo, programación y certificación oficial. Hasta **5.000 estudiantes** (escalable con add-ons). | **~$999** self · **~$1.900** administrado *(franja 5.000)* | **Todo el catálogo.** Suma proctoring (fullscreen/advertencias/detección IA), ejecución de código en exámenes y talleres, certificación oficial, informes con variables, asistente IA de plataforma para el equipo admin, soporte administrado con SLA. | — *(nada gated a nivel módulo)* | "Techo del catálogo. El siguiente paso es **Red educativa** (multi-sede, SSO/SAML, integración SIS, SLA dedicado) y overage medido: estudiantes extra, code-runner por ejecución, storage de video y BYOK con descuento." |

### Notas de precio

- Los precios están anclados al pricing actual ($99/$299/$1.000 self · $1.900 managed) y a los drivers de costo reales. Esencial baja de $99 porque **quita IA** (costo IA ~$0) y solo suma almacenamiento + soporte.
- El costo de IA por franja (Gemini Flash a ~$0,06/est-mes): ~$16/mes @250 · ~$95/mes @1.500 · ~$315/mes @5.000. Profesional absorbe ese costo con margen; **BYOK lo lleva a ~$0** (descuento posible).
- **Modo administrado** = capa de *servicio* (onboarding + operación gestionada), aplicable como recargo sobre cualquier plan pago. No es un tier aparte; replica la diferencia self-managed vs administrado del pricing actual.
- El eje de **estudiantes** (50/250/1.500/5.000) es **ortogonal** al gating de módulos: se vende como bloques adicionales sin cambiar el set de `module_visibility` (ver §3).

### Reconciliación con propuesta-v2 (decisión de producto · 2026-07-15)

[propuesta-v2.md](propuesta-v2.md) es la fuente **vigente** de segmentación, precios y métrica de
facturación. Este documento aporta la **arquitectura de gating por módulos** (§4), que sigue válida.
Se reconcilian en **dos dimensiones ortogonales**:

- **(A) Qué incluye cada plan** = la escalera modular de arriba (Aula → Esencial → Profesional →
  Institucional). Es el `module_visibility` + entitlements de §4. **Se conserva.**
- **(B) Cuánto cuesta según tamaño** = las **franjas de v2** (Pequeña ≤1.500 · Mediana ≤10.000 ·
  Grande >10.000, con los precios de propuesta-v2 §2). El eje de tamaño de este doc
  (50/250/1.500/5.000) queda **reemplazado por las franjas de v2** al cotizar.
- **Free "Aula" (≤50): se conserva** como tier de adquisición/piloto **gratis**, por **debajo** de la
  Pequeña-entrada (≤500) de v2 — es el funnel de entrada, no una franja paga.
- **Métrica: matrículas activas por período** (no estudiantes-cabeza; v2 §1). Los topes
  50/250/1.500/5.000 se leen como **matrículas**.
- **⚠️ Cambio de estrategia de IA (vigente = v2):** este doc gateaba la IA como **upsell premium**
  (recién desde Profesional). **v2 la incluye en TODAS las franjas** (con tope de consumo o BYO a
  mayor escala) como diferenciador de adquisición. **Rige el modelo de v2 (IA incluida-con-tope);**
  el gating de IA como feature premium de la tabla de arriba queda superado por esa decisión. (Si
  negocio prefiere volver a IA-como-upsell, es el único punto a revertir.)

---

## 3. Add-ons medidos

Convierten el **costo variable en ingreso variable** y desactivan el "missing middle". Se venden a la carta **sin forzar salto de tier**. Todos exigen la capa de medición/cuota que hoy NO existe (ver §4 y §7).

| Add-on | Qué desbloquea / cubre | Unidad de medida | Dónde se enforza (NO es `module_visibility`) |
|---|---|---|---|
| **IA por consumo** | Bolsa de generación+calificación IA. Da cupo de IA a Esencial; cubre overage en Profesional/Institucional. | Por estudiante-mes o por 1.000 calificaciones (passthrough Gemini ~$0,06/est) | Flag de entitlement de IA a nivel plan + `ai_model_settings`/`processing_mode` + caps en los ~7 edges de IA |
| **code-runner** | Ejecución de código Java/Python en exámenes/talleres para un tenant Profesional sin saltar a Institucional. | Por ejecución o por minuto de cómputo AWS Lambda | `code_execution_settings` (provider por tenant) + edge `execute-code` |
| **Almacenamiento de video** | GB sobre el cupo del plan (el driver que más crece). | Por GB/mes sobre cuota | Cuota del tenant (`TenantQuotaCard`) — medición de uso del bucket |
| **Proctoring** | Sesión de examen supervisado (fullscreen/warnings/detección IA) para Profesional. | Por asiento-examen supervisado | Flag de plan + campos de proctoring del examen (`navigation_type`, warnings, `ai_detected`) |
| **Certificados** | Credenciales oficiales para Esencial/Profesional que emiten poco volumen. | Por certificado emitido | `module_key` `certificates` habilitado + contador de emisiones |
| **Tutor IA** | Volumen de mensajes/tokens del Tutor por encima del fair-use del plan. | Por interacción / tokens Gemini | Flag de entitlement de IA (el Tutor lee material → consumo variable) |
| **Estudiantes adicionales** | Bloques sobre la franja del plan. | Por bloque sobre 250/1.500/5.000 | Cap del tenant (sube el límite, no cambia módulos) |
| **Modo administrado** | Onboarding + operación gestionada. | Recargo de servicio mensual | Contrato / servicio (no técnico) |

**BYOK (Bring Your Own Key):** el tenant trae su propia API key de Gemini/OpenAI (ya soportado por el failover de `ai_model_settings` — `gemini_fallback_keys`/`openai_fallback_keys`). Lleva el costo de IA de ExamLab a **~$0**. Se ofrece como **descuento** en Profesional/Institucional o como **"IA sin tope"**. Protege el margen justo en el tier de mayor consumo.

---

## 4. Mapeo técnico

### 4.1 `module_key` reales por plan

Universo de `module_key` (union en `src/hooks/use-module-visibility.ts`), **excluyendo `tenants` y `system`** (son del SuperAdmin, cross-tenant, nunca parte de un plan vendible).

Leyenda: ✅ `enabled=true` · ⬜ `enabled=false` (sembrado explícito). **`proctoring` y `code-runner` NO son `module_key`** → se gatean por flag de plan (fila final, aparte).

| `module_key` | Aula (Free) | Esencial | Profesional | Institucional | Rol(es) al que aplica el seed |
|---|:---:|:---:|:---:|:---:|---|
| `dashboard` | ✅ | ✅ | ✅ | ✅ | todos |
| `courses` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `contents` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `exams` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `workshops` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `gradebook` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `grades` | ✅ | ✅ | ✅ | ✅ | Estudiante |
| `attendance` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `calendar` | ✅ | ✅ | ✅ | ✅ | todos |
| `notifications` | ✅ | ✅ | ✅ | ✅ | todos |
| `messages` | ✅ | ✅ | ✅ | ✅ | todos |
| `users` | ✅ | ✅ | ✅ | ✅ | Admin |
| `configuration` | ✅ | ✅ | ✅ | ✅ | Admin |
| `trash` | ✅ | ✅ | ✅ | ✅ | Docente, Admin |
| `teacher_students` | ✅ | ✅ | ✅ | ✅ | Docente |
| `projects` | ⬜ | ✅ | ✅ | ✅ | Docente, Admin |
| `forum` | ⬜ | ✅ | ✅ | ✅ | todos |
| `question_bank` | ⬜ | ✅ | ✅ | ✅ | Docente, Admin |
| `videos` | ⬜ | ✅ | ✅ | ✅ | Docente, Admin |
| `whiteboards` | ⬜ | ✅ | ✅ | ✅ | Docente, Admin |
| `polls` | ⬜ | ✅ | ✅ | ✅ | Docente, Admin |
| `audit_logs` | ⬜ | ✅ | ✅ | ✅ | Admin |
| `support` | ⬜ | ✅ | ✅ | ✅ | Admin |
| `academic` | ⬜ | ⬜ | ✅ | ✅ | Docente, Admin |
| `tutor` | ⬜ | ⬜ | ✅ | ✅ | **Estudiante** |
| `ai_prompts` | ⬜ | ⬜ | ✅ | ✅ | Docente, Admin |
| `ai_cron` | ⬜ | ⬜ | ✅ | ✅ | Docente, Admin |
| `statistics` | ⬜ | ⬜ | ✅ | ✅ | Docente, Admin |
| `reports` | ⬜ | ⬜ | ⬜ | ✅ | Docente, Admin |
| `certificates` | ⬜ | ⬜ | ⬜ | ✅ | Docente, Admin |
| `support_assistant` | ⬜ | ⬜ | ⬜ | ✅ | Admin |
| **Flag IA embebida** *(no módulo)* | OFF | OFF *(o BYOK/add-on)* | **ON** | **ON** | entitlement de tenant |
| **`proctoring`** *(flag, no módulo)* | OFF | OFF | OFF *(add-on)* | **ON** | flag de plan |
| **`code-runner`** *(flag, no módulo)* | OFF | OFF | OFF *(add-on)* | **ON** | flag de plan |

> **Rol del seed:** el `tutor` solo aplica a **Estudiante**; `ai_prompts`/`ai_cron`/`statistics`/`reports`/`certificates`/`academic` a **Docente/Admin**; `support_assistant`/`support`/`audit_logs`/`users`/`configuration` a **Admin**. Un seed a un rol equivocado deja el módulo invisible o visible donde no debe.

### 4.2 Cómo encaja con `tg_provision_tenant_defaults`

Estado actual verificado:
- `module_visibility(tenant_id, module_key, role, enabled, display_order)` es real, con **merge tenant-sobre-global**.
- `tg_provision_tenant_defaults` **snapshotea las filas por tenant al crear el tenant** — pero snapshotea del **GLOBAL**, no de un template por plan.
- **NO existe `tenants.plan` ni tabla de planes.** Hay que construirlo.

Trabajo net-new requerido (no es re-arquitectura, pero tampoco es "solo un toggle"):

1. **Columna de plan**: `tenants.plan TEXT` (`aula` | `esencial` | `profesional` | `institucional`) + `tenants.ai_enabled BOOLEAN`, `tenants.proctoring_enabled BOOLEAN`, `tenants.code_runner_enabled BOOLEAN` (los 3 flags de entitlement que **no** son `module_key`). Alternativa: una tabla `tenant_entitlements` o columnas JSONB en `platform_settings` por tenant.
2. **Templates por plan**: una tabla `plan_module_defaults(plan, module_key, role, enabled)` o un mapa en código, que define la matriz de §4.1.
3. **Applier idempotente** `apply_plan_to_tenant(_tenant_id, _plan)`:
   - Hace `UPSERT` sobre `module_visibility` con `enabled` según el template del plan, **por cada `(module_key, role)` de la matriz** — incluyendo los `enabled=false` explícitos (crítico por el default-true, ver abajo).
   - Setea los 3 flags de entitlement (`ai_enabled`, `proctoring_enabled`, `code_runner_enabled`) según el plan.
4. **Extender `tg_provision_tenant_defaults`**: al crear el tenant, en vez de copiar el global, llama `apply_plan_to_tenant(NEW.id, NEW.plan)` con el plan elegido (default `aula`).

> ⚠️ **Default-true = fuga de gating.** Tanto el hook (`use-module-visibility.ts`, ~línea 227) como el SQL tratan **"sin fila" = VISIBLE**. Por eso cada módulo gateado exige sembrar `enabled=false` **explícito por rol**, y **cualquier módulo nuevo que se agregue al código queda visible en TODOS los planes** hasta que alguien lo siembre en `false`. **Regla operativa:** al agregar un `module_key` nuevo, actualizar `plan_module_defaults` en el mismo PR (sembrarlo `false` en los planes que no lo incluyen).

### 4.3 Upgrade / downgrade — sin perder datos

`module_visibility` controla **visibilidad de nav/ruta**, no borra datos. Por eso subir/bajar de plan es seguro para los datos:

- **Upgrade** (ej. Esencial → Profesional): `apply_plan_to_tenant(tenant, 'profesional')` hace `enabled=true` de los módulos nuevos (`academic`, `tutor`, `ai_prompts`, `ai_cron`, `statistics`) y enciende `ai_enabled=true`. Los datos previos intactos; aparece el nav nuevo.
- **Downgrade** (ej. Profesional → Esencial): `apply_plan_to_tenant(tenant, 'esencial')` hace `enabled=false` de esos módulos y apaga `ai_enabled`. **Los datos NO se borran** — quedan inaccesibles desde el nav hasta que se re-suba de plan. Ej.: los prompts de IA personalizados, las estadísticas y la estructura académica persisten; solo se ocultan.
- **Caso especial IA / proctoring / code-runner**: como se gatean por **flag de entitlement server-side** (no por `module_visibility`), el downgrade debe **apagar el flag** para que el enforcement en los edges/settings deje de permitir la operación. Ocultar el nav no basta: los botones "generar/calificar con IA" viven **dentro** de los editores de exámenes/talleres que Esencial YA tiene. **Sin el flag enforced en los ~7 edges de IA, un Esencial degradado seguiría calificando con IA por la UI existente.**

### 4.4 Enforcement duro vs. muro suave

| Palanca | Mecanismo | ¿Paywall duro? |
|---|---|---|
| Módulos de nav (`projects`, `forum`, `academic`, `tutor`, `statistics`…) | `module_visibility` (nav + route-guard) | **Muro suave.** Oculta menú y ruta; alcanzable por URL si el guard falla. Aceptable para features de UI. |
| **IA embebida** (generar/calificar/tutor) | Flag `tenants.ai_enabled` **enforced en los ~7 edges de IA** (`ai-generate-questions`, `ai-grade-submission`, `generate-contents`, `tutor-chat`, `ai-generate-report`, `evaluate-exam-time`, `detect-plagiarism`) + `ai-generation-worker` | **Requiere build.** `processing_mode` es sync/async, **no** enablement. Hay que agregar el chequeo del flag al inicio de cada edge. |
| **proctoring** | Flag `tenants.proctoring_enabled` + validación en la creación/config del examen | **Requiere build.** Campos de proctoring del examen + gate de plan. |
| **code-runner** | Flag `tenants.code_runner_enabled` + `code_execution_settings` + edge `execute-code` | **Requiere build.** El edge debe rechazar si el tenant no tiene entitlement. |
| **Metering / overage** (add-ons medidos) | Contadores de uso por tenant + billing usage-based | **No existe hoy.** Es build net-new (contadores + caps + facturación). |

---

## 5. Reglas de "núcleo mínimo"

**Piso funcional que SIEMPRE está `enabled` en todo plan, incluido el Free.** Garantiza que el plan base sea un producto usable de verdad, no crippleware, y que **el ciclo pedagógico completo funcione** (nunca se vende un plan donde el alumno no ve su nota).

**Núcleo mínimo (15 `module_key`):**

```
dashboard · courses · contents · exams · workshops · gradebook · grades
attendance · calendar · notifications · messages · users · configuration
trash · teacher_students
```

Con esto, cualquier tenant (aun gratis) puede: **crear curso → subir contenidos → armar exámenes y talleres → calificar (manual) → registrar asistencia → ver el calendario → comunicarse por mensajes → ver notas el estudiante**. Es el "loop del aha".

**Invariantes del núcleo:**
- La **calificación siempre funciona** (manual). Lo que se gatea es la *automatización* (IA), no el acto de calificar.
- El **estudiante siempre ve su nota** (`grades` nunca se gatea).
- Módulos operativos (`dashboard`, `notifications`, `users`, `configuration`, `trash`, `messages`) están ON en todo plan pago; en el Free se recorta `support` (solo comunidad) y `audit_logs` como primer gancho.
- **`tenants` y `system` NUNCA entran en un plan** — son módulos del SuperAdmin (operación de plataforma cross-tenant).

---

## 6. Migración desde el modelo "todo incluido" actual

Los tenants existentes hoy tienen **todo habilitado**. La migración debe ser **cero-sorpresa** para no generar churn ni resentimiento.

### 6.1 Grandfathering (derechos adquiridos)

- **Todo tenant activo pre-lanzamiento del modelo se marca `plan='institucional'` con flag `grandfathered=true`** y **conserva su precio actual**. No pierde ningún módulo el día del cambio.
- El grandfathering se mantiene **mientras el tenant no cambie de plan voluntariamente**. Si baja de plan, entra al pricing nuevo (sin retorno al precio viejo).
- Comunicación: correo + banner in-app 30 días antes: *"Tu plan actual pasa a llamarse Institucional y conservás todo lo que ya tenés, al mismo precio. Los planes nuevos son para tus futuras renovaciones/nuevas sedes."*

### 6.2 Secuencia técnica de migración

1. **Publicar** la columna `tenants.plan` + flags de entitlement + `plan_module_defaults` + `apply_plan_to_tenant` (§4.2). **Sin activar enforcement todavía.**
2. **Backfill**: `UPDATE tenants SET plan='institucional', grandfathered=true` para todos los existentes. Setear `ai_enabled/proctoring_enabled/code_runner_enabled = true` en ellos.
3. **Sembrar `enabled=false` explícito** donde corresponda para tenants NUEVOS (los grandfathered quedan todos `true`). Esto ataja la fuga default-true.
4. **Activar enforcement de IA/proctoring/code-runner en los edges** — pero con un *bypass* para `grandfathered=true` o `ai_enabled=true`, de modo que ningún tenant existente note el cambio.
5. **A partir de la fecha de corte**, todo tenant NUEVO se provisiona con su plan real (default `aula`).

### 6.3 Clientes que quieran bajar de plan

Un tenant grandfathered que hoy usa poco (ej. no toca IA ni code-runner) podría **querer bajar** a Esencial para pagar menos. Es un riesgo de ingreso (ver §7). Mitigación: el downgrade es autoservicio pero muestra claramente **qué pierde** (IA, proctoring, certificados, informes) antes de confirmar.

---

## 7. Riesgos y mitigaciones

| # | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| 1 | **Fuga de gating por default-true.** Un módulo sin fila `enabled=false` queda VISIBLE en todos los planes; peor aún, cualquier `module_key` nuevo del código se filtra a planes bajos. | **Alta** | `apply_plan_to_tenant` siembra `false` EXPLÍCITO por rol. Test de CI que verifica que cada `module_key` del union tiene fila en `plan_module_defaults` para los 4 planes. Regla: agregar `module_key` nuevo ⇒ actualizar el template en el mismo PR. |
| 2 | **El gate de IA es débil técnicamente.** `module_visibility` oculta `ai_cron`/`ai_prompts`/`tutor`, pero los botones "generar/calificar con IA" viven DENTRO de los editores que Esencial ya tiene. `processing_mode` es sync/async, no enablement. | **Alta** | Construir flag `tenants.ai_enabled` **antes de lanzar** y enforcarlo al inicio de los ~7 edges de IA + el worker. Sin esto, retirar IA de Esencial es imposible y el modelo entero se cae. |
| 3 | **`proctoring` y `code-runner` no son `module_key`.** No se gatean flipeando una fila. | Media | Flags `tenants.proctoring_enabled`/`code_runner_enabled` enforced en la config del examen y en el edge `execute-code`/`code_execution_settings`. |
| 4 | **Metering inexistente.** Los add-ons medidos (IA por consumo, code-runner por ejecución, GB de video, estudiantes extra) requieren contadores de uso + billing usage-based que hoy no existen. | **Alta** | Roadmap explícito: capa de cuota/medición sobre `TenantQuotaCard`/cuotas del tenant. **No prometer add-ons medidos hasta tenerla.** Lanzar primero con tiers fijos + BYOK; add-ons medidos en fase 2. |
| 5 | **Canibalización del Free.** Un micro-academia con ≤50 alumnos y 1 curso tiene evaluación completa gratis para siempre. | Media | El **cap de 1 curso** es el muro real y es suficientemente ajustado: cualquier institución lo supera rápido. El upgrade se fuerza por **crecimiento**, no por mutilar features (evita resentimiento). |
| 6 | **Downgrade de grandfathered.** Un cliente todo-incluido que use poca IA baja a Esencial y baja el ARPU. | Media | El downgrade muestra explícitamente qué pierde (IA, proctoring, certificados, informes). El grandfathering de precio se pierde al bajar (sin retorno) — desincentiva el churn oportunista. |
| 7 | **"Missing middle" $299 → $999.** Una universidad media CS-heavy necesita code-runner/proctoring pero no todo Institucional. | Media | **Add-ons de code-runner y proctoring sobre Profesional** (§3). Captura willingness-to-pay sin salto forzado de tier ni objeción de precio. |
| 8 | **Mutilar el producto / percepción de crippleware.** | Baja | El núcleo mínimo (§5) mantiene el loop pedagógico intacto en TODO plan. Lo removido es value-added real (IA, integridad, credenciales, analítica), no core. La calificación funciona (manual) — coherente con cómo era el producto pre-IA. |
| 9 | **Complejidad de soporte** (4 planes × 3 franjas × add-ons × BYOK × managed). | Media | Página de ventas con **bundles de beneficio**, no slugs. Matriz interna (§4.1) para soporte. BYOK y metering se presentan solo en planes altos para no recargar el mensaje de entrada. |
| 10 | **`module_visibility` no es paywall duro.** La RLS gatea por rol+tenant, no por plan; rutas alcanzables por URL. | Media | Aceptable para features de UI (muro suave). Para lo que **factura** (IA/proctoring/code-runner) el enforcement es server-side por flag (riesgos 2-3). No confiar en el ocultamiento de nav como frontera de facturación. |

---

## Apéndice — Trazabilidad de decisiones

- **Base estructural:** propuesta `valor` (40/50) — escalera land-and-expand, drivers de costo alineados, caveats técnicos honestos.
- **Criterio de corte por plan:** propuesta `persona` (39/50) — job-to-be-done por segmento.
- **Naming + narrativa de upsell:** propuesta `mercado` (38/50).
- **Aislamiento de los 3 drivers de costo + BYOK + add-ons medidos:** propuesta `costo` (36/50).
- **Corrección aplicada:** `whiteboards`+`polls` movidos de Profesional a Esencial (crítica de justicia, bajo costo, pedagogía activa básica).
- **Hallazgo unánime de las 4 evaluaciones:** la IA embebida es el ancla de upsell Free→pago (deseo-máximo = costo-máximo en el mismo umbral), y BYOK convierte la palanca de costo en palanca de margen.

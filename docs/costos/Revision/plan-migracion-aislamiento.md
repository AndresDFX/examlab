# Plan de migración para aislamiento multi-tenant (Lovable → AWS / Supabase dedicado)

> **Versión**: v1 · Contexto: modelo económico v3 · Moneda: USD/mes · Locale: es-CO
> **Regla de oro del documento**: no migrar por elegancia técnica, migrar cuando un cliente lo **paga** o la **ley lo exige**. Todo lo demás es sobre-ingeniería.

---

## 1. Estado actual y por qué migrar

### 1.1. Arquitectura hoy (Fase 0)

```
Cliente (browser)
   └── Lovable (hosting del SPA estático, $25/mes)
          └── Supabase Pro ÚNICO ($25/mes)
                 ├── PostgreSQL — multi-tenant por RLS (columna tenant_id)
                 ├── Storage — buckets COMPARTIDOS (generated-contents, project-files, ...)
                 ├── 24 Edge Functions (Deno)
                 ├── pg_cron (17 jobs)
                 ├── Realtime (Reto en vivo, chat)
                 └── Auth (bulk import, SSO)
          └── AWS Lambda (code runner Java/Python, free tier → $0)
          └── Google Gemini (BYO cliente → $0 para ExamLab)

COSTO FIJO COMPARTIDO ACTUAL ≈ $51/mes (todos los tenants juntos)
```

**Aislamiento HOY = LÓGICO, no físico.** Todos los tenants viven en la misma base de datos, los mismos buckets y las mismas Edge Functions. La separación la garantiza la RLS (`tenant_id = current_tenant_id()` + helpers `course_in_my_tenant`, etc.). Es barato y escala muy bien (costo marginal $0.007–0.02/matrícula/mes), pero un solo dato compartido: **misma DB física, mismo blast radius**.

### 1.2. Qué gatilla la necesidad de aislamiento físico

| Gatillo | Naturaleza | Qué exige realmente | Frecuencia esperada |
|---|---|---|---|
| **Habeas Data (Ley 1581/2012, Colombia)** | Legal | Que los datos personales estén segregados y con trazabilidad; en la práctica muchos contratos institucionales piden "base de datos dedicada" o "data residency". La RLS **sí** cumple el principio de finalidad/seguridad, pero el comprador jurídico suele exigir separación física por percepción de riesgo. | Media — universidades públicas y reguladas |
| **SOC2 / ISO 27001** | Compliance | Auditoría formal de controles. Requiere plan **Supabase Team ($599)** o infra propia auditable. No es aislamiento per se, es certificación de proceso. | Baja hoy, sube con clientes grandes |
| **Cliente Enterprise con equipo de seguridad** | Contractual | Cláusula de "tenant dedicado", VPC propia, o data residency por región. | Baja pero de alto ticket |
| **Licencia self-host / on-premise** | Regulatorio duro | El cliente NO acepta que su dato salga de su infra (banca, defensa, algunas públicas). Requiere entregar el software para que corra en SU nube. | Muy baja, excepción Enterprise |
| **Blast radius / reputación** | Riesgo operativo | Un bug de RLS mal escrita = leak cross-tenant (ya ocurrió y se corrigió en migs 20260929/20260945/20261045-48). Un cliente ancla puede exigir no compartir DB "por si acaso". | Interno — mitigado con auditoría RLS continua |

**Conclusión de la sección**: el gatillo no es técnico, es **comercial/jurídico**. Mientras ningún cliente firme exigiendo separación física ni SOC2, la arquitectura compartida es la correcta. El plan de abajo existe para **estar listos cuando el primer cliente lo pida y lo pague** — no para adelantarse.

---

## 2. Opciones de arquitectura destino

### 2.1. Tabla comparativa

| Dim. | (A) Compartida RLS (hoy) | (B) Supabase dedicado por tenant | (C) AWS full-stack |
|---|---|---|---|
| **Aislamiento** | Lógico (RLS) | **Físico** (DB/Storage/backups separados) | **Físico total** (infra separada, VPC posible) |
| **Data residency** | No seleccionable | Por región Supabase (incl. sa-east) | Cualquier región AWS (incl. Colombia vía local zones) |
| **Costo infra / cliente** | ~$0.007–0.02/matr/mes (marginal) | +$25/mes (Pro extra) + ~$50/mes ops = **~$75** | ~$60–150/mes (RDS t4g + S3 + Lambda + CloudFront + Cognito) |
| **Esfuerzo inicial** | $0 (ya existe) | 8–16h tech senior / primer cliente, luego incremental | **8–14 semanas dev** (reescritura de piezas Supabase-specific) |
| **Ops recurrente** | Mínimo (1 proyecto) | Medio (N proyectos → CI/CD sincronizado, N sets de migraciones) | Alto (IaC, parches, backups, Auth propio, observabilidad) |
| **Reutiliza código actual** | 100% | ~100% (mismo Supabase, distinto proyecto) | ~60% (SPA sí; edge fns + pg_cron + Realtime + Storage RLS = reescribir) |
| **SOC2 / compliance** | No (salvo Team $599) | Parcial (Team por tenant si aplica) | Sí (control total de la infra) |
| **Cuándo usarla** | Todos los clientes chicos/medianos, default | Cliente Grande/Enterprise que exige separación física pero acepta que YO opere | Enterprise que exige VPC/on-prem, o licencia self-host donde el cliente opera |

### 2.2. Hosting del SPA fuera de Lovable

El SPA es un build estático estándar (React + TanStack Router + Vite). **No depende de Lovable en runtime** — Lovable es solo editor + hosting. Salir de ahí es de **esfuerzo bajo (≈1 semana)**:

| Destino | Costo | Notas |
|---|---|---|
| **Vercel** | Free → ~$20/mes | Mejor DX, egress más barato que Lovable a volumen. Break-even vs Lovable cuando la factura Lovable > ~$100/mes. |
| **Netlify** | Free → ~$19/mes | Equivalente a Vercel. |
| **CloudFront + S3** | ~$1–10/mes | El más barato a volumen y el que se necesita **de todas formas** para la ruta AWS full-stack (C). Requiere pipeline de build propio. |

> **Regla**: Lovable puede quedar como **editor** aunque el hosting productivo migre. No hay que romper el flujo de desarrollo para sacar el hosting.

### 2.3. Piezas Supabase-specific = costo real de ir a AWS (C)

Estas piezas NO existen en AWS "as-is". Migrar a AWS full-stack implica reescribirlas:

| Pieza actual | Equivalente AWS | Esfuerzo estimado |
|---|---|---|
| **24 Edge Functions (Deno)** | AWS Lambda (Node/Deno) + API Gateway; reescribir auth, CORS, secrets (→ Secrets Manager / SSM) | **3–5 semanas** (la mayoría son portables, pero cada una asume `service_role` + RLS bypass) |
| **17 pg_cron jobs** | EventBridge Scheduler → Lambda, o `pg_cron` sobre RDS si se instala la extensión | **1–2 semanas** |
| **Realtime (Reto en vivo, chat)** | AWS AppSync (subscriptions GraphQL) o API Gateway WebSockets + DynamoDB | **2–3 semanas** (reescritura de cliente + servidor) |
| **Storage + RLS de Storage** | S3 + políticas IAM/bucket + firma de URLs; la RLS por path (`split_part(name,'/',1)`) se reimplementa en la capa de firma | **1–2 semanas** |
| **Auth (GoTrue) + bulk import + SSO/SAML** | Cognito (o GoTrue self-host sobre RDS). Cognito cambia el modelo de JWT/claims → tocar `has_role`, `current_tenant_id`, RBAC | **2–3 semanas** |
| **PostgreSQL + RLS** | RDS/Aurora Postgres — la RLS es Postgres puro, **se conserva** | Bajo (dump/restore) |
| **SPA** | CloudFront + S3 — build estático | Bajo (~1 semana, ver 2.2) |

**Esfuerzo total AWS full-stack: ~8–14 semanas de dev** para una instancia productiva equivalente. Es una reescritura de la capa de plataforma, no de la app. **Solo se justifica por un contrato Enterprise/self-host que lo pague.**

---

## 3. Plan por fases

### Fase 0 — Consolidar el compartido (hoy → 1–2 semanas)

**Objetivo**: dejar la arquitectura compartida sólida antes de derivar cualquier tenant. No es migración, es endurecimiento.

- Mantener el barrido de RLS al día (auditoría cross-tenant con `SET LOCAL ROLE authenticated` + jwt claims, como en migs 20261045-48). **Cada tabla hija nueva se scopea desde su migración inicial** — nunca `USING (true)` ni `has_role()` sin tenant.
- Activar las **alertas de infra** de `riesgos-y-supuestos.md §3.3`: Storage >80GB, Egress >200GB, Edge >1.5M, Realtime >400.
- Cláusula contractual: videos por URL externa (no al Storage).

**Esfuerzo**: 1–2 semanas (en gran parte ya hecho). **Riesgo**: bajo. **Gatillo para avanzar**: ninguno — esto es el piso permanente.

### Fase 1 — Sacar el hosting de Lovable (1 semana, reactiva)

**Objetivo**: eliminar la dependencia de Lovable en runtime y reducir riesgo de precio (R2).

- Configurar pipeline de build (Vite) → deploy a **CloudFront + S3** (preferido, porque se reusa en Fase 3) o Vercel/Netlify si se quiere rapidez.
- Mantener Lovable como editor opcional. Migrar el flujo de "Publish" a `git push → CI → deploy`.
- DNS + SSL propios (ya se maneja dominio a ~$1/mes).

**Esfuerzo**: ~1 semana. **Riesgo**: bajo (el SPA es estático). **Gatillo**: factura Lovable > ~$100/mes, o simplemente querer control del pipeline. **Beneficio inmediato**: independencia de proveedor + egress potencialmente más barato.

### Fase 2 — Supabase dedicado como add-on (setup 8–16h/cliente, reactiva)

**Objetivo**: poder ofrecer **aislamiento físico** sin reescribir nada — es el mismo stack Supabase en un proyecto separado.

- Automatizar el **provisioning de un proyecto Supabase nuevo**: aplicar las N migraciones (`supabase/migrations/*.sql`), seed data (roles, plantillas de certificado), configurar los 17 pg_cron, desplegar las 24 edge functions, secrets.
- CI/CD que despliegue **en paralelo** al proyecto compartido (mismo commit → todos los proyectos dedicados + el compartido).
- Runbook de **migración de datos** para un tenant que ya existía en el compartido → export filtrado por `tenant_id` → import al proyecto dedicado.
- Vincular el add-on **"Aislamiento dedicado $99/mes"** (costo real $25 Pro + ~$50 ops = margen ~24%). Solo Grande/Enterprise.
- Opción de **región** (data residency) al crear el proyecto.

**Esfuerzo**: ~2 semanas para automatizar el provisioning + CI/CD; luego **8–16h por cliente** la primera vez. **Riesgo**: medio — la carga operativa crece con N proyectos (N sets de migraciones que pueden divergir → el CI sincronizado es crítico). **Gatillo**: primer cliente que firme exigiendo separación física y pague el add-on. **No construir el automatismo antes del primer cliente** — hacerlo manual la primera vez, automatizar cuando haya ≥2.

### Fase 3 — AWS full-stack (8–14 semanas, solo por contrato Enterprise/self-host)

**Objetivo**: aislamiento total (VPC/región/on-prem) y/o entrega self-host.

- Reescribir las piezas Supabase-specific (ver §2.3): edge fns → Lambda+API Gateway, pg_cron → EventBridge, Realtime → AppSync/WS, Storage RLS → S3+firma, Auth → Cognito o GoTrue self-host.
- PostgreSQL → RDS/Aurora (la RLS se conserva).
- Empaquetar como **IaC (Terraform/CDK)** para que sea desplegable en la cuenta AWS del cliente (self-host) o en una cuenta gestionada por mí.
- Definir el modo de entrega: **gestionado por mí** (licencia con admin) vs **operado por el cliente** (licencia self-host, mi costo infra ≈ $0).

**Esfuerzo**: 8–14 semanas la primera vez. **Riesgo**: alto — es la mayor inversión y crea una **segunda base de código de plataforma** que hay que mantener en paralelo a la Supabase. **Gatillo**: contrato Enterprise (>25.000 matrículas o ticket ≥$1.499–$2.499/mes) o licencia self-host con precio que amortice las semanas de dev (referencia riesgos: on-premise ~$50k/año). **No empezar sin contrato firmado.**

---

## 4. Recomendación por modelo de negocio

### Modelo 1 — Licencias SIN administración mía (cliente hospeda su infra)

- **Arquitectura**: **(C) AWS full-stack self-host**, empaquetado como IaC. El cliente corre su propio RDS/Aurora + S3 + Lambda + CloudFront + Cognito/GoTrue.
- **Mi costo de infra**: ≈ **$0** (yo solo entrego código + updates).
- **Infra que el CLIENTE pagaría** (para justificar el precio de licencia), tenant típico Grande ~10.000 matrículas: RDS t4g.medium ~$50–90/mes + S3/CloudFront ~$10–30/mes + Lambda ~$5 + Cognito (50k MAU free, luego ~$0.0055/MAU) ≈ **$70–150/mes de infra propia**. Eso es lo que el cliente **no** paga si va a mi SaaS — argumento de venta de la licencia.
- **Qué entrego yo**: build + IaC + migraciones + runbook de deploy + updates versionados. **No entrego soporte operativo.**
- **Precio de licencia**: debe cubrir el valor del software (no la infra, que la paga el cliente). Referencia: on-premise ~$50k/año para Enterprise real; para no-Enterprise, licencia anual que amortice las 8–14 semanas de dev de la Fase 3 sobre varios clientes.
- **Condición**: solo ofrecer cuando exista demanda real y contrato. Es la única vía que requiere Fase 3 sí o sí.

### Modelo 2 — Licencias CON administración mía (instancia dedicada aislada, yo opero)

- **Arquitectura**: **(B) Supabase dedicado por tenant** (default). Solo escalar a **(C) AWS gestionado por mí** si el cliente exige VPC/on-prem que Supabase no da.
- **Mi costo por cliente**: $25 Pro + ~$50 ops = **~$75/mes infra** (Modalidad Administrada suma el costo humano ~$225/cliente con ratio 1 tech : 8 clientes).
- **Precio**: plan base (Grande $799 / Enterprise desde $1.499) + add-on **Aislamiento dedicado $99/mes** + **Administrada +$300/mes**.
- **Por qué B y no C**: (B) reusa 100% del código, ops manejable, se activa en 8–16h. (C) solo cuando la separación física de Supabase no basta.
- **Requiere**: Fase 2 lista (provisioning + CI/CD sincronizado).

### Modelo 3 — Independientes con mi administración (SaaS compartido, modelo actual)

- **Arquitectura**: **(A) Compartida RLS** — sin cambios.
- **Mi costo marginal**: $0.007–0.02/matrícula/mes. Óptimo a 10.000–25.000 matrículas totales ($0.007–0.009/matr).
- **Precio**: planes v3 tal cual (Pequeña $149 / Mediana $349 / Grande $799).
- **Techo**: hasta ~25.000 matrículas totales sobre Supabase Pro. A ~50k, saltar a Team ($599) solo si un cliente exige compliance.
- **Requiere**: solo Fase 0 (endurecimiento RLS continuo) + Fase 1 cuando convenga.

**Resumen de asignación**:

| Modelo de negocio | Arquitectura recomendada | Fase que la habilita | Mi costo infra/cliente |
|---|---|---|---|
| 1. Licencia sin admin (self-host) | (C) AWS full-stack IaC | Fase 3 | ~$0 |
| 2. Licencia con admin (dedicada) | (B) Supabase dedicado → (C) si exige VPC | Fase 2 (→3) | ~$75/mes (+ humano $225 si Administrada) |
| 3. Independientes compartido | (A) RLS compartido | Fase 0/1 | $0.007–0.02/matr/mes |

---

## 5. Qué NO migrar todavía (y por qué)

1. **No migrar a AWS full-stack (Fase 3) sin contrato firmado.** Son 8–14 semanas de dev y una segunda base de código de plataforma que mantener en paralelo. Sin un Enterprise/self-host que lo pague, es destruir margen para resolver un problema que nadie tiene todavía. Decisión v3 §6: multi-tenant compartido hasta 25.000 matrículas totales.

2. **No automatizar el provisioning de Supabase dedicado antes del primer cliente que lo pague.** El primer aislamiento dedicado se hace **manual** (8–16h). Automatizar CI/CD sincronizado para N proyectos solo se justifica con ≥2 clientes dedicados. Antes es sobre-ingeniería.

3. **No pasar a Supabase Team ($599) preventivamente.** +$548/mes de costo fijo. Solo cuando **una** universidad exija SOC2/ISO por contrato y ese contrato lo cubra. Antes, no.

4. **No reescribir edge functions / pg_cron / Realtime "por portabilidad".** Son Supabase-specific y funcionan. Reescribirlas solo tiene sentido dentro de la Fase 3 (contrato AWS). Hacerlo antes es trabajo muerto.

5. **No mover el code runner (AWS Lambda) ni tocar el modelo IA=BYO.** Lambda está en free tier con margen enorme (11 ejecuciones en 2 meses; techo real a >5M ejec/mes). Gemini BYO = $0 para ExamLab. Ambos ya están donde deben estar.

6. **No sacar Lovable como editor.** La Fase 1 saca el **hosting productivo**, no el flujo de desarrollo. Romper el editor por purismo de infra no aporta valor.

> **Principio rector**: cada fase de aislamiento se dispara por un **contrato que la paga** o una **exigencia legal concreta**, nunca por anticipación técnica. La arquitectura compartida (A) es la base económica del negocio (margen 87–91%); las fases 2 y 3 son productos premium reactivos, no el camino por defecto.
# Plan de migración para aislamiento multi-tenant (Lovable → Supabase dedicado / AWS, siempre en MI infra)

> **Versión**: v1.1 · Contexto: modelo económico v3 · Moneda: USD/mes · Locale: es-CO
> **Regla de oro del documento**: no migrar por elegancia técnica, migrar cuando un cliente lo **paga** o la **ley lo exige**. Todo lo demás es sobre-ingeniería.
> **Premisa no negociable del negocio**: la infraestructura **la proporciono SIEMPRE yo (ExamLab)**. No existe modalidad self-host — el cliente NUNCA hospeda su propio Supabase/AWS ni corre la app en su nube. Este plan describe cómo, dentro de **MI** infra, paso de aislamiento lógico (RLS compartido) a aislamiento físico (Supabase dedicado que YO opero, y a futuro AWS full-stack operado por MÍ). La "migración" es para poder **OFRECER YO** aislamiento, no para descargar la operación al cliente.

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

COSTO FIJO COMPARTIDO ACTUAL ≈ $51/mes (todos los tenants juntos, TODO en mi infra)
```

**Aislamiento HOY = LÓGICO, no físico, y siempre en MI infra.** Todos los tenants viven en la misma base de datos, los mismos buckets y las mismas Edge Functions — todo bajo mi cuenta Supabase. La separación la garantiza la RLS (`tenant_id = current_tenant_id()` + helpers `course_in_my_tenant`, etc.). Es barato y escala muy bien (costo marginal $0.007–0.02/matrícula/mes), pero comparte un dato clave: **misma DB física, mismo blast radius**. Nada de esto corre en infra del cliente ni cambiaría de dueño con las fases de abajo.

### 1.2. Qué gatilla la necesidad de aislamiento físico

| Gatillo | Naturaleza | Qué exige realmente | Frecuencia esperada |
|---|---|---|---|
| **Habeas Data (Ley 1581/2012, Colombia)** | Legal | Que los datos personales estén segregados y con trazabilidad; en la práctica muchos contratos institucionales piden "base de datos dedicada" o "data residency". La RLS **sí** cumple el principio de finalidad/seguridad, pero el comprador jurídico suele exigir separación física por percepción de riesgo. Se resuelve **en MI infra** con un Supabase dedicado por tenant. | Media — universidades públicas y reguladas |
| **SOC2 / ISO 27001** | Compliance | Auditoría formal de controles. Requiere plan **Supabase Team ($599)** o infra propia auditable — en ambos casos **operada por mí**. No es aislamiento per se, es certificación de proceso. | Baja hoy, sube con clientes grandes |
| **Cliente Enterprise con equipo de seguridad** | Contractual | Cláusula de "tenant dedicado", VPC propia, o data residency por región. Se satisface con Supabase dedicado o, si exige VPC total, AWS full-stack — **siempre en mi cuenta**. | Baja pero de alto ticket |
| **Cliente que rechaza infra compartida (banca, defensa, pública sensible)** | Regulatorio duro | El comprador no acepta que su dato comparta base con otros tenants. Requiere infra **dedicada y aislada**, pero **la sigo operando YO** (Supabase dedicado o AWS full-stack en mi cuenta). NO implica entregarle el software para que lo corra él. | Muy baja, excepción Enterprise |
| **Blast radius / reputación** | Riesgo operativo | Un bug de RLS mal escrita = leak cross-tenant (ya ocurrió y se corrigió en migs 20260929/20260945/20261045-48). Un cliente ancla puede exigir no compartir DB "por si acaso". | Interno — mitigado con auditoría RLS continua |

**Conclusión de la sección**: el gatillo no es técnico, es **comercial/jurídico**. Mientras ningún cliente firme exigiendo separación física ni SOC2, la arquitectura compartida es la correcta. El plan de abajo existe para **estar listo para OFRECER YO aislamiento cuando el primer cliente lo pida y lo pague** — no para adelantarse, y en ningún escenario para que el cliente hospede su propia infra.

---

## 2. Opciones de arquitectura destino (todas en MI infra)

### 2.1. Tabla comparativa

| Dim. | (A) Compartida RLS (hoy) | (B) Supabase dedicado por tenant | (C) AWS full-stack |
|---|---|---|---|
| **Quién opera la infra** | **Yo (ExamLab)** | **Yo (ExamLab)** | **Yo (ExamLab)** |
| **Aislamiento** | Lógico (RLS) | **Físico** (DB/Storage/backups separados) | **Físico total** (infra separada, VPC posible) |
| **Data residency** | No seleccionable | Por región Supabase (incl. sa-east) | Cualquier región AWS (incl. Colombia vía local zones) |
| **Costo infra / cliente (que pago YO)** | ~$0.007–0.02/matr/mes (marginal sobre el ~$51 fijo) | +$25/mes (Pro extra) + ~$50/mes ops = **~$75** | ~$60–150/mes (RDS t4g + S3 + Lambda + CloudFront + Cognito) |
| **Esfuerzo inicial** | $0 (ya existe) | 8–16h tech senior / primer cliente, luego incremental | **8–14 semanas dev** (reescritura de piezas Supabase-specific) |
| **Ops recurrente** | Mínimo (1 proyecto) | Medio (N proyectos → CI/CD sincronizado, N sets de migraciones) | Alto (IaC, parches, backups, Auth propio, observabilidad) |
| **Reutiliza código actual** | 100% | ~100% (mismo Supabase, distinto proyecto) | ~60% (SPA sí; edge fns + pg_cron + Realtime + Storage RLS = reescribir) |
| **SOC2 / compliance** | No (salvo Team $599) | Parcial (Team por tenant si aplica) | Sí (control total de la infra, en mi cuenta) |
| **Cuándo usarla** | Todos los clientes chicos/medianos, default | Cliente Grande/Enterprise que exige separación física (yo lo opero) | Enterprise que exige VPC/aislamiento total que Supabase dedicado no da (yo lo opero) |

> Las tres columnas son infra **mía**. Lo único que cambia entre ellas es el **grado de aislamiento** (lógico → físico → físico total) y el costo que **yo** absorbo — nunca quién administra ni quién hospeda.

### 2.2. Hosting del SPA fuera de Lovable

El SPA es un build estático estándar (React + TanStack Router + Vite). **No depende de Lovable en runtime** — Lovable es solo editor + hosting. Salir de ahí es de **esfuerzo bajo (≈1 semana)** y el destino sigue siendo infra **mía**:

| Destino | Costo (lo pago yo) | Notas |
|---|---|---|
| **Vercel** | Free → ~$20/mes | Mejor DX, egress más barato que Lovable a volumen. Break-even vs Lovable cuando la factura Lovable > ~$100/mes. |
| **Netlify** | Free → ~$19/mes | Equivalente a Vercel. |
| **CloudFront + S3** | ~$1–10/mes | El más barato a volumen y el que se necesita **de todas formas** para la ruta AWS full-stack (C). Requiere pipeline de build propio. |

> **Regla**: Lovable puede quedar como **editor** aunque el hosting productivo migre. No hay que romper el flujo de desarrollo para sacar el hosting.

### 2.3. Piezas Supabase-specific = costo real de ir a AWS (C)

Estas piezas NO existen en AWS "as-is". Migrar a AWS full-stack (siempre en mi cuenta) implica reescribirlas:

| Pieza actual | Equivalente AWS | Esfuerzo estimado |
|---|---|---|
| **24 Edge Functions (Deno)** | AWS Lambda (Node/Deno) + API Gateway; reescribir auth, CORS, secrets (→ Secrets Manager / SSM) | **3–5 semanas** (la mayoría son portables, pero cada una asume `service_role` + RLS bypass) |
| **17 pg_cron jobs** | EventBridge Scheduler → Lambda, o `pg_cron` sobre RDS si se instala la extensión | **1–2 semanas** |
| **Realtime (Reto en vivo, chat)** | AWS AppSync (subscriptions GraphQL) o API Gateway WebSockets + DynamoDB | **2–3 semanas** (reescritura de cliente + servidor) |
| **Storage + RLS de Storage** | S3 + políticas IAM/bucket + firma de URLs; la RLS por path (`split_part(name,'/',1)`) se reimplementa en la capa de firma | **1–2 semanas** |
| **Auth (GoTrue) + bulk import + SSO/SAML** | Cognito (o GoTrue self-host sobre RDS). Cognito cambia el modelo de JWT/claims → tocar `has_role`, `current_tenant_id`, RBAC | **2–3 semanas** |
| **PostgreSQL + RLS** | RDS/Aurora Postgres — la RLS es Postgres puro, **se conserva** | Bajo (dump/restore) |
| **SPA** | CloudFront + S3 — build estático | Bajo (~1 semana, ver 2.2) |

**Esfuerzo total AWS full-stack: ~8–14 semanas de dev** para una instancia productiva equivalente, desplegada y operada por mí. Es una reescritura de la capa de plataforma, no de la app. **Solo se justifica por un contrato Enterprise que exija VPC/aislamiento total y lo pague** — no para entregarle infra al cliente (eso no existe en el modelo).

---

## 3. Plan por fases

> En todas las fases la infra la opero **yo**. Lo que avanza fase a fase es únicamente el **grado de aislamiento** que puedo ofrecer, no un traspaso de operación al cliente.

### Fase 0 — Consolidar el compartido (hoy → 1–2 semanas)

**Objetivo**: dejar la arquitectura compartida sólida antes de derivar cualquier tenant. No es migración, es endurecimiento.

- Mantener el barrido de RLS al día (auditoría cross-tenant con `SET LOCAL ROLE authenticated` + jwt claims, como en migs 20261045-48). **Cada tabla hija nueva se scopea desde su migración inicial** — nunca `USING (true)` ni `has_role()` sin tenant.
- Activar las **alertas de infra** de `riesgos-y-supuestos.md §3.3`: Storage >80GB, Egress >200GB, Edge >1.5M, Realtime >400.
- Cláusula contractual: videos por URL externa (no al Storage).

**Esfuerzo**: 1–2 semanas (en gran parte ya hecho). **Riesgo**: bajo. **Gatillo para avanzar**: ninguno — esto es el piso permanente.

### Fase 1 — Sacar el hosting de Lovable (1 semana, reactiva)

**Objetivo**: eliminar la dependencia de Lovable en runtime y reducir riesgo de precio (R2). El hosting sigue siendo mío, solo cambia de proveedor.

- Configurar pipeline de build (Vite) → deploy a **CloudFront + S3** (preferido, porque se reusa en Fase 3) o Vercel/Netlify si se quiere rapidez.
- Mantener Lovable como editor opcional. Migrar el flujo de "Publish" a `git push → CI → deploy`.
- DNS + SSL propios (ya se maneja dominio a ~$1/mes).

**Esfuerzo**: ~1 semana. **Riesgo**: bajo (el SPA es estático). **Gatillo**: factura Lovable > ~$100/mes, o simplemente querer control del pipeline. **Beneficio inmediato**: independencia de proveedor + egress potencialmente más barato.

### Fase 2 — Supabase dedicado como add-on (setup 8–16h/cliente, reactiva)

**Objetivo**: poder **OFRECER YO** aislamiento físico sin reescribir nada — es el mismo stack Supabase en un proyecto separado, dentro de mi cuenta.

- Automatizar el **provisioning de un proyecto Supabase nuevo** (bajo mi organización Supabase): aplicar las N migraciones (`supabase/migrations/*.sql`), seed data (roles, plantillas de certificado), configurar los 17 pg_cron, desplegar las 24 edge functions, secrets.
- CI/CD que despliegue **en paralelo** al proyecto compartido (mismo commit → todos los proyectos dedicados + el compartido). Todos administrados por mí.
- Runbook de **migración de datos** para un tenant que ya existía en el compartido → export filtrado por `tenant_id` → import al proyecto dedicado (yo ejecuto la migración, el cliente no toca nada).
- Vincular el add-on **"Aislamiento dedicado $99/mes"** (costo real que pago yo: $25 Pro + ~$50 ops = margen ~24%). Solo Grande/Enterprise.
- Opción de **región** (data residency) al crear el proyecto.

**Esfuerzo**: ~2 semanas para automatizar el provisioning + CI/CD; luego **8–16h por cliente** la primera vez. **Riesgo**: medio — la carga operativa (mía) crece con N proyectos (N sets de migraciones que pueden divergir → el CI sincronizado es crítico). **Gatillo**: primer cliente que firme exigiendo separación física y pague el add-on. **No construir el automatismo antes del primer cliente** — hacerlo manual la primera vez, automatizar cuando haya ≥2.

### Fase 3 — AWS full-stack (8–14 semanas, solo por contrato Enterprise que exija VPC/aislamiento total)

**Objetivo**: aislamiento total (VPC/región dedicada) **operado por mí** para un Enterprise cuyo requerimiento de seguridad no lo cubre ni siquiera un Supabase dedicado. **No** es entrega self-host — la infra sigue en mi cuenta.

- Reescribir las piezas Supabase-specific (ver §2.3): edge fns → Lambda+API Gateway, pg_cron → EventBridge, Realtime → AppSync/WS, Storage RLS → S3+firma, Auth → Cognito o GoTrue self-host.
- PostgreSQL → RDS/Aurora (la RLS se conserva).
- Empaquetar como **IaC (Terraform/CDK)** como herramienta **mía** de despliegue reproducible — para levantar la instancia dedicada del cliente en una cuenta/VPC que **yo** gestiono (no para entregársela al cliente).
- Definir el modo de aislamiento por contrato: **VPC dedicada en mi cuenta** vs **cuenta AWS dedicada al cliente pero gestionada por mí** (data residency estricta). En ambos casos mi costo de infra es real (RDS + S3 + Lambda + CloudFront + Cognito) y la operación es mía.

**Esfuerzo**: 8–14 semanas la primera vez. **Riesgo**: alto — es la mayor inversión y crea una **segunda base de código de plataforma** que hay que mantener en paralelo a la Supabase. **Gatillo**: contrato Enterprise (>25.000 matrículas o ticket ≥$1.499–$2.499/mes) con exigencia de VPC/aislamiento total y precio que amortice las semanas de dev. **No empezar sin contrato firmado.**

---

## 4. Recomendación por modelo de negocio

> **Los 3 modelos comparten la misma infra: la MÍA.** No se diferencian por quién hospeda (siempre yo), sino por **quién ADMINISTRA el tenant** (self-service del cliente vs. yo lo opero). El **aislamiento** (RLS compartido vs. Supabase dedicado que YO opero) es una variable **ortogonal**: cualquiera de los 3 modelos puede activar el add-on de aislamiento dedicado. Y **todos los planes incluyen mi soporte básico como SuperAdmin** (alta del tenant, licencias, incidencias, updates); la diferencia "sin/con administración" es la **operación diaria** del tenant, no el soporte básico ni la infra.

### Modelo 1 — SIN administración mía (plan AUTO)

- **Quién administra**: el **cliente**, en modo self-service (crea cursos, gestiona usuarios, configura branding).
- **Quién pone la infra**: **yo** — el tenant vive en MI Supabase (compartido por RLS por defecto; dedicado si contrata aislamiento).
- **Arquitectura**: **(A) Compartida RLS** por defecto. Si el cliente paga el add-on, **(B) Supabase dedicado operado por mí**.
- **Soporte incluido**: básico como SuperAdmin (alta, licencias, incidencias, updates). **Sin operación diaria mía.**
- **Mi costo por cliente**: infra marginal sobre el ~$51 fijo compartido (**$0.007–0.02/matrícula/mes**, o **~$75/mes** si activa Supabase dedicado) + un costo mínimo de soporte básico (bajo, no dedicado). **Nunca $0** — la infra siempre la pago yo.
- **Precio**: planes v3 tal cual (Pequeña $149 / Mediana $349 / Grande $799 / Enterprise desde $1.499) + add-on **Aislamiento dedicado $99/mes** si aplica.
- **Requiere**: solo Fase 0 (endurecimiento RLS continuo) + Fase 1 cuando convenga; Fase 2 solo si el cliente contrata aislamiento dedicado.

### Modelo 2 — CON administración mía (modalidad ADMINISTRADA +$300/mes)

- **Quién administra**: **yo** — creo cursos, importo usuarios/cursos, configuro branding/emails, capacito y doy soporte pleno con SLA.
- **Quién pone la infra**: **yo** (igual que Modelo 1).
- **Arquitectura**: **(A) Compartida RLS** por defecto; **(B) Supabase dedicado operado por mí** si el cliente exige separación física; **(C) AWS full-stack operado por mí** solo si exige VPC/aislamiento total que Supabase dedicado no da.
- **Mi costo por cliente**: infra ($15–$80/mes marginal, o ~$75/mes si dedicado) **+ costo humano operativo ~$225/cliente** (ratio 1 tech : 8 clientes; tech junior/mid remote $1.800/mes cargado).
- **Precio**: plan base + **Administrada +$300/mes** (+ add-on **Aislamiento dedicado $99/mes** si aplica).
- **Por qué B/C y no self-host**: no existe self-host — cuando el cliente necesita aislamiento, lo levanto y opero **yo** (B por defecto, C solo si la separación física de Supabase no basta).
- **Requiere**: Fase 0/1 siempre; Fase 2 lista si se ofrece aislamiento dedicado; Fase 3 solo por contrato Enterprise con VPC.

### Modelo 3 — Independientes con mi administración (sub-segmento del Modelo 2)

- **Quién es**: docentes/profesionales independientes o instituciones muy chicas.
- **Quién administra**: **yo** (misma operación que Modelo 2, a menor escala).
- **Quién pone la infra**: **yo**, sobre la **(A) Compartida RLS** — sin aislamiento dedicado (no lo necesitan ni lo pagarían).
- **Mi costo marginal**: $0.007–0.02/matrícula/mes (mínimo dentro del ~$51 fijo compartido). Óptimo a 10.000–25.000 matrículas totales ($0.007–0.009/matr). El costo humano se diluye por la baja escala de cada cuenta.
- **Precio**: franja baja de los planes v3 (típicamente Pequeña $149) con administración incluida según acuerdo; el recargo Administrada aplica igual que en el Modelo 2 si se opera plenamente.
- **Techo**: hasta ~25.000 matrículas totales sobre Supabase Pro. A ~50k, saltar a Team ($599) solo si un cliente exige compliance.
- **Requiere**: solo Fase 0 (endurecimiento RLS continuo) + Fase 1 cuando convenga.

**Resumen de asignación**:

| Modelo de negocio | Quién administra | Infra (siempre MÍA) | Aislamiento por defecto | Fase que lo habilita | Mi costo/cliente |
|---|---|---|---|---|---|
| 1. Sin administración mía (AUTO) | Cliente (self-service) | Mi Supabase | (A) RLS compartido → (B) si contrata add-on | Fase 0/1 (→2 si dedicado) | Infra marginal $0.007–0.02/matr (o ~$75 si dedicado) + soporte básico mínimo |
| 2. Con administración mía (ADMINISTRADA) | **Yo** | Mi Supabase / mi AWS | (A) → (B) si exige físico → (C) si exige VPC | Fase 0/1 (→2, →3 por contrato) | Infra + humano ~$225 |
| 3. Independientes con mi administración | **Yo** | Mi Supabase compartido | (A) RLS compartido | Fase 0/1 | Infra marginal $0.007–0.02/matr (humano diluido por escala) |

> En los tres modelos el aislamiento es una decisión **ortogonal**: se resuelve SIEMPRE en mi infra (RLS compartido por defecto, o Supabase dedicado que yo opero por $99/mes, o AWS full-stack operado por mí para el Enterprise excepcional). Nunca en infra del cliente.

---

## 5. Qué NO migrar todavía (y por qué)

1. **No migrar a AWS full-stack (Fase 3) sin contrato firmado.** Son 8–14 semanas de dev y una segunda base de código de plataforma que mantener en paralelo. Sin un Enterprise que exija VPC/aislamiento total y lo pague, es destruir margen para resolver un problema que nadie tiene todavía. Decisión v3 §6: multi-tenant compartido hasta 25.000 matrículas totales. Y aun en ese caso, la infra la sigo operando yo — no hay entrega self-host.

2. **No automatizar el provisioning de Supabase dedicado antes del primer cliente que lo pague.** El primer aislamiento dedicado se hace **manual** (8–16h) en mi cuenta. Automatizar CI/CD sincronizado para N proyectos solo se justifica con ≥2 clientes dedicados. Antes es sobre-ingeniería.

3. **No pasar a Supabase Team ($599) preventivamente.** +$548/mes de costo fijo (mío). Solo cuando **una** universidad exija SOC2/ISO por contrato y ese contrato lo cubra. Antes, no.

4. **No reescribir edge functions / pg_cron / Realtime "por portabilidad".** Son Supabase-specific y funcionan. Reescribirlas solo tiene sentido dentro de la Fase 3 (contrato AWS con VPC). Hacerlo antes es trabajo muerto.

5. **No mover el code runner (AWS Lambda) ni tocar el modelo IA=BYO.** Lambda está en free tier con margen enorme (11 ejecuciones en 2 meses; techo real a >5M ejec/mes). Gemini BYO = $0 para ExamLab. Ambos ya están donde deben estar.

6. **No sacar Lovable como editor.** La Fase 1 saca el **hosting productivo** (a otro proveedor mío), no el flujo de desarrollo. Romper el editor por purismo de infra no aporta valor.

> **Principio rector**: cada fase de aislamiento se dispara por un **contrato que la paga** o una **exigencia legal concreta**, nunca por anticipación técnica — y siempre se resuelve dentro de MI infra. La arquitectura compartida (A) es la base económica del negocio (margen 87–91%); las fases 2 y 3 son productos premium reactivos (aislamiento que YO opero), no un traspaso de operación al cliente ni el camino por defecto.
```

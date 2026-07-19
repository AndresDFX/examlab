# Revisión de seguridad + funcional + e2e por ROL y MÓDULO

Complementa [PLAN-PRUEBAS-QA.md](PLAN-PRUEBAS-QA.md) (el plan) con **resultados de validación e2e real contra producción** (REST con token de usuario real, respetando RLS). Metodología: por cada rol se prueba 1-a-1 (1) aislamiento de seguridad (cross-tenant + cross-course), (2) acceso funcional legítimo (positivo), (3) flujos de escritura.

Forma rigurosa de cada prueba de aislamiento: **SA ve >0 filas** (la entidad existe) **Y el usuario-de-otro-ámbito ve 0** → PASS. Un usuario que ve >0 = LEAK.

> Las migraciones de endurecimiento RLS (rounds 1-13: `20260929`, `20260945`, `20260994`–`20260997`, `20261002`, `20261003`, `20261010`) están desplegadas. Esta revisión las **confirma empíricamente** rol por rol.

---

## Estado del sweep

| Rol | Seguridad (aislamiento) | Funcional (positivo) | Escritura | Estado |
| --- | --- | --- | --- | --- |
| **Estudiante** | ✅ (sesión previa) | ✅ | ✅ | OK |
| **Docente** | ✅ 17 PASS / 0 leaks | ✅ paridad en su curso | ✅ crea en suyo, denegado ajeno | **OK** |
| **Admin** | ✅ 7 PASS / 0 leaks cross-tenant | ✅ ve TODO su tenant (7/7 paridad) | ✅ crea en suyo, denegado ajeno (42501) | **OK** |
| **SuperAdmin** | ✅ frontera OK (no-SA no escala) | ✅ cross-tenant legítimo (ground truth) | ✅ RPCs/destructivas SA-only | **OK** |

**Sweep e2e por muestreo (roles + módulos): 0 hallazgos.** Auditoría EXHAUSTIVA posterior (pg_policies, TODAS las tablas): **1 leak cross-tenant CONFIRMADO y CORREGIDO** (`project_assignments`), 1 policy mal scopeada corregida (`video_views`), 2 ítems diferidos (ver "Auditoría exhaustiva" abajo).

---

## Docente — 2026-06-28

**Cuenta:** `docente1@demo-examlab.co` (tenant `examlab-demo` / `729b3114`), dicta "Curso de pruebas". Token real vía `signInWithPassword`.

### Seguridad — aislamiento cross-tenant (Docente de examlab-demo NO debe ver datos de FESNA / otros tenants)

17 PASS concluyentes, **0 leaks**. Cada uno: SA ve >0, Docente-de-otro-tenant ve 0.

| Tabla | SA ve | Docente ve | Resultado |
| --- | --- | --- | --- |
| courses | 3 | 0 | PASS |
| exams | 1 | 0 | PASS |
| questions | 40 | 0 | PASS |
| workshops | 6 | 0 | PASS |
| workshop_questions | 1 | 0 | PASS |
| submissions | 115 | 0 | PASS |
| workshop_submissions | 36 | 0 | PASS |
| exam_assignments | 5 | 0 | PASS |
| attendance_sessions | 12 | 0 | PASS |
| grade_cuts | 9 | 0 | PASS |
| whiteboards | 6 | 0 | PASS |
| polls | 8 | 0 | PASS |
| question_bank | 20 | 0 | PASS |
| project_files | 12 | 0 | PASS |
| course_enrollments | 134 | 0 | PASS |
| course_teachers | 3 | 0 | PASS |
| ai_model_settings | 1 | 0 | PASS (key del tenant ajeno NO legible) |

`grade_cut_items` quedó no-concluyente (sin datos en ningún tenant para probar).

### Funcional — acceso positivo a SU propio curso

- Paridad lectura SA vs Docente en su curso (`5282c2ed`): courses 1=1, course_teachers 50=50, resto 0=0 (curso demo sin contenido). **0 falsos-deny**.
- `get_active_processing_mode()` (RPC) devuelve `sync` al Docente sin exponerle la tabla `ai_model_settings` (que ahora es Admin/SA-only).

### Escritura (WITH CHECK)

- **Crea** exam draft en SU curso → 201 OK; **DELETE** propio → 204 (verificado borrado). ✅
- **Crea** exam en curso de FESNA (ajeno) → **`42501` RLS denied**. ✅ No puede escribir fuera de sus cursos.

**Conclusión Docente: sin hallazgos.** El endurecimiento RLS se sostiene; el acceso legítimo no se rompió.

---

## Admin — 2026-06-28

**Cuenta:** `test-demo-global-corp@examlab.test` (tenant `Demo Global Corp` / `f1dcfedc`), rol Admin. Token real obtenido con password temporal vía DB (con backup + restaurada al terminar; cuenta de test).

### Funcional — within-tenant (Admin ve TODO su tenant, no solo lo que dicta)

Paridad EXACTA Admin vs SA en el tenant DGC (7/7), incl. cursos que el Admin no dicta:

| Tabla | SA | Admin | |
| --- | --- | --- | --- |
| courses | 3 | 3 | OK |
| exams | 2 | 2 | OK |
| workshops | 2 | 2 | OK |
| attendance_sessions | 6 | 6 | OK |
| profiles | 9 | 9 | OK |
| course_enrollments | 11 | 11 | OK |
| submissions | 1 | 1 | OK |

### Seguridad — cross-tenant (Admin de DGC NO ve FESNA)

7 PASS / **0 leaks**: courses, exams, workshop_submissions (36), attendance (12), course_enrollments (134), **profiles (130→0)**, ai_model_settings (key del tenant ajeno oculta).

### Escritura

- Crear curso con `tenant_id=FESNA` (ajeno) → **`42501` RLS denied**. No puede plantar datos en otro tenant.
- Crear curso en su propio tenant → 201 OK (sin regresión); cleanup 204.

**Conclusión Admin: sin hallazgos.**

---

## SuperAdmin (frontera) — 2026-06-28

El SA legítimamente opera cross-tenant (`is_super_admin()` bypassa RLS) — confirmado: el token SA ve los 6 tenants (se usó como ground truth en todas las pruebas). La revisión del **límite** verifica que un NO-SA (Admin/Docente) no pueda escalar a capacidades SA:

| Superficie SA-only | Probado como | Resultado |
| --- | --- | --- |
| RPC `list_recent_ai_executions` | Admin | PASS (403 permission denied — round 10) |
| RPC `list_failed_ai_gradings` | Admin | PASS (403) |
| RPC `course_pending_grading_count` | Admin | PASS (404, no expuesta) |
| RPC `count_ai_errors_last_hour` | Admin | PASS (403) |
| RPC `hard_delete_tenant` | Admin | PASS (`P0001` "Solo SuperAdmin…") |
| `audit_logs` cross-tenant (FESNA) | Admin DGC | PASS (0 de 5) |
| `support_tickets` cross-tenant | Admin DGC | PASS (0) |
| `platform_settings` UPDATE | Admin | PASS (denegado; SELECT abierto by-design — solo toggle no-sensible `support_emails_enabled`) |

**Conclusión SuperAdmin: frontera intacta.** Ningún rol inferior accede a superficies SA-only ni escala privilegios.

---

## Módulos adicionales — 2026-06-28

Probados 1-a-1 en la forma rigurosa (SA ve >0, usuario sin derecho ve 0). **5 PASS / 0 leaks:**

| Módulo | Prueba | SA | Probe | Resultado |
| --- | --- | --- | --- | --- |
| **Certificados** | Admin DGC lee certs de cursos de otro tenant | 16 | 0 | PASS (certs de alumnos no se filtran cross-tenant) |
| **Videos** | Admin DGC lee videos `tenant_id != DGC` | 2 | 0 | PASS |
| **Ejecución de código** | Docente1 lee `code_executions` de OTROS usuarios | 13 | 0 | PASS (no ve el código de otros) |
| **Mensajería — conversación** | Docente1 lee una conversación en la que NO participa | 1 | 0 | PASS |
| **Mensajería — mensajes** | Docente1 lee mensajes de esa conversación ajena | 1 | 0 | PASS (privacidad 1-a-1 intacta) |

## Cobertura y limitaciones

- Probado e2e vía REST con tokens reales (respeta RLS) contra **producción**.
- Tablas cubiertas (alta sensibilidad): courses, exams/questions, workshops/workshop_questions, projects/project_files, submissions/workshop_submissions, exam_assignments, attendance_sessions, grade_cuts, whiteboards, polls, question_bank, course_enrollments, course_teachers, profiles, ai_model_settings, audit_logs, support_tickets, platform_settings, **certificates, videos, code_executions, conversations, messages**.
- Cross-course **dentro del mismo tenant** para Docente no se pudo probar en vivo (el tenant demo del docente tiene 1 solo curso); cubierto por diseño (RLS por `course_teachers`) y por la denegación de escritura cross-tenant.
- `forums` / `forum_threads` sin datos en ningún tenant → no concluyente vía e2e (cubierto por rounds previos). Pendiente para cuando haya datos.

---

## Auditoría exhaustiva de RLS (pg_policies) — 2026-06-28

Complemento al sweep por muestreo: introspección de `pg_catalog` sobre **las 121 tablas** de `public`.

- **Tablas sin RLS: 0** — todas tienen RLS habilitado.
- **Tablas con RLS y sin policies (deny-all): 5** — `calendar_oauth_states`, `email_change_tokens`, `password_reset_tokens`, `push_config`, `rate_limit_events`. Correcto: tablas de tokens/estado que solo toca `service_role` desde edges.
- **Policies `USING(true)` (SELECT): 6** — todas revisadas, NO sensibles: `content_brand_config` (branding), `cron_job_descriptions` (texto), `email_settings` (toggles `enabled_kinds`, sin secretos — SMTP vive en env), `forum_upvotes`, `platform_settings` (toggle), `system_settings` (cuotas db/storage). UPDATE de cada una es Admin/SA. Diseño global-readable intencional.

### 🔴 Hallazgo CORREGIDO — `project_assignments` leak cross-tenant

`..._manage_staff [ALL]` estaba bien scopeada (`project_in_my_tenant`), pero convivía con `..._owner_or_staff [SELECT]` = `user_id=auth.uid() OR has_role('Docente') OR has_role('Admin')` (rama de rol **sin scope**). RLS combina con OR → cualquier Docente/Admin leía TODAS las asignaciones. **Verificado e2e**: docente de un tenant sin proyectos veía 17 filas de otros tenants. **Corregido** (mig `20261011000000`): drop de la policy rota + SELECT solo dueño + `is_super_admin`. Post-fix: docente=0, SA=17. → ver [migración](../supabase/migrations/20261011000000_fix_project_assignments_video_views_rls.sql).

### 🟠 Corregido preventivo — `video_views`

Mismo anti-patrón (`read_self` con `has_role` sin scope), 0 filas hoy. Re-scopeado: dueño ve las suyas, staff solo las de videos de SU tenant, SA todo. (Misma migración.)

### 🟡 Diferidos (no son leak de datos de alumno; requieren decisión/mig de schema)

- **`ai_override_codes` [ALL] + `ai_override_activations` [SELECT]**: `has_role('Admin')` sin scope; las tablas NO tienen `tenant_id` (pool global de códigos "IA inmediata"). Un Admin de un tenant puede ver/gestionar códigos de otro. Solo Admins (no alumnos), sin datos académicos. Para scopear hace falta agregar `tenant_id` + backfill por `created_by` → **decisión de producto pendiente** (ya estaba diferido de sesiones previas).
- **`notifications` [INSERT]**: el `with_check` deja a un Docente insertar una notificación a cualquier `user_id` (kinds limitados) sin verificar tenant. Severidad baja (spam de notificación, no exfiltración; el SELECT es recipient-only). Las notifs normalmente se crean por RPC SECURITY DEFINER, no INSERT directo. Pendiente analizar callers antes de endurecer.

**Falsos positivos del grep [4] descartados:** la mayoría de las policies marcadas scopean vía `EXISTS(course_teachers ...)` o `*_in_my_tenant(...)` (el regex no los detectó). Confirmado en `submissions`/`workshop_submissions`/`project_submissions`/`question_bank`/`grade_cuts`/etc. — ya validados e2e con 0 leaks arriba.

---

## Auditoría exhaustiva de funciones SECURITY DEFINER — 2026-06-28

Introspección de las **261 funciones SECDEF** de `public` + sus ACL de EXECUTE.

- **Trigger functions** (`_audit_*`, `_notify_*`, `_forum_*`, …): SECDEF + PUBLIC, pero no invocables vía PostgREST (requieren contexto de trigger) → no son superficie de ataque.
- **Helpers de RLS** (`_poll_*`, `course_in_my_tenant`, `current_tenant_id`, …): deben ser callable por authenticated (las policies los invocan); read-only.
- **`admin_*` / destructivas CON guard interno** (4): `admin_list_push_subscriptions`, `admin_update_my_tenant`, `reset_onboarding` (self-scoped), `hard_delete_tenant` (SA-only) — todas verifican `is_super_admin`/`has_role`/`auth.uid()` en el body. Callable por authenticated PERO guardadas → **OK**.

### 🔴 Hallazgo CORREGIDO — 6 funciones cron-only con EXECUTE a PUBLIC

Estas asumían "solo cron" y NO tenían guard de caller, pero su ACL otorgaba EXECUTE a PUBLIC → cualquier `authenticated` las invocaba vía `/rpc`. La crítica:

- **`purge_deleted_items(interval)`** — hard-DELETE de la papelera de TODOS los tenants (incl. `tenants` por cascade). **Verificado e2e**: un Docente la ejecutó (TTL=100 años → 0 borrados, pero con el default de 30d habría purgado todo). **Corregido** (mig `20261012000000`) → Docente ahora recibe `42501 permission denied`.
- `auto_finalize_courses`, `notify_students_course_closing`, `notify_students_cut_closing`, `notify_teachers_pending_grading`, `notify_teachers_workshop_due_tomorrow` — batch por fecha, 0 llamadas `.rpc()` reales en front/edge.

Fix: `REVOKE ALL FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role`. pg_cron (postgres/service_role) conserva acceso → jobs intactos. → ver [migración](../supabase/migrations/20261012000000_lockdown_cron_only_secdef_funcs.sql).

### Resumen de la revisión (sesión 2026-06-28)

| Capa | Resultado |
| --- | --- |
| e2e por muestreo (4 roles + 5 módulos) | 0 hallazgos (RLS rounds 1-13 confirmados) |
| Auditoría exhaustiva RLS (121 tablas) | **1 leak corregido** (`project_assignments`) + 1 preventivo (`video_views`) |
| Auditoría exhaustiva SECDEF (261 funcs) | **1 hallazgo crítico corregido** (`purge_deleted_items` + 5 cron-only) |
| Diferidos (decisión/schema) | `ai_override_codes`/`_activations` (sin tenant_id), `notifications` INSERT |

Migraciones de esta sesión: `20261011000000` (RLS) + `20261012000000` (SECDEF lockdown), ambas aplicadas + verificadas en prod.

---

## Auditoría exhaustiva de Storage (storage.objects) — 2026-06-28

Introspección de los **9 buckets** + **32 policies** de `storage.objects` (la superficie RLS de archivos, no cubierta antes esta sesión).

| Bucket | público | Scope de acceso | Veredicto |
| --- | --- | --- | --- |
| `db-backups` | no | `is_super_admin()` | OK (SA-only) |
| `feedback-attachments` | no | carpeta propia (`auth.uid()`) + relación de ticket | OK |
| `generated-contents` | no | dueño (`foldername[1]=uid`) **O** `Admin AND storage_owner_in_my_tenant(owner)` **O** SA; alumno: vía `content_course_assignments`+`course_enrollments` (publicado) | OK (tenant-scoped) |
| `message-attachments` | no | carpeta propia + relación de mensaje | OK |
| `project-files` | no | dueño **O** miembro del grupo | OK (restrictivo) |
| `support-attachments` | no | SA **O** creador del ticket | OK |
| `tenant-logos` | **sí** | SELECT abierto (logos públicos); write `Admin AND foldername=current_tenant_id` | OK |
| `videos` | **sí** | SELECT abierto (bucket público); write `(Docente\|Admin) AND storage_owner_in_my_tenant` | OK |
| `workshop-files` | no | dueño **O** miembro del grupo | OK |

- `storage_owner_in_my_tenant(_owner)` = `EXISTS(profiles p WHERE p.id=_owner AND p.tenant_id=current_tenant_id())` → ata el acceso staff al tenant del DUEÑO del archivo.
- Las 2 policies "abiertas" (`tenant-logos`/`videos` SELECT) son sobre buckets `public=true` → archivos servidos públicamente por diseño, no es leak.
- **0 policies over-permissive cross-tenant.**

**Verificado e2e**: docente de `examlab-demo` lista la carpeta de contenido de un owner de FESNA (28 archivos) → **0 objetos** (RLS los oculta). Aislamiento de storage confirmado.

**Conclusión Storage: sin hallazgos.** Cierra la última superficie RLS mayor (tablas + funciones SECDEF + storage = exhaustivo).

---

## Auditoría exhaustiva de Edge Functions (verify_jwt=false) — 2026-06-28

Las edges con `verify_jwt=false` NO son filtradas por el gateway → DEBEN validar al caller dentro del handler. Revisadas las **13** con esa config:

| Edge | Estrategia de auth | Veredicto |
| --- | --- | --- |
| `calendar` | `cron_sync_recordings`→service_role; resto→`getUserIdFromRequest` o 401 | OK |
| `calendar-oauth-callback` | público (redirect de Google); valida `state` contra `calendar_oauth_states` | OK (por diseño) |
| `send-push` | shared secret `PUSH_TRIGGER_SECRET` | OK |
| `retry-failed-ai-gradings` | shared secret `X-Trigger-Secret` | OK |
| `ai-grading-worker` | service_role O user JWT Admin/Docente → 401 | OK |
| `generate-contents` | service_role O RLS de `generated_contents` (gate agregado en sesión previa) | OK |
| `ai-generate-questions` | service_role O user JWT | OK |
| `ai-grade-submission` | X-Trigger-Secret / service_role / user JWT | OK |
| `request-password-reset` | público; token single-use + no-enumeration | OK (por diseño) |
| `confirm-password-reset` | público; valida token | OK (por diseño) |
| `db-backup-runner` | service_role O user Admin → 401 | OK |
| **`ai-generation-worker`** | **NINGUNA (era endpoint ABIERTO)** | **🔴 CORREGIDO** |

### 🔴 Hallazgo CORREGIDO — `ai-generation-worker` endpoint abierto

A diferencia de su gemelo `ai-grading-worker`, NO tenía gate de caller: pasaba de OPTIONS/method directo a drenar `ai_generation_queue` con `adminClient` (service_role, bypassa RLS). Con `verify_jwt=false`, **cualquiera** podía invocarlo. **Verificado e2e**: anon (solo apikey) → `200 {processed:0}` (handler ejecutó). Con jobs pending en tenants `sync` habría disparado generación IA on-demand (consumo de cuota del tenant). **Corregido** (commit `2308684e`): gate idéntico al de `ai-grading-worker` (service_role O Admin/Docente/SuperAdmin → 401). → anon ahora recibe 401.

**Conclusión Edge-auth: 1 endpoint abierto corregido; las otras 12 OK.** Surface de edges cerrada.

---

## Auditoría de Realtime — 2026-06-28

- **`realtime.messages` policies: 0** → la app NO usa canales *private* (Realtime Authorization); todos los canales son públicos.
- **Casi todos los canales usan `postgres_changes`** (notifications, timer, kahoot-game, attendance check-in, colas IA, support, polls): Supabase entrega solo las filas que el subscriptor puede `SELECT` → **RLS-gated** (cubierto por la auditoría de tablas). Seguros.
- **Único canal `broadcast`: la pizarra compartida** (`WhiteboardEditor`, topic `wb_session:<sessionId>`, `broadcast self:false`). Al ser público + sin Realtime Authorization, quien conozca el UUID de la sesión podría suscribirse y observar/inyectar trazos.

### 🟡 Defensa-en-profundidad (diferido, bajo riesgo) — broadcast de pizarra

NO es leak cross-tenant activo: el topic es el `session_id` (UUID), y `attendance_sessions` está aislada por tenant (verificado: un docente de otro tenant ve 0 sesiones → no puede aprender el UUID). Para explotarlo haría falta el UUID, que no se expone cross-tenant. **Recomendación**: migrar la pizarra a un canal *private* con `realtime.messages` RLS (Realtime Authorization) que valide matrícula/docencia del curso de la sesión. Es cambio arquitectónico (riesgo de romper la colaboración en vivo) → se deja como mejora, no hotfix.

---

## Resumen de cobertura de superficies (sesión 2026-06-28)

Las **5 superficies mayores de autorización** quedaron auditadas exhaustivamente:

| Superficie | Método | Resultado |
| --- | --- | --- |
| Tablas (RLS) | pg_policies, 121 tablas + e2e por rol | **1 leak corregido** (`project_assignments`) + `video_views` preventivo |
| Funciones SECURITY DEFINER | 261 funcs + ACL | **1 crítico corregido** (`purge_deleted_items` + 5 cron-only) |
| Storage | 9 buckets, 32 policies + e2e | 0 leaks |
| Edge functions (verify_jwt=false) | 13 edges | **1 endpoint abierto corregido** (`ai-generation-worker`) |
| Realtime | realtime.messages + canales | 0 leaks activos; 1 defensa-en-profundidad diferida (pizarra) |

**Migraciones/commits de seguridad de la sesión:** `20261011` (project_assignments/video_views), `20261012` (lockdown SECDEF cron), `2308684e` (ai-generation-worker auth). Todas aplicadas + verificadas en prod + desplegadas por CI.

**Diferidos (decisión de producto / cambio arquitectónico):** `ai_override_codes`/`_activations` tenant-scoping, `notifications` INSERT cross-tenant, Realtime Authorization de la pizarra.

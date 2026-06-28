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

**Resultado del sweep: 0 hallazgos de seguridad nuevos.** El endurecimiento RLS (rounds 1-13) se confirma empíricamente para los 4 roles. 1 falso-positivo descartado (`platform_settings`).

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

## Cobertura y limitaciones

- Probado e2e vía REST con tokens reales (respeta RLS) contra **producción**.
- Tablas cubiertas (alta sensibilidad): courses, exams/questions, workshops/workshop_questions, projects/project_files, submissions/workshop_submissions, exam_assignments, attendance_sessions, grade_cuts, whiteboards, polls, question_bank, course_enrollments, course_teachers, profiles, ai_model_settings, audit_logs, support_tickets, platform_settings.
- Cross-course **dentro del mismo tenant** para Docente no se pudo probar en vivo (el tenant demo del docente tiene 1 solo curso); cubierto por diseño (RLS por `course_teachers`) y por la denegación de escritura cross-tenant.
- Módulos no probados explícitamente vía REST (mismo patrón RLS, cubiertos en rounds previos): foros, mensajería 1-a-1, certificados, videos, ejecución de código. Candidatos para la siguiente iteración.

# Auditoría de seguridad — examlab

**Procedimiento**: Protocolo VVT-SEC-LOV-001
**Fecha**: 2026-05-10
**Alcance**: Repo + proyecto Supabase `rbfwsajdlfnlhhqyjedc`
**Modo**: Auditoría estática del repo + probe vía PostgREST con `anon_key`. **Sin PAT** todavía — varios hallazgos requieren confirmación con `supabase_list_rls_policies` para validar policy real en producción (que puede diferir del repo si alguien editó por dashboard).

---

## Resumen ejecutivo

| Severidad | Cantidad | Áreas |
|-----------|----------|-------|
| **CRÍTICO** | 2 | Integridad de exámenes (questions/exams), audit logs envenenables |
| **ALTO** | 3 | Privacidad de PII, Edge Functions sin verify_jwt, drift schema repo↔prod |
| **MEDIO** | 3 | CORS abierto, borrado de usuarios no transaccional, AI prompts visibles |
| **BAJO** | 1 | Filtro de errores de PostgREST revela schema |

---

## CRÍTICO

### C1 — Estudiantes pueden leer **todas las preguntas de todos los exámenes** antes de tomarlos

- **Archivo**: `supabase/migrations/20260419051958_*.sql:212-213`
- **Policy**:
  ```sql
  CREATE POLICY "Authenticated view questions"
    ON public.questions FOR SELECT TO authenticated USING (true);
  ```
- **Impacto**: anula la integridad de la evaluación. Cualquier `Estudiante` autenticado puede `SELECT * FROM questions` y ver el banco completo de preguntas, incluyendo respuestas correctas si están en columnas adyacentes.
- **Remediación** (Patrón B del Protocolo, membership):
  ```sql
  DROP POLICY "Authenticated view questions" ON public.questions;

  -- Estudiantes solo ven preguntas de exámenes que tienen asignados Y están abiertos
  CREATE POLICY "Students view assigned open questions"
    ON public.questions FOR SELECT TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.exam_assignments ea
        JOIN public.exams e ON e.id = ea.exam_id
        WHERE ea.exam_id = questions.exam_id
          AND ea.user_id = auth.uid()
          AND e.opens_at <= now()        -- ajustar al schema real
          AND e.closes_at >= now()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    );
  ```

### C2 — Audit logs envenenables: cualquier authenticated puede insertar entradas falsas

- **Archivo**: `supabase/migrations/20260509150000_audit_logs.sql:81-83`
- **Policy**:
  ```sql
  CREATE POLICY "audit_logs_insert" ON public.audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (true);
  ```
- **Impacto**: el log de auditoría es la base de la trazabilidad. Con `WITH CHECK (true)` un atacante puede:
  1. Inyectar entradas con `actor_id` de la víctima → inculpa a otro user.
  2. Llenar el log con basura para diluir entradas reales (denial of audit).
  3. Borrar nada (no hay policy DELETE → append-only correcto), pero la integridad del autor está rota.
- **Remediación**: forzar `actor_id = auth.uid()`:
  ```sql
  DROP POLICY "audit_logs_insert" ON public.audit_logs;

  CREATE POLICY "audit_logs_insert_self" ON public.audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (actor_id = auth.uid());
  ```
  Y considerar mover las inserciones a una RPC `log_audit_event` con `SECURITY DEFINER` (ya existe — ver migración línea 99) y revocar el INSERT directo del cliente.

---

## ALTO

### A1 — `profiles` expone `personal_email` e `institutional_email` de todo el sistema a cualquier estudiante

- **Archivo**: `supabase/migrations/20260419051958_*.sql:159-160`
- **Policy**:
  ```sql
  CREATE POLICY "Profiles viewable by all authenticated"
    ON public.profiles FOR SELECT TO authenticated USING (true);
  ```
- **Impacto**: un estudiante puede enumerar emails personales/institucionales de todos los admins, docentes y compañeros. Útil para phishing targeted.
- **Remediación**: solo exponer columnas no-sensibles a otros usuarios. Una opción es separar la tabla:
  ```sql
  -- Tabla pública: solo lo necesario para mostrar autoría en la UI
  CREATE TABLE public.profiles_public AS
    SELECT id, full_name FROM public.profiles WITH NO DATA;

  -- O usar una vista con security_invoker
  CREATE VIEW public.profiles_public AS
    SELECT id, full_name FROM public.profiles;

  ALTER VIEW public.profiles_public SET (security_invoker = on);
  ```
  Y en `profiles` solo permitir SELECT al dueño + admins. Las queries del frontend pasan a `profiles_public`.

### A2 — `exams` con SELECT abierto: estudiantes ven exámenes futuros antes de la apertura

- **Archivo**: `supabase/migrations/20260419051958_*.sql:204-205`
- **Policy**:
  ```sql
  CREATE POLICY "Authenticated view exams"
    ON public.exams FOR SELECT TO authenticated USING (true);
  ```
- **Impacto**: estudiantes ven el calendario y configuración (`title`, `description`, `duration`, etc.) de exámenes que aún no están abiertos, permitiendo preparación dirigida.
- **Remediación**: los estudiantes solo ven exámenes que están en su `exam_assignments`. Docentes/Admins ven todos:
  ```sql
  DROP POLICY "Authenticated view exams" ON public.exams;

  CREATE POLICY "Students view assigned exams"
    ON public.exams FOR SELECT TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.exam_assignments
              WHERE exam_id = exams.id AND user_id = auth.uid())
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    );
  ```

### A3 — Edge Function `execute-code` no valida JWT del user

- **Archivo**: `supabase/functions/execute-code/index.ts`
- **Problema**: la función no llama a `supabase.auth.getUser()` antes de procesar la request. Si el flag `verify_jwt` no está activado en `supabase/config.toml` (verificar), un atacante anónimo podría:
  1. Invocar la función directamente con cualquier `sourceCode`.
  2. Consumir la cuota de **JDoodle API** (que cobra por ejecución) → abuso de costos / DoS económico.
  3. Usar la infraestructura del cliente como proxy de ejecución de código arbitrario.
- **Remediación**:
  - Agregar `[functions.execute-code] verify_jwt = true` en `supabase/config.toml` (si no está).
  - Al inicio del handler, validar el JWT y verificar que el user esté inscrito en el curso del `questionId` solicitado.
  - Implementar rate-limit por `user_id` (ej. máx 30 ejecuciones / minuto).

### A4 — Drift schema repo ↔ producción

- **Hallazgo del probe**: las tablas `audit_logs`, `ai_prompts`, `ai_model_settings` devuelven `404 not_found` en el proyecto `rbfwsajdlfnlhhqyjedc`, aunque las migraciones del repo las definen.
- **Significado**: el proyecto Supabase auditado no tiene aplicadas las migraciones recientes. O bien el repo apunta a otro proyecto (staging/prod), o falta `supabase db push`.
- **Remediación**:
  - Confirmar cuál es el proyecto Supabase real de producción (¿este es staging?).
  - Aplicar las migraciones pendientes con `supabase db push` (con backup previo).
  - Establecer un check pre-deploy que valide que `supabase db diff` está vacío.

---

## MEDIO

### M1 — CORS `Access-Control-Allow-Origin: *` en Edge Functions

- **Archivos**: `supabase/functions/admin-delete-users/index.ts:5`, `execute-code/index.ts:9`, presumiblemente otros.
- **Impacto**: cualquier sitio web puede hacer requests CORS a estas funciones (con un JWT válido robado de un user). El JWT se obtiene con un XSS en cualquier app del cliente que comparta este Supabase backend.
- **Remediación**: allowlist el origen real:
  ```ts
  const allowed = (Deno.env.get("ALLOWED_ORIGIN") ?? "").split(",");
  const origin = req.headers.get("origin") ?? "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "null",
    ...
  };
  ```

### M2 — `admin-delete-users` borra datos en cascada sin transacción

- **Archivo**: `supabase/functions/admin-delete-users/index.ts:53-72`
- **Impacto**: el borrado se hace en una secuencia de DELETEs separados. Si falla a la mitad, queda inconsistencia (ej. `profiles` borrado pero `auth.users` sigue, o viceversa).
- **Remediación**: envolver en una function PL/pgSQL `SECURITY DEFINER` ejecutada en una sola transacción, e invocarla con `admin.rpc('delete_user_cascade', { user_id })`.

### M3 — `ai_prompts` con `SELECT TO authenticated USING (true)`

- **Archivo**: `supabase/migrations/20260508100000_ai_prompts.sql:62`
- **Impacto**: cualquier authenticated puede leer los system prompts del módulo AI (calificación de exámenes, detección de plagio, generación de preguntas). Esto le da al estudiante:
  - Conocer cómo el AI evalúa → preparar respuestas que satisfagan el rubric específico.
  - Conocer cómo se detecta plagio → técnicas de evasión.
  - Prompt injection dirigido contra los criterios del AI.
- **Remediación**: SELECT solo a `Docente` y `Admin`.

---

## BAJO

### B1 — PostgREST 404 incluye `hint` con tabla más cercana

- **Hallazgo**: el código `PGRST205` en respuestas 404 incluye `"hint": "Perhaps you meant the table 'public.<otra_tabla>'"`.
- **Impacto**: un atacante anónimo enumera el schema completo iterando con nombres aleatorios. No es secreto (los nombres de tabla rara vez lo son), pero es info útil para reconocimiento.
- **Remediación**: a nivel Supabase no hay forma directa de desactivar el `hint`. Se mitiga teniendo policies `TO anon` correctamente cerradas, lo cual ya es necesario por otras razones.

---

## Notas operativas

- **Falso positivo descartado**: el primer probe con `supabase_probe_anon` reportó `profiles` y `user_roles` como leíbles por anon. Era artefacto del método (`?limit=0` con tabla vacía → 200 OK indistinguible). La tool fue corregida (commit del MCP server) para distinguir `rows_visible` de `empty_or_blocked`. Las policies reales en migraciones son `TO authenticated`, no `TO anon`.
- Los hallazgos C1, C2, A1, A2, A3, M3 dependen exclusivamente del repo. Aplicarán siempre que las migraciones se hayan ejecutado tal cual están escritas. Para confirmar contra **producción** hace falta correr `supabase_list_rls_policies` con un PAT, en caso de que alguien haya modificado policies por dashboard.
- Próximo paso recomendado: generar PAT y correr el inventario completo (`supabase_list_tables`, `supabase_list_rls_policies`, `supabase_list_edge_functions`, `supabase_list_buckets`) para descartar drift entre repo y producción y completar las Fases 5 y 6 del Protocolo.

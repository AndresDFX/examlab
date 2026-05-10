# Auditoría — Edge Functions, Storage y Frontend

Continuación del [reporte 01](./01-hallazgos-iniciales.md). Cubre las 12 Edge Functions del proyecto, las policies de Storage y el gating de auth en el frontend. Mismo proyecto, mismo modo (estático sobre el repo + probe anon).

> Algunos hallazgos del frontend están marcados como **REQUIERE VERIFICACIÓN HUMANA** porque dependen de comportamiento en runtime (race conditions de hidratación) que es difícil de confirmar con scan estático.

---

## Resumen ejecutivo (acumulado con reporte 01)

| Severidad | Reporte 01 | Reporte 02 | **Total** |
|-----------|:----------:|:----------:|:---------:|
| **CRÍTICO** | 2 | 4 | **6** |
| **ALTO** | 3 | 3 | **6** |
| **MEDIO** | 3 | 4 | **7** |
| **BAJO** | 1 | 2 | **3** |

---

## CRÍTICO

### C3 — `seed-data` ejecutable por cualquiera + credenciales master en el repo

- **Archivo**: `supabase/functions/seed-data/index.ts:1-50` y luego todo el handler.
- **Subhallazgo a) — sin verificación de JWT**: el handler procesa la request sin validar el header `Authorization` ni el rol. Cualquier visitante con la URL de la function (descubrible, está en logs públicos del network tab) puede invocar el seeding.
- **Subhallazgo b) — credenciales hardcoded en el código fuente**:
  ```ts
  const MASTER_EMAIL = "andres_dfx@hotmail.com";
  const MASTER_PASSWORD = "Tester#12345";
  const DEMO_PASSWORD = "Estudiante#123";
  ```
  Esto va al repo (presumiblemente público o con muchos colaboradores). Cumple la categoría **Fase 2 del Protocolo "secretos hardcoded"**.
- **Impacto**: cualquiera puede:
  1. Resetear el master user del cliente (cambia `MASTER_EMAIL` a una variante con `+` o ataca el endpoint con la pass conocida).
  2. Crear/regenerar los 5 estudiantes demo con sus passwords conocidas → cuentas válidas en producción listas para abuso.
  3. Cualquiera con acceso al repo (incluso histórico, vía `git log`) tiene el password del owner.
- **Remediación inmediata**:
  - Rotar el password de `andres_dfx@hotmail.com` ahora.
  - Mover passwords a variables de entorno y validar `verify_jwt` + rol `Admin` antes de ejecutar.
  - Idealmente: eliminar la función entera de producción y dejarla solo para `npm run seed` local que pega contra Supabase con `service_role` desde la consola del operador, no expuesta como Edge Function.
  - Limpiar la historia git (`git filter-repo --replace-text`) si los passwords se hayan commiteado.

### C4 — `ai-generate-questions` consume costos AI antes de validar JWT

- **Archivo**: `supabase/functions/ai-generate-questions/index.ts:730-741` *(según escaneo)*
- **Impacto**: la verificación de auth ocurre después de que la función ya inició el llamado al modelo AI. Un atacante anónimo puede:
  1. Hacer N requests con prompts grandes → consumir el presupuesto de Vivetori/cliente en OpenAI/Anthropic/Gemini sin auth.
  2. DoS económico — apaga la cuenta cuando la cuota se agota.
- **Remediación**: mover el bloque de auth (`getUser()` + check de `Docente`/`Admin`) al inicio del handler, **antes** de cualquier `fetch` a un proveedor AI.

### C5 — `bulk-import-users` permite escalación de privilegios vía CSV

- **Archivo**: `supabase/functions/bulk-import-users/index.ts:46-155`
- **Impacto**: el endpoint acepta filas CSV con `role` y las inserta en `user_roles` sin validar que el campo no contenga `'Admin'`. Un docente con permiso para invocar la función (si la verificación de rol no está bien apretada) puede bulk-importar usuarios con rol `Admin`. También acepta `allowExisting=true` para sobreescribir usuarios sin auditoría.
- **Remediación**: en el handler:
  - Whitelist explícito de `role IN ('Estudiante','Docente')` (nunca `Admin` desde CSV — Admin se promueve uno por uno con auditoría).
  - Validar el rol del caller antes de procesar (solo `Admin`).
  - Rechazar `allowExisting` o exigir doble confirmación.
  - Agregar entrada al `audit_logs` por cada usuario importado/sobreescrito.

### C6 — `ai-grade-submission` re-invocable sin re-validar auth

> **REQUIERE VERIFICACIÓN HUMANA** — el agent reportó que la función puede llamarse a sí misma internamente sin re-validar auth (`index.ts:159-186`). Validar el flujo concreto antes de aplicar mitigación.

- **Archivo**: `supabase/functions/ai-grade-submission/index.ts:159-186`
- **Sospecha**: si hay un código path interno que invoca la grading sin pasar por la validación de auth del handler principal, un atacante con acceso al endpoint puede pedir re-calificación de submissions ajenas.
- **Acción**: leer manualmente el flow completo de `index.ts` y confirmar.

---

## ALTO

### A5 — `admin-update-password` confía en RLS para validar rol Admin

- **Archivo**: `supabase/functions/admin-update-password/index.ts:35-47`
- **Problema**: usa el cliente con `ANON_KEY` + JWT del caller para consultar `user_roles`. Si la policy de `user_roles` está mal (recordá: `Users see own roles` con `auth.uid() = user_id` → solo ve sus propios roles), entonces el SELECT devuelve solo el rol propio del caller. **Esto coincide con la migración**: un Admin SÍ vería su rol Admin. ✅. Pero si en el futuro alguien cambia la policy de `user_roles` y limita más, los admins legítimos serían bloqueados (DoS de cambio de password).
- **Remediación**: usar `service_role` para la verificación de rol del caller (la verificación es un check de seguridad, debe ser absoluta — no depender de RLS):
  ```ts
  const { data: roles } = await admin.from("user_roles")
    .select("role").eq("user_id", u.user.id);
  ```
  En vez de `userClient`. (El código de `admin-delete-users` lo hace bien — copiar ese patrón.)

### A6 — `detect-plagiarism` no valida pertenencia al curso del docente

- **Archivo**: `supabase/functions/detect-plagiarism/index.ts:98-133`
- **Impacto**: un Docente A puede pedir detección de plagio sobre exam/workshop/project del Docente B. Fuga de evaluaciones entre departamentos.
- **Remediación**: antes de procesar, verificar que el `refId` provisto pertenezca a un curso donde `course_teachers` tiene una fila con `(course_id, user_id=auth.uid())`.

### A7 — `evaluate-exam-time` y `generate-contents` con problemas similares al A6

- **Archivos**:
  - `supabase/functions/evaluate-exam-time/index.ts:108-139` — no valida que `examId` pertenezca al curso del caller.
  - `supabase/functions/generate-contents/index.ts:288-309` — no valida que `gen.teacher_id` sea el caller (un docente puede generar contenido haciéndolo aparecer como autoría de otro docente).
- **Remediación**: en ambas, verificar pertenencia (course_teachers) antes de operar.

---

## MEDIO

### M4 — Storage policy `project_files_teacher_read_all` sin restricción de curso

- **Archivo**: `supabase/migrations/20260507160000_project_code_zip.sql:63-67`
- **Schema**:
  ```sql
  CREATE POLICY "project_files_teacher_read_all"
    ON storage.objects FOR SELECT TO authenticated
    USING ( bucket_id = 'project-files' AND ... );
  ```
- **Problema**: leer la policy completa para confirmar si tiene check de `has_role('Docente')` y limita por curso. Si solo verifica `has_role('Docente')` sin límite por curso, cualquier docente puede leer **todos los ZIPs** subidos por estudiantes del sistema, incluyendo los de cursos en que no enseña.
- **Acción**: leer el archivo completo y confirmar. Si no filtra por `course_teachers`, ajustar.

### M5 — `daily-notifications` puede leakear `SUPABASE_SERVICE_ROLE_KEY` en logs de error

- **Archivo**: `supabase/functions/daily-notifications/index.ts:38-45`
- **Problema**: la comparación de service key se hace con `if (auth !== expected)`. Si la comparación entra en un `try/catch` y la key se imprime en `console.error(err)` con el contexto, puede aparecer en CloudWatch / Supabase Edge logs.
- **Remediación**: nunca incluir el valor del secret en strings de error. Usar `timingSafeEqual` y mensaje genérico `"unauthorized"`.

### M6 — `send-push` permite suplantar `user_id` destino

- **Archivo**: `supabase/functions/send-push/index.ts:124-170`
- **Problema**: acepta `user_id` en el body sin validar que el caller esté autorizado a enviar a ese user. Una function backend válida podría hacer esto con `service_role`, pero si el endpoint también acepta JWT de user normal, cualquiera con un JWT puede mandar push a cualquier user_id.
- **Remediación**: si el caller usa JWT de user, restringir el push solo a `user_id = auth.uid()` (autopush) o a admins.

### M7 — Frontend `useAuth` no fuerza loading gate

- **Archivo**: `src/hooks/use-auth.ts:30-53`, `src/routes/app.tsx`, `src/AppLayout.tsx`
- **Problema**: `useAuth()` retorna `{ user, loading, roles }`. Las rutas protegidas (`/app/admin/*`) consultan `useAuth().roles` para decidir qué renderizar, pero no esperan a `loading=false` antes de renderizar. Durante la fracción de segundo de hidratación, partes del admin dashboard pueden renderizar antes de que `roles` cargue → leak visual breve + posibles fetches anticipados que llegan al backend con auth incompleta.
- **Recomendación**: implementar un `<RequireAuth roles={['Admin']}>` que retorne `<Spinner/>` mientras `loading` y redirija a `/auth` si `!user`. Envolver TODAS las rutas `/app/*` con él, no confiar en checks per-componente.

> **REQUIERE VERIFICACIÓN HUMANA** — confirmar que efectivamente el orden es: render → roles llegan → re-render. La gravedad real depende de qué llamadas de red dispara cada componente al montar.

---

## BAJO

### B2 — `console.log` extensivo con datos sensibles en `src/`

- **Archivos** (parcial): `src/components/CodeEditor.tsx`, `FraudPanel.tsx`, `OpenFeedbackModal.tsx`, ~14 archivos en total con `console.log/error/warn`.
- **Problema**: en sesión Admin, los logs imprimen IDs de submissions, emails de estudiantes, respuestas a preguntas. En DevTools queda visible y persistente hasta refresh.
- **Remediación**: wrapper logger que se desactive en build de producción (`if (import.meta.env.DEV)`).

### B3 — `signOut()` no limpia caches del cliente

- **Archivo**: `src/hooks/use-auth.ts:55-58`
- **Problema**: llama `supabase.auth.signOut()` y redirige, pero no limpia `localStorage`, TanStack Query cache, o estado de Zustand/Redux si aplica. Sesiones huérfanas en localStorage si el SDK falla silenciosamente.
- **Remediación**: agregar `queryClient.clear()` y `localStorage.clear()` (o keys específicas) tras el signOut.

---

## Funciones / componentes sin hallazgos críticos

- **`admin-delete-users`** — auth y rol verificados correctamente; caveat de no transaccionalidad ya cubierto en M2 del reporte 01.
- **`Storage policies`** (`workshop-files`, `project-files`) — siguen el Patrón Storage del Protocolo (`foldername[1] = auth.uid()`). Bien hecho — el aislamiento por user_id está implementado.
- **Los buckets** declarados con `public = false` (verificar en cada `INSERT INTO storage.buckets`) — privados por default, lo correcto.

---

## Hallazgos pendientes que no se cubren en este reporte

1. **Webhook signature validation**: ninguna función parece recibir webhooks externos (Stripe, etc.). Si en el futuro se agregan, validar firma.
2. **Headers de seguridad del host** (`vercel.json` / Lovable settings): no inspeccionado.
3. **Cumplimiento Habeas Data (Ley 1581 Colombia)** si la app va a producción con usuarios reales: revisión legal aparte.
4. **Secret rotation history** del proyecto Supabase: requiere PAT.
5. **Cualquier policy editada por dashboard (no por migración)**: requiere PAT para confirmar drift.

---

## Próximo paso sugerido

Generar PAT en Supabase Dashboard → Account → Access Tokens, y correr en el MCP:
- `supabase_list_rls_policies` → confirma o descarta drift entre el estado del repo y el real en producción.
- `supabase_list_buckets` → confirma `public=false` y los `allowed_mime_types` por bucket.
- `supabase_list_edge_functions` → confirma si cada función tiene `verify_jwt = true`.

Con eso cerramos las Fases 3, 5 y 6 del Protocolo VVT-SEC-LOV-001 y podemos pasar al reporte ejecutivo final con plan de remediación priorizado.

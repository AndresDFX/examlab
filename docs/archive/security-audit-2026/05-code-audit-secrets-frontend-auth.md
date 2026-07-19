# Auditoría de código — secretos y auth frontend (ExamLab)

**Protocolo:** VVT-SEC-LOV-001 (Fases 2 y 4)
**Fecha:** 2026-05-11
**Comando:** `code_audit_all_low`
**Alcance:** filesystem local (`src/`, `supabase/`, root) — sin PAT.

---

## Resumen ejecutivo

| Bloque         | Pass | Fail | Skipped | Críticos | Altos | Medios |
| -------------- | ---: | ---: | ------: | -------: | ----: | -----: |
| Secrets (14)   |   13 |    1 |       0 |        1 |     0 |      0 |
| Frontend auth (11) | 8 |    2 |       1 |        0 |     1 |      1 |
| **Total (25)** | **21** | **3** | **1** | **1**   | **1** | **1**  |

**Veredicto:** estado general bueno. **Cero secretos hardcoded** en código de cliente o edge functions. El gating de auth funciona correctamente (condición no invertida, espera `loading`, todas las rutas `/app/*` cubiertas). Hay 1 fail crítico de higiene (`.env` no blindado en `.gitignore`) y 2 mejoras menores de patrón en auth.

---

## Hallazgos

### 🔴 SEC-12 — Archivos `.env` no blindados en `.gitignore` (CRITICAL)

- **Evidencia:** existe `.env` en el root del proyecto y `.gitignore` **no contiene** un patrón `.env*` ni `.env`. Lovable gestiona `.env` automáticamente y no lo committea, pero el patrón debería estar explícito para defender contra commits accidentales (especialmente si alguien clona el repo y trabaja localmente con `git`).
- **Impacto real:** bajo en este proyecto porque `.env` solo contiene `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` y `VITE_SUPABASE_PROJECT_ID` (todas públicas). Pero si en el futuro se agrega un secreto al `.env` por error, no hay red de seguridad.
- **Remediación:**
  ```
  # agregar al .gitignore
  .env
  .env.*
  !.env.example
  ```
  Y `git rm --cached .env` si ya está versionado.

### 🟠 AUTH-3 — Falta componente nombrado `RequireAuth` / `ProtectedRoute` (HIGH)

- **Evidencia:** el gating vive **inline** dentro de `src/components/AppLayout.tsx` (L369: `if (!loading && !user && !isTakingExam) navigate({ to: "/auth" })` + L397: `if (!user) return null`). Funciona y cubre todas las rutas `/app/*`, pero no está extraído a un componente reusable.
- **Impacto real:** bajo. La lógica es correcta (ver AUTH-4, AUTH-5, AUTH-6 todos en pass). Es un punto de mantenibilidad, no de seguridad activa.
- **Remediación opcional:** extraer a `<RequireAuth>` separado para que un `useEffect` no se mezcle con la lógica de presentación del layout. No urgente.

### 🟡 AUTH-8 — `signOut()` no limpia caches explícitamente (MEDIUM)

- **Evidencia:** `src/hooks/use-auth.ts` L55-58:
  ```ts
  const signOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };
  ```
  El `window.location.href` fuerza un full reload, lo cual **sí** limpia React state, TanStack Query cache, IndexedDB en memoria — pero no hay un `queryClient.clear()` ni `localStorage.removeItem` explícito antes del reload. Si alguien refactoriza a `navigate({ to: "/auth" })` (SPA nav) sin ese `clear`, datos del usuario anterior podrían quedar visibles en el cache de TanStack Query.
- **Remediación recomendada:**
  ```ts
  const signOut = async () => {
    await supabase.auth.signOut();
    queryClient.clear();
    // Si hay caches IndexedDB de offline-sync con datos del user:
    // await clearLocalAnswers(...);
    window.location.href = "/auth";
  };
  ```

---

## Checks que pasaron (21)

### Secretos (13/14)

| ID     | Título                                       |
| ------ | -------------------------------------------- |
| SEC-1  | JWT Supabase hardcoded                       |
| SEC-2  | Literal `service_role` en `src/`             |
| SEC-3  | Stripe live key                              |
| SEC-4  | Stripe test key                              |
| SEC-5  | AWS access key (AKIA...)                     |
| SEC-6  | Google API key (AIza...)                     |
| SEC-7  | GitHub PAT (ghp_/gho_/...)                   |
| SEC-8  | Supabase PAT (sbp_)                          |
| SEC-9  | Slack tokens (xox*)                          |
| SEC-10 | OpenAI / Anthropic / generic `sk-`           |
| SEC-11 | `VITE_*` con palabras `SECRET/PRIVATE/...`   |
| SEC-13 | `.pem`, `.key`, `serviceAccountKey.json`     |
| SEC-14 | Master / admin / root password hardcoded     |

### Frontend auth (8/11 + 1 skipped)

| ID      | Título                                                |
| ------- | ----------------------------------------------------- |
| AUTH-1  | Cliente Supabase singleton                            |
| AUTH-2  | Hook `useAuth` con `loading`                          |
| AUTH-4  | Guard espera `loading=false`                          |
| AUTH-5  | Condición de guard NO invertida (`!user → /auth`)     |
| AUTH-6  | Todas las rutas privadas envueltas en guard           |
| AUTH-7  | `signOut()` invoca `supabase.auth.signOut()`          |
| AUTH-9  | Sin `console.log` de objetos `user/session/profile`   |
| AUTH-11 | Reset/cambio de contraseña usa `auth.updateUser()` oficial |

**Skipped:** AUTH-10 (OAuth redirect URLs — vive en Supabase Dashboard, no auditable desde filesystem).

---

## Acciones recomendadas (orden de prioridad)

1. **Higiene `.gitignore`** — 30 segundos, blindar `.env*`.
2. **Extraer `RequireAuth`** — opcional, mejora mantenibilidad.
3. **Limpiar caches en `signOut`** — agregar `queryClient.clear()` antes del reload por defensa en profundidad.

Ningún fail requiere rotación de credenciales ni `git filter-repo`.

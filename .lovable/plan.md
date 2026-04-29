## Activar Sentry en ExamLab

Sí es posible integrar Sentry. No hay un conector nativo de Sentry en Lovable, así que se hace con el SDK oficial `@sentry/react` + el SDK para edge functions de Deno.

### Qué se necesita de tu parte

Necesitarás crear (gratis) una cuenta en [sentry.io](https://sentry.io) y obtener **2 DSN** (URLs de proyecto Sentry):

1. **DSN del frontend** (proyecto tipo "React")
2. **DSN de las edge functions** (proyecto tipo "Deno") — opcional pero recomendado

Te los pediré con el tool `add_secret` cuando aprobemos el plan.

### Cobertura de la integración

**Frontend (React + TanStack Start)**
- Captura automática de errores no controlados y promesas rechazadas.
- Integración con el `DefaultErrorComponent` y `notFoundComponent` del router.
- Captura del `window 'error'` y `unhandledrejection` que ya tienes en `__root.tsx` (chunk-load failures, etc.) — se enriquecen con contexto de Sentry.
- Session Replay opcional (graba la última sesión cuando hay un error). Lo dejamos **desactivado por defecto** para no consumir cuota; se activa cambiando un flag.
- Performance tracing al 10% de transacciones (configurable).
- Tag automático del usuario logueado (id + email) cuando hay sesión Supabase.
- Filtros para ignorar el ruido conocido: `NetworkMonitor: Timeout` del SW, `ChunkLoadError`, errores de extensiones, etc.

**Edge Functions (Deno)**
- Wrapper `withSentry()` reutilizable para envolver los `Deno.serve()` de las 8 funciones (`ai-grade-submission`, `ai-generate-questions`, `bulk-import-users`, etc.).
- Captura excepciones no manejadas con contexto del request (path, headers seguros, user_id si está autenticado).

**Server functions / SSR (TanStack Worker)**
- No se incluye Sentry server-side por ahora: el Worker de Cloudflare requiere el SDK `@sentry/cloudflare` con configuración específica de wrangler que añade complejidad. Los errores SSR siguen viéndose en los logs del worker. Si lo quieres, lo añadimos en una segunda fase.

### Archivos que se crean/modifican

**Nuevos**
- `src/lib/sentry.ts` — `initSentry()` con la config descrita arriba.
- `supabase/functions/_shared/sentry.ts` — helper `withSentry()` para edge functions.

**Modificados**
- `package.json` — añade `@sentry/react`.
- `src/router.tsx` — llama `initSentry()` antes de crear el router; envuelve `DefaultErrorComponent` con `Sentry.captureException`.
- `src/routes/__root.tsx` — registra el usuario actual en Sentry cuando cambia la sesión (`supabase.auth.onAuthStateChange`).
- Las 8 edge functions en `supabase/functions/*/index.ts` — envolver el `Deno.serve` con `withSentry()`.
- `.env` queda intacto (los DSN del frontend se inyectan vía `import.meta.env.VITE_SENTRY_DSN`, que se configura como secreto del proyecto).

### Pasos cuando apruebes

1. `add_secret` para `VITE_SENTRY_DSN` (frontend) y `SENTRY_DSN_EDGE` (edge functions).
2. `bun add @sentry/react`.
3. Crear `src/lib/sentry.ts` y `supabase/functions/_shared/sentry.ts`.
4. Integrar en `router.tsx` y `__root.tsx`.
5. Envolver las 8 edge functions y desplegarlas.
6. Te confirmo y te doy un test manual de 1 línea para ver el primer evento en tu dashboard Sentry.

### Nota sobre costos

Sentry tiene plan gratuito: 5K errores + 10K replays + 10K spans / mes. Para un curso académico es más que suficiente. Si lo superas, te avisa antes de cobrarte — no hay sorpresas.
/**
 * TenantUrlGuard — actualmente NO-OP.
 *
 * Historia: este componente tuvo varias encarnaciones intentando hacer
 * que el slug del tenant apareciera en la URL (`/t/<slug>/app/...`).
 *
 *   v1: stripeaba `/t/<slug>` de URLs entrantes y setteaba
 *       localStorage. URLs reales quedaban como `/app/...`.
 *   v2: redirigía `/app/...` a `/t/<slug>/app/...` para hacer el slug
 *       visible. Funcionaba en localhost pero en Lovable falla.
 *
 * Por qué fallaba v2: el hosting de Lovable usa TanStack Start con SSR.
 * El servidor recibe `/t/<slug>/app`, le aplica el INPUT rewrite que
 * strippea el prefix → router internamente trabaja con `/app`. Pero el
 * OUTPUT rewrite en server no captura el slug (no hay `window`), así
 * que el "canonical URL" computado es `/app` (sin prefix). TanStack
 * detecta que `publicHref !== canonical.publicHref` y emite un
 * **307 Temporary Redirect** → `/app`. El cliente, al cargar `/app`,
 * volvía a redirigir a `/t/<slug>/app`, recibía 307, etc. — loop
 * infinito visible como "infinite reload" en impersonación.
 *
 * Decisión actual: el slug NO aparece en URL. El tenant context vive
 * en `profile.tenant_id` (server-side RLS authority) + localStorage
 * `examlab_tenant_override` (SuperAdmin "Ver como X" UI-only). Es
 * cómodo, suficiente para la app, y NO PELEA con el SSR de Lovable.
 *
 * Este componente queda como no-op para no romper el mount tree en
 * `__root.tsx`. Si en el futuro se migra el routing real para
 * `t.$tenantSlug.app.*.tsx` (rename masivo), este guard se borra.
 */
export function TenantUrlGuard() {
  return null;
}

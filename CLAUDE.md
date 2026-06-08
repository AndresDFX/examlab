# ExamLab — Claude Context

## Setup en una máquina nueva

```bash
git clone git@github-personal:AndresDFX/examlab.git
cd examlab
bun install              # NO npm/pnpm — el lockfile es bun.lock
bun run dev              # localhost:5173
```

**Archivos secretos que no se commitean** (recrearlos al clonar):

- `.env` — Supabase URL + anon key. La anon key es pública (está en el bundle), pero la guardamos acá para que `bun run dev` arranque:
  ```
  VITE_SUPABASE_URL="https://uxxpzfsfcnqiwwdxoelm.supabase.co"
  VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbG...EdZ_3KlDGVSQ-i026ZriHu4FbLFJLwghkW-FlfcTlkE"
  VITE_SUPABASE_PROJECT_ID="uxxpzfsfcnqiwwdxoelm"
  VITE_VAPID_PUBLIC_KEY="BAg2gqFTm-P9_gNuumcJPQF7fj-6e2XjlSDZJGTGa2YMvZSDdKD6C6S3pc88UM7mvBNrlcebXUXeJzqKp4bROVo"
  ```
- `.env.recording` — credenciales para grabar los tours HeyGen (ver "Cuentas de testing" abajo). Solo necesario si vas a re-grabar.

**Validaciones rápidas**:
- `bun tsc --noEmit` debe dar `EXIT=0`.
- `bun test` corre vitest (jsdom). Algunos tests requieren jsdom — usar `bun test` (NO el harness embebido).
- `bun run build` localmente. Si pasa, Lovable también buildea.

**Cuentas de testing (tenant FESNA)** — verificadas el 2026-06-08:
- **SuperAdmin (cross-tenant)**: `castano.julian@correounivalle.edu.co` / `Tester#12345`. Tenant_id=NULL. Acceso a `/app/superadmin/*` + bypass de RLS via `is_super_admin()`.
- **Multi-rol (Admin + Docente + Estudiante) en FESNA**: `test-fesna@examlab.test` / `WyEBPdxMCRZVFp`. user_id `d0495677-9f20-4f6f-b4f2-7f616b608a04`. Tenant FESNA (`231c9e47-e50d-45a9-8782-af38087656a4`). Útil para testing programático de los 3 roles sin crear cuentas separadas — el role-switcher del sidebar cambia entre ellos.

**Tenant FESNA — estado** (snapshot 2026-06-08):
- 1 curso activo: `Paradigmas de Programación Junio 2026` (id `01b397a3-e74f-4f66-becf-c63b643f247f`).
- 93 estudiantes importados del CSV de "La Nueva América" (`*@lanuevaamerica.edu.co`), todos matriculados al curso de arriba.
- `ai_model_settings.processing_mode = sync` (necesario para que la generación con IA del docente funcione inline sin pedir código).
- `email_settings.enabled_kinds.welcome = false` (no manda welcome email al bulk import).

**Validaciones de campo desde shell** (sin browser, via REST):

```bash
# Login a Supabase Auth
TOKEN=$(curl -s -X POST 'https://uxxpzfsfcnqiwwdxoelm.supabase.co/auth/v1/token?grant_type=password' \
  -H 'Content-Type: application/json' -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY" \
  -d '{"email":"test-fesna@examlab.test","password":"WyEBPdxMCRZVFp"}' | jq -r .access_token)

# Query como el user logueado (respeta RLS)
curl -s "https://uxxpzfsfcnqiwwdxoelm.supabase.co/rest/v1/courses?select=id,name" \
  -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer $TOKEN"
```

Patrón usado mucho en testing — se puede simular casi todo lo que el UI hace sin tener que abrir un browser. La cuenta test-fesna tiene los 3 roles, así que sirve para validar flows Admin/Docente/Estudiante con el mismo token.

## Plataforma y despliegue

- **Hospedado en Lovable** (lovable.dev). Lovable gestiona Supabase automáticamente.
- El usuario **SÍ tiene acceso al dashboard de Supabase** (proyecto `uxxpzfsfcnqiwwdxoelm`). Para diagnósticos podemos darle queries SQL one-shot que él corre en el SQL Editor del dashboard.
- Flujo de despliegue: `git push origin main` → usuario da click en **Publish** en Lovable.
- Las migraciones van en `supabase/migrations/*.sql` — Lovable las aplica en Publish.
- **Defensiva clave**: cada migración nueva DEBE envolver `ALTER TABLE` en `DO $$ BEGIN IF to_regclass('public.X') IS NOT NULL THEN ... END IF; END $$` por si la tabla NO existe en el entorno del usuario. Lovable a veces marca migraciones como aplicadas aunque el CREATE TABLE no haya corrido — sin el guard, la migración falla y se aborta todo el deploy. Patrón confirmado al fallar `question_bank` en 20260813000000.
- Remote git: `git@github-vivetori:vivetori/examlab.git` (nombre: `origin`)
- Lockfile: el repo usa **`bun.lock`** (NO `package-lock.json` ni `pnpm-lock.yaml`). Cualquier cambio en `package.json` requiere `bun install` para regenerar el lockfile y commitear AMBOS — el CI valida sincronía.

## Stack

- React 18 + TanStack Router v1 + TypeScript
- UI: shadcn/ui (Card, Button, Badge, Dialog, Alert…) + design system propio (ver abajo)
- DB: Supabase (PostgreSQL + RLS)
- i18n: react-i18next (es-CO default)
- Offline: idb-keyval (IndexedDB)
- Toast: sonner
- AI grading: Lovable AI Gateway → `google/gemini-2.5-flash` / `gemini-2.5-pro`

---

## Regla de UI: usar el design system propio SIEMPRE

Antes de añadir markup nuevo o tocar estilos en una pantalla, **revisar primero si existe un componente del design system propio que cubra el caso**. Si existe, usarlo. Si no existe pero el patrón se va a repetir, **proponer crear el componente y agregarlo a este CLAUDE.md** antes de implementarlo inline en una sola pantalla.

Ej: estoy por agregar una nueva tabla → en el empty state usar `<TableEmpty>`, en el loading state usar `<TableSkeleton>`, en las acciones por fila usar `<RowAction>`. NO escribir `<Button variant="ghost" size="sm" title="...">` para acciones de fila.

### Catálogo del design system

Vive en `src/components/ui/`. Componentes propios (encima de shadcn):

| Componente                                                                                                                                                                  | Para qué                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Label` (con prop `required`)                                                                                                                                               | Forms con asterisco rojo en campos obligatorios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DecimalInput`                                                                                                                                                              | Inputs numéricos con coma como separador (siempre). Bloquea el punto, lo auto-convierte a coma. Emite `number \| null` con punto al padre.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PasswordInput` ([password-input.tsx](src/components/ui/password-input.tsx))                                                                                                | Input de contraseña con botón "ojo" mostrar/ocultar integrado. **TODO campo de contraseña DEBE usar este componente** — no escribir el patrón inline `<Input type={show?"text":"password"}/> + <button ojo>`. Maneja su propio estado de visibilidad (el caller solo pasa `value`/`onChange`/`placeholder`/etc. como a un `Input`). Props extra: `wrapperClassName` (para el wrapper `relative` — ej. `flex-1`, `mt-1`), `revealLabel`/`hideLabel` (aria-label del botón, default español; en flujos i18n pasar `t("auth.showPassword")` / `t("auth.hidePassword")`). El botón es `tabIndex={-1}` (no entra en el tab order). Aplicado en `ForceChangePasswordDialog`, `ChangePasswordDialog`, `AdminModelPanel`. Quedan inline (ya tenían ojo, migrar oportunamente): `auth.index`, `auth.reset-password`, `AdminEdgeSecretsPanel`, `app.admin.users`.                                                                                                                                                                                                                                                                                                                                |
| `RowAction`                                                                                                                                                                 | Botones de acción icon-only en grids/listas. Tooltip + aria-label automáticos. Soporta `tone="destructive"` y `asChild` (para Link).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RowActionsMenu` ([row-actions-menu.tsx](src/components/ui/row-actions-menu.tsx))                                                                                           | Menú "tres puntos" (`MoreVertical`) para acciones de fila en grids principales. API declarativa: `<RowActionsMenu actions={[{label, icon, onClick \| to+params \| href, tone?, iconColor?, separatorBefore?, disabled?, hint?}]} />`. Items nullish (`false`/`null`) se filtran automáticamente — útil para acciones condicionales sin envolver en `if`. **Cuándo usar `RowActionsMenu` vs `RowAction`**: 3+ acciones por fila → menú; 1-2 acciones inline en toolbars → `RowAction`. Aplicado en grids principales: Cursos (admin), Exámenes, Talleres, Proyectos, Usuarios y Certificados. Convención de orden: gestión de relaciones → contenido → editar → duplicar → separator + eliminar (`tone="destructive"`). **`iconColor`** (hex / CSS var / oklch): pinta el ícono del item con un color literal — usado para anclar acciones a la marca de la entidad de la fila. Ej. "Iniciar sesión como Admin" en `/app/superadmin/tenants` pasa `iconColor: t.primary_color`; "Iniciar como" en `/app/admin/users` pasa `iconColor: "var(--brand-primary)"`. |
| `StatusBadge`                                                                                                                                                               | Estados de exam/workshop/project/submission con variant + ícono unificado. `sospechoso/requiere_revision` → destructive con AlertTriangle, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BadgeOverflow` ([badge-overflow.tsx](src/components/ui/badge-overflow.tsx))                                                                                                | Lista de badges con tope visual. Muestra los primeros N inline + un `+M` con tooltip que lista el resto. Usado en columnas de etiquetas (roles, programas, tags) para que filas con muchos items no rompan el ancho estable del grid. API: `<BadgeOverflow items={...} max={2} />`. Soporta `renderItem` / `renderTooltipItem` para casos custom. Default `max=2`, variant `secondary`, text-[10px]. Empty state "—". **Cuándo usar:** cualquier columna con array donde el caso típico es 1-2 items pero hay outliers con 4+. Aplicado en Usuarios (columna Roles).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EmptyState` / `TableEmpty`                                                                                                                                                 | "Sin datos" con padding y tono consistente. `TableEmpty` se usa como fila dentro de `<TableBody>` con `colSpan`. Soporta prop `action` para CTA tipo "Crear primer X".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ErrorState` ([empty-state.tsx](src/components/ui/empty-state.tsx))                                                                                                         | Placeholder cuando una query principal falla y deja la pantalla sin datos. Mismo layout que EmptyState pero ícono AlertTriangle + botón "Reintentar". Reemplaza el patrón "toast.error en catch + UI vacía" que dejaba al user adivinando si la app cargaba, estaba vacía o rota. Patrón: `const [loadError, setLoadError] = useState<string\|null>(null); ... if (loadError) return <ErrorState message="Título" hint={loadError} onRetry={retry} />;` donde `retry` bumpea un `retryNonce` para re-disparar el effect. Aplicado de muestra en `app.student.grades.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Spinner`                                                                                                                                                                   | Wrapper sobre `Loader2` con tamaños semánticos (`xs`/`sm`/`md`/`lg`/`xl`). Reemplazo de `<Loader2 className="h-4 w-4 animate-spin" />` directo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SectionLoader` / `PageLoader`                                                                                                                                              | Placeholders "Cargando…" para secciones / páginas completas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TableSkeleton` / `ListSkeleton`                                                                                                                                            | Placeholders pulsantes para grids/listas mientras cargan datos. Mejor UX que "Cargando…" sobre tabla vacía.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PageHeader`                                                                                                                                                                | Header de páginas de detalle: breadcrumb "← Volver" arriba (no compite con el título), `title` h1, `subtitle`, slot `actions` opcional, slot `icon` opcional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ErrorBoundary`                                                                                                                                                             | React error boundary global, montado en `__root.tsx`. Captura errores fuera de rutas. Errores DENTRO de rutas los maneja `defaultErrorComponent` del router.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `useMultiSelect` + `MultiSelectHeaderCheckbox` / `MultiSelectCheckbox` / `MultiSelectToolbar` / `BulkDeleteDialog` ([multi-select.tsx](src/components/ui/multi-select.tsx)) | Multi-selección + bulk delete para grids/tablas. Hook devuelve `{ selectedIds, toggle, toggleAll, isSelected, allSelected, indeterminate, count, clear }`. Toolbar aparece arriba cuando `count > 0`. BulkDeleteDialog muestra conteo + lista expandible (preview 5, expansible al resto) y ejecuta `.delete().in('id', ids)` atómico. Aplicado en grids de Usuarios, Cursos, Exámenes, Talleres y Proyectos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ListFilters` ([list-filters.tsx](src/components/ui/list-filters.tsx))                                                                                                      | Barra estándar de búsqueda + filtro por curso para grids docente (talleres, proyectos, exámenes). Search input con ícono lupa + Select con "Todos los cursos" como default + botón "Limpiar" cuando hay filtros activos. Presentacional: el padre arma `filteredItems = useMemo(...)` y los pasa a `useMultiSelect` para que "seleccionar todo" abarque solo lo visible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `HelpHint` ([help-hint.tsx](src/components/ui/help-hint.tsx))                                                                                                               | Icono `?` con tooltip para texto de ayuda inline. Uso: `<Label>Campo <HelpHint>explicación detallada</HelpHint></Label>`. Reemplaza el patrón anterior `<span className="text-xs text-muted-foreground font-normal">(explicación)</span>`. Self-contained con su propio TooltipProvider. Soporta `side` y `align`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DateCell` ([date-cell.tsx](src/components/ui/date-cell.tsx))                                                                                                               | Celda estandarizada para mostrar una fecha en grids/tablas. `<DateCell value={...} variant="auto"\|"date"\|"datetime"\|"short" withIcon={false} />`. `auto` detecta `YYYY-MM-DD` y usa `formatDateOnly` (evita el bug UTC -1 día); con hora usa `formatDateTime`. Render `tabular-nums` + estado vacío "—". **Headers de fechas en grids docentes**: usar siempre "Inicio" / "Fin" (no "Fecha inicio"/"Fecha fin"/"Fecha límite") — el contexto del grid hace innecesario el prefijo "Fecha". En forms / Labels sí mantenemos "Fecha inicio" / "Fecha fin". Aplicado en grids de Cursos, Exámenes, Talleres y Proyectos.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `usePagination` ([use-pagination.ts](src/hooks/use-pagination.ts)) + `DataPagination` ([data-pagination.tsx](src/components/ui/data-pagination.tsx))                        | Paginación client-side para grids. **Hook**: `usePagination(filteredItems, { defaultPageSize: 25, storageKey: "examlab_pag:<route>", resetKey: "<filtros>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | <concat>" })`retorna`{ paginatedItems, currentPage, setCurrentPage, totalPages, pageSize, setPageSize, totalItems, startIndex, endIndex, pageSizes }`. Persiste page+size en localStorage (key opt-in). Reset a página 1 cuando cambia el `resetKey`(concatenar todos los filtros activos). Clampea automáticamente cuando los items shrinken bajo el page actual. **Componente**:`<DataPagination state={pagination} entityNamePlural="usuarios" />`ANTES del`</CardContent>`que envuelve la tabla. Muestra "X-Y de Z", selector "Por página" y nav prev/next con ellipsis. **Regla`useMultiSelect`**: NO cambiar — debe seguir operando sobre `filteredItems`completos (no`paginatedItems`) para que "seleccionar todos" abarque todas las páginas del filtro activo. Aplicado en historial IA, Usuarios, Cursos, Exámenes, Talleres, Proyectos, Contenidos, Banco de preguntas, Videos, Certificados, Tenants, Errores, Auditoría. **Vistas del estudiante con cards** (Exámenes, Talleres, Proyectos, Cursos, Polls activas/cerradas, Certificados) usan `defaultPageSize: 12`y`pageSizes: [6, 12, 24, 48]` — las cards son más grandes que las filas de tabla. |

### Helpers utilitarios (`src/lib/`)

| Helper                         | Para qué                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `formatDate(d)`                | "30 sep 2026"                                                                                  |
| `formatDateLong(d)`            | "30 de septiembre de 2026"                                                                     |
| `formatDateShort(d)`           | "30 sep" (sin año, para tiles angostos)                                                        |
| `formatDateTime(d)`            | "30 sep 2026, 14:30"                                                                           |
| `formatTime(d)`                | "14:30"                                                                                        |
| `formatWeekday(d)`             | "lunes, 30 de septiembre"                                                                      |
| `formatDateOnly("2026-09-30")` | Para columnas DATE sin TZ — ancla a 12:00 local para evitar el bug de descontar un día por UTC |
| `formatDuration(90)`           | "1h 30m"                                                                                       |

Locale es-CO hardcodeado en `Intl.DateTimeFormat` para que la app se vea igual independiente del SO/navegador del usuario.

### Reglas de layout / scroll

- **Sin scroll horizontal a nivel página**: nunca dejar que un grid o un Card haga overflow horizontal del viewport completo. El patrón estándar es envolver `<Table>` en `<CardContent className="p-0 overflow-x-auto">` (o un `<div className="overflow-x-auto">` interno si la Card tiene padding). Así, cuando una tabla tiene muchas columnas, hace scroll **dentro de su Card** sin empujar la página entera.
- **Modales con muchas columnas o flex-row**: usar `max-w-5xl`/`max-w-6xl`/`max-w-7xl` según necesidad. NO insistir con `max-w-3xl` cuando el contenido obviamente no cabe — eso es lo que causa scroll horizontal del modal.
- **Columnas progresivas**: las columnas secundarias del grid deben ir con `hidden sm:table-cell` / `hidden md:table-cell` / `hidden lg:table-cell` para que en pantallas chicas se oculten antes de forzar scroll.

### Redimensionado de columnas (`<Table resizable>`)

Los grids de listado aceptan `resizable` además de `fixed`: agrega handles tipo Excel en el borde derecho de cada encabezado. El usuario arrastra para redimensionar; doble clic restablece la columna.

- `resizable` implica `table-fixed` (el resize no tiene sentido en layout `auto`).
- **Persistencia automática, sin config por grid**: la clave de localStorage se deriva de `pathname + fingerprint de los textos de encabezado` (`examlab_colw:<ruta>:<hash>`). Si cambian las columnas, el fingerprint cambia y se descartan los anchos viejos.
- El ancho de la `<table>` se fija a la suma de columnas visibles para que `table-fixed` no re-escale al arrastrar (la lógica vive en `syncTableWidth` dentro de `table.tsx`).
- **Solo desktop** (`min-width: 640px`): en mobile los handles se ocultan (`hidden sm:block`) y los anchos pinneados se limpian → layout responsive normal.
- Aplicado en los 9 grids de listado: Cursos, Usuarios, Exámenes, Talleres, Proyectos, Contenidos, Videos, Banco de preguntas y Auditoría. **NO** en gradebook / asistencia / monitor — son matrices con columna sticky o columnas dinámicas, no grids de listado.

### Responsive (target 375-428px / iPhone Pro / Pixel grandes)

Cuatro reglas universales — aplicar siempre que se añada layout nuevo:

1. **Modales**: `max-w-2xl` etc. rebasan 375px porque el viewport es más chico que el `max-w-`. Patrón obligatorio:

   ```tsx
   <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
   ```

   En mobile usa el viewport menos 2rem de margen; en sm+ aplica el cap deseado.

2. **Grids**: empezar siempre en 1 columna y expandir con breakpoints:

   ```tsx
   <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
   ```

   Nunca `grid-cols-2` o `grid-cols-3` sin prefijo — fuerza columnas chicas e ilegibles en mobile.

3. **Tablas anchas**: wrapper con scroll horizontal **dentro** del Card + columnas secundarias ocultas:

   ```tsx
   <CardContent className="p-0 overflow-x-auto">
     <Table>
       <TableHead className="min-w-32">Estudiante</TableHead>
       <TableHead className="hidden sm:table-cell">Email</TableHead>
       ...
   ```

   Las columnas con datos largos (emails, descripciones) van `hidden sm:table-cell` o `md:table-cell`. Para tablas con `sticky left-0` (gradebook), bajar el `min-w-` de la sticky col en mobile (`min-w-36 sm:min-w-48`).

4. **Inputs con flex-1 + min-w**: el `min-w-48` (192px) en flex containers fuerza wrap raro a 375px. Bajar el piso en mobile:

   ```tsx
   <div className="flex-1 min-w-[160px] sm:min-w-48">
   ```

5. **Padding generoso**: `p-8` come 64px de cada lado a 375px. Usar `p-4 sm:p-8` cuando el padding sea decorativo (empty states, loaders).

### Patrones de comportamiento

- **`useConfirm()`** (de `ConfirmDialog`): para confirmaciones destructivas o de cambio importante. Retorna `Promise<boolean>`. NO construir Dialogs custom para esto.
  - Reglas de tono: `destructive` (eliminar), `warning` (acción reversible pero ojo: cerrar sesión, descartar cambios, entregar con preguntas en blanco), `default` (info).
  - Toda confirm destructive debe terminar con `"Esta acción no se puede deshacer."` o equivalente ("permanente").
- **Confirmación al entregar con respuestas en blanco**: examen, taller y proyecto detectan respuestas vacías antes de entregar y usan `confirm({ tone: "warning" })`.
- **`StatusBadge` para estados**: nunca pintar un Badge con clases ad-hoc para un estado. Usar `<StatusBadge status={x} />` que ya tiene el mapeo variant + ícono.

---

## Archivos clave

| Archivo                                                     | Propósito                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/app.student.take.$examId.tsx`                   | Pantalla de toma de examen (estudiante)                                                                                                                 |
| `src/routes/app.student.exams.tsx`                          | Lista de exámenes del estudiante                                                                                                                        |
| `src/routes/app.student.review.$examId.tsx`                 | Revisión de resultados                                                                                                                                  |
| `src/routes/app.student.grades.tsx`                         | Vista de notas por curso del estudiante                                                                                                                 |
| `src/routes/app.teacher.gradebook.tsx`                      | Gradebook docente con consolidado por corte + export CSV                                                                                                |
| `src/routes/app.teacher.monitor.$examId.tsx`                | Monitor en vivo del examen                                                                                                                              |
| `src/components/ExternalGradesEditor.tsx`                   | Notas de actividades externas (presencial / otra plataforma)                                                                                            |
| `src/components/FraudPanel.tsx`                             | Análisis IA + detección de copia entre estudiantes                                                                                                      |
| `src/integrations/supabase/types.ts`                        | Tipos generados de Supabase (no editar a mano)                                                                                                          |
| `src/lib/offline-sync.ts`                                   | IndexedDB sync (`clearLocalAnswers`, `setupOfflineSync`)                                                                                                |
| `src/lib/format.ts`                                         | Helpers de formato de fechas/duraciones (es-CO)                                                                                                         |
| `src/utils/proctoring.ts`                                   | `MAX_WARNINGS=3`, `warningLabel`, `shouldMarkSuspicious`                                                                                                |
| `src/utils/grade.ts`                                        | `computeWeightedGrade(items)` — núcleo del cálculo de notas                                                                                             |
| `src/modules/ai/AiCronPage.tsx`                             | Página del módulo "Cron" con tabs IA (cola grading) + Generaciones (cola generación) + Supabase (pg_cron)                                               |
| `src/modules/ai/AiGenerationQueuePanel.tsx`                 | Panel de cola de generación IA (tab "Generaciones"); botón Zap para pending vs RefreshCw para failed                                                    |
| `supabase/functions/ai-generation-worker/`                  | Worker que drena `ai_generation_queue`; auto-retry transitorio (429/5xx/timeout) hasta `MAX_ATTEMPTS=3`                                                 |
| `src/modules/ai/AiGradingQueueWidget.tsx`                   | Card resumen de la cola IA (dashboard); link al módulo Cron                                                                                             |
| `src/modules/admin/SupabaseCronPanel.tsx`                   | Admin: pausar/reagendar/describir jobs de pg_cron                                                                                                       |
| `src/modules/code/CodeRunnerPicker.tsx`                     | Selector per-pregunta del runner de código (override del default)                                                                                       |
| `src/modules/code/JavaGuiRunner.tsx`                        | Editor + ejecución de preguntas `java_gui` (CheerpJ / AWS shot)                                                                                         |
| `src/modules/code/run-java.ts`                              | `runJavaInBrowser(src, signal?)` — Java client-side via CheerpJ                                                                                         |
| `aws/code-runner/app.py`                                    | Lambda handler — modo `run` y `gui_screenshot` (Xvfb + Pillow)                                                                                          |
| `aws/code-runner/GuiBootstrap.java`                         | Wrapper Java pre-compilado que evita pedir `Thread.sleep` al alumno                                                                                     |
| `src/modules/tenants/use-tenant.ts`                         | Hook `useTenant()` + `readTenantOverride()` / `setTenantOverride()` + evento `examlab:tenant-override-changed`                                          |
| `src/modules/tenants/TenantThemeProvider.tsx`               | Sobrescribe CSS vars OKLCH con los colores del tenant; light/dark via `washHex` / `darkVariant`                                                         |
| `src/modules/tenants/active-role-signal.ts`                 | Signal compartido `activeRole` (AppLayout publica, TenantThemeProvider suscribe)                                                                        |
| `src/modules/tenants/TenantOverrideBanner.tsx`              | Banner azul "Viendo como institución X" + botón "Salir del modo institución"                                                                            |
| `src/modules/superadmin/AssignUsersToTenantDialog.tsx`      | Dialog SuperAdmin: gestiona membresía de un tenant (agregar + quitar usuarios con diff)                                                                 |
| `src/routes/app.superadmin.tenants.tsx`                     | Panel SuperAdmin para tenants — CRUD, "Ver como", impersonar Admin                                                                                      |
| `src/hooks/use-theme.ts`                                    | Hook `useTheme()` con state sincronizado entre instancias vía `examlab:theme-changed` event                                                             |
| `src/shared/components/AppLayout.tsx`                       | Layout principal + role-switcher + `handleRoleChange` (limpia override al pasar a SuperAdmin)                                                           |
| `supabase/functions/broadcast-course-message/index.ts`      | Edge function: notif `kind='broadcast'` + correo por destinatario + replica como mensaje 1-a-1. Acepta `courseIds[]` (multi-curso)                      |
| `supabase/functions/bulk-import-users/index.ts`             | Edge function: CSV / single user create. Acepta Admin + SuperAdmin como callers; rol `SuperAdmin` solo asignable por SuperAdmin                         |
| `src/modules/messaging/TagTextarea.tsx`                     | Textarea reusable con autocomplete `#` para etiquetar contenido + preview. Usado en chat 1-a-1 y composer de difusión                                   |
| `src/modules/messaging/broadcast.ts`                        | Helpers puros de difusión (`normalizeCourseIds`, `dedupeRecipients`, `canonicalConvPair`, `buildBroadcastBody`, `humanizeTags`) — replicados en el edge |
| `src/modules/messaging/scheduled.ts`                        | Helpers de mensajes programados (`validateScheduledSend`, `localToIso`, `SCHEDULED_STATUS_LABEL`)                                                       |
| `supabase/migrations/20260709000000_scheduled_messages.sql` | Tabla `scheduled_messages` + `dispatch_scheduled_messages()` (SQL) + cron cada minuto                                                                   |
| `src/modules/auth/ForceChangePasswordDialog.tsx`            | Diálogo bloqueante de cambio de contraseña forzado (primer login). Montado en AppLayout cuando `profile.must_change_password`                           |

---

## Modelo de pesos / cortes (post-migración 20260507100000)

Cada item (examen, taller, proyecto) y la asistencia de un corte tienen un peso que es **% de la nota final del curso**, no relativo dentro de un bucket.

```
cut.weight              = % de la nota final que aporta el corte (cuts suman 100)
cut.workshop_weight     = bucket: cuánto del corte vale TODOS los talleres juntos
cut.exam_weight         = bucket: cuánto del corte vale TODOS los exámenes juntos
cut.project_weight      = bucket: cuánto del corte vale TODOS los proyectos juntos
cut.attendance_weight   = bucket: cuánto del corte vale la asistencia
exam.weight             = % de la nota final para ese examen (cap = exam_weight bucket)
workshop.weight         = % de la nota final para ese taller (cap = workshop_weight bucket)
project.weight          = % de la nota final para ese proyecto (cap = project_weight bucket)

REGLA: workshop_weight + exam_weight + project_weight + attendance_weight = cut.weight.
       Y items del mismo tipo no pueden exceder su bucket. La validación
       vive en el form de cortes del curso (admin/courses) y en los
       forms de cada item, que muestran "te queda X disponible" del bucket.
```

Migración 20260507130000 hizo backfill: para cada cut puso `workshop_weight = sum(workshops.weight asignados al corte)` etc, así que el comportamiento previo se preserva.

**Cálculo** (`computeWeightedGrade(items)`): weighted average. Items con `score=null` **cuentan como 0** con su peso original (NO se reescalan). Eso refleja la realidad del estudiante: lo que debe y todavía no entregó/no tiene nota es nota perdida hasta que aparezca. Solo retorna `null` (UI muestra "—") cuando NINGÚN item del set tiene score. Misma regla en `computeCutGrade` y `computeCourseFinalGrade`.

**Asistencia → corte**: `attendance_sessions` NO tiene `cut_id`. La pertenencia se deriva por fechas: una sesión cuenta para el corte X si `session_date` está entre `cut.start_date` y `cut.end_date`. El score de asistencia del corte es `presentes / sesionesEnCorte` escalado a la escala del curso, y entra al weighted avg con `weight = cut.attendance_weight`. Implementado idéntico en `app.student.grades.tsx` y `app.teacher.gradebook.tsx`.

**Forms de items**: input de Peso disabled cuando no hay corte; max = `cut.weight`.

---

## Módulo de examen estudiantil — decisiones de diseño

### Session lock (sin migración DB)

Usa `answers.__session_id` (dentro del JSONB existente) + `updated_at` como heartbeat implícito (autosave cada 1.5s). Ventana de expiración: 10s. No se necesitan columnas adicionales.

```ts
// localStorage key: examlab_exam_session_${examId}
function getOrCreateLocalSession(examId: string): string { ... }
```

### Proctoring — `recordWarning(type)`

Definida dentro del proctoring `useEffect` con deps `[started, performSubmit]`. Usa `blurLockUntil` (debounce 500ms) para evitar strikes rápidos. Hace fire-and-forget a Supabase + el autosave de 1.5s recoge lo que falle.

**IMPORTANTE:** Para el botón "Atrás" del navegador, el modal de confirmación hace `await supabase.update(...)` antes de `navigate()` — esto es crítico porque el componente se desmonta al navegar y el autosave timer se cancela.

### Esc bloqueado durante el examen

El listener `onKeyDown` global (capture phase) intercepta Escape con `preventDefault + stopPropagation`. Eso impide que cierre dialogs del SPA o cancele otros defaults del navegador. **NO evita que el navegador salga de fullscreen al pulsar Esc** — esa salida la maneja el SO/browser y JavaScript no puede interceptarla. Cuando ocurre, `fullscreenchange` dispara y `recordWarning("fullscreen_exit")` suma el strike.

### Navegación secuencial vs libre

- `exam.navigation_type === "secuencial"`: botón "Anterior" siempre deshabilitado; botón "Siguiente" abre modal de confirmación cada vez (warning sobre que no podrá regresar).
- `libre`: comportamiento normal, "Anterior" disabled solo en `currentIdx === 0`.
- Siempre se renderiza una sola pregunta a la vez (`const visible = [questions[currentIdx]].filter(Boolean)`).

### Timer

Solo `computeSecondsLeft(exam?.end_time)`. El hook `useRealtimeTimer` inicializa una sola vez cuando `initialSeconds > 0`. No intentar calcular tiempo efectivo por estudiante.

### Offline sync

`clearLocalAnswers(examId)` debe llamarse antes de crear una nueva fila de submission, para evitar el toast "X respuesta(s) sincronizada(s)" cuando el docente borra la sesión anterior.

### Suspensión / entrega — fire-and-forget

`performSubmit` await SOLO el `submissions.update` (la entrega real). La notificación al docente vía RPC y la calificación con IA (`ai-grade-submission` edge function, ~5-15s) se disparan con `void` sin await. El alumno ve "Examen suspendido/entregado" en ~300ms en vez de ~10s. El servidor termina las tareas en background aunque el cliente navegue a otra ruta.

---

## Features adicionales

### Actividades externas (`is_external` en exams, workshops y projects)

Para parciales/talleres/proyectos que ya pasaron fuera de la plataforma (presencial o virtual en otra herramienta) y solo se registran notas. Toggle en el dialog de creación esconde campos sin sentido (duración/navegación/proctoring/preguntas para examen, archivos esperados/instrucciones para proyecto). El editor de notas externas (`ExternalGradesEditor`) lista a los matriculados con columnas Nota + **Observación** (campo libre por estudiante), y guarda en `submissions.{final_override_grade, teacher_feedback}` / `workshop_submissions.{final_grade, teacher_feedback}` / `project_submissions.{final_grade, teacher_feedback}`. La columna `submissions.teacher_feedback` la agregó la migración 20260507130000.

### Detección de fraude (FraudPanel)

- **Análisis IA por entrega**: cada calificación con IA puebla `submissions.ai_detected_score / ai_detected_reasons` (0..1 + razones). Threshold 0.6 marca `ai_detected = true` y status `sospechoso`.
- **Plagio entre estudiantes**: edge function `detect-plagiarism` compara entregas pares vía Gemini, persiste en tabla `similarity_pairs (kind, ref_id, score, reasons)`. RLS solo docente/admin.
- `<FraudPanel kind refId>` reutilizable en monitor de examen, dialog de calificación de taller, dialog de entregas de proyecto.

### Selección de modelo de IA (tabla `ai_model_settings`)

Una sola configuración global activa a la vez (UNIQUE PARTIAL idx sobre `is_active=true`). Solo Admin escribe.

- Providers soportados: `lovable` (Gemini via gateway), `openai` (gpt-4o, gpt-4o-mini, etc), `gemini` (Google Gemini directo).
- **API keys NO se guardan en DB**. Viven como env vars en Lovable (`LOVABLE_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). La tabla solo elige `provider` + `model`. Si una key expira/se rota, va por Lovable → Edge Function Secrets — NO se agregan inputs de API key al panel admin. Existió un override `ai_model_settings.gemini_api_key` (legacy, migración 20260524110000); las edges lo leen como fallback pero la UI ya no permite editarlo. La columna quedará deprecada cuando se haga la migración drop column.
- Edge function lee la fila activa via `getActiveAiModel()` y construye URL/auth/header según provider en el helper `aiChatCompletion(body)`. Ambos providers hablan el mismo formato OpenAI chat-completions, así que el body (messages/tools/tool_choice) viaja idéntico — solo cambia `model`.
- UI Admin en `app.admin.ai-prompts.tsx` con tabs: **Prompts** (editor de los 5 use_cases globales) + **Modelo** (provider + model). El path se mantuvo por compatibilidad.

### Prompts de IA customizables (tabla `ai_prompts`)

Sistema de overrides de prompts para los modelos de IA, separado por **caso de uso** (no por módulo):

- 5 use cases: `workshop_full`, `workshop_question`, `project_file`, `project_full`, `exam_question`.
- Una fila por `(use_case, course_id)`. `course_id IS NULL` = prompt global del sistema (lo edita Admin). `course_id` no-null = override del curso (lo edita el docente del curso).
- El edge `ai-grade-submission` resuelve via `resolveSystemPrompt(useCase, courseId, fallback)`: course override gana al global, fallback al texto hardcodeado si la tabla está vacía.
- **Solo se persiste el system prompt** (rol/criterios). Los datos dinámicos (rúbrica, respuesta, idioma, puntaje máx.) se inyectan en el `user` message desde el código — el admin/docente no puede romper el contrato olvidando un placeholder.
- UI: `app/admin/ai-prompts.tsx` (CRUD globales, restaurar default), `app/teacher/ai-prompts.tsx` (selector de curso, ver global de referencia, override editable, "Volver al global" elimina la fila).
- RLS: SELECT abierto a authenticated; INSERT/UPDATE/DELETE de globales solo Admin; de overrides solo docente del curso (vía `course_teachers`) o Admin.

### Asistencia self check-in con QR rotativo (TOTP-like)

Los estudiantes se marcan presentes solos para que el docente no tenga que llamar uno a uno.

- **DB**: `attendance_sessions.check_in_open` (visible a todos) + tabla privada `attendance_check_in_state(session_id, seed, rotation_seconds, opened_at, closes_at)` con RLS Docente/Admin only — la **seed nunca llega al estudiante**.
- **Código**: derivación TOTP-like — `sha256(seed || ":" || period)[:7 hex] % 1000000` con `period = floor(epoch/rotation_seconds)`. La función SQL `compute_attendance_code(seed, period)` y el JS `computeAttendanceCode()` en [src/lib/attendance-code.ts](src/lib/attendance-code.ts) **deben coincidir bit-a-bit**.
- **Validación**: el estudiante llama `student_check_in_attendance(session_id, code)` SECURITY DEFINER, que acepta el código del período actual y el anterior (gracia de rotación). Verifica matrícula, ventana abierta, no expirada.
- **UI Docente** ([AttendanceCheckInProjector](src/components/AttendanceCheckInProjector.tsx)): overlay fullscreen vía Fullscreen API con QR + código + countdown + contador realtime de presentes (Supabase channel sobre `attendance_records` filtrado por `session_id`). Botón "Cerrar check-in" → opcional confirm "marcar pendientes como ausentes" → RPC `teacher_mark_pending_absent`.
- **UI Estudiante** ([AttendanceQRScanner](src/components/AttendanceQRScanner.tsx)): `html5-qrcode` (~50KB) escanea QR. Fallback input manual de 6 dígitos. Card "Check-in disponible" arriba de la vista de asistencia cuando hay sesiones con `check_in_open=true`.
- **Deep-link**: el QR codifica `https://<host>/app/student/attendance?session=X&code=Y`. Si el estudiante lo abre así (cámara nativa o desde la app), el effect en `app.student.attendance.tsx` parsea, llama RPC y limpia la URL con `history.replaceState`.
- **Parametrización**: cada inicio de check-in toma `duration_minutes` (default 10, rango 1-240) y `rotation_seconds` (default 60, rango 15-600) desde un dialog. No hay default global todavía — se agrega cuando se necesite.

### Proyectos: sustentación + link al repo obligatorio

La nota final del proyecto = `submission_grade × defense_factor`. Sin sustentación, `final_grade=null` (el estudiante ve "Falta sustentación").

- **DB** (migración 20260507170000): `project_submissions.submission_grade`, `defense_factor` (0..1, CHECK), `defense_notes`, `defense_at`, `repository_url`. Backfill: para entregas ya calificadas pone `submission_grade = final_grade` y `defense_factor = 1` para preservar el comportamiento previo.
- **Estudiante**: el `submit` exige un link `https?://...` (validación en cliente, columna NULLABLE en DB para no romper históricos). La IA califica → llena `submission_grade`, deja `final_grade=null`. UI explica que la nota final llega tras la sustentación.
- **Docente**: en el dialog de calificación se muestra el link prominente con borde ámbar y advertencia "verificar fechas vs entrega". Cada submission tiene un `<DefensePanel>` con: nota entrega + input factor 0–1 + preview de nota final + notas + botón "Guardar sustentación". Al guardar persiste `defense_factor`/`defense_notes`/`defense_at` y recalcula `final_grade = submission_grade × factor`.
- **Verificación de fechas vs commits**: el sistema solo persiste el link y la fecha de entrega — la comparación contra fechas de modificación del repo es manual del docente. La verificación automática vía API de GitHub/Drive queda como mejora futura (requiere OAuth y casos edge).

### Proyectos: entrega de código completo en ZIP (`type='codigo_zip'`)

Slot adicional en `project_files` para que el estudiante suba un ZIP con todo su código fuente. Diagramas y documentos siguen entregándose en preguntas separadas (tipo `abierta`/`diagrama`/etc).

- **DB** (migración 20260507160000): bucket `project-files` (100MB max), columna `project_submission_files.zip_path`, nuevo tipo `codigo_zip` permitido en `project_files.type`. RLS de Storage: estudiante sube/lee/borra los suyos; docente/admin lee todos.
- **UI Docente** ([ProjectFiles.tsx](src/components/ProjectFiles.tsx)): nuevo item "Código completo (ZIP)" en el selector de tipo del slot. La generación con IA NO ofrece este tipo — debe configurarse manualmente.
- **UI Estudiante**: input `<input type="file" accept=".zip">` cuando el slot es `codigo_zip`. Al enviar, sube a `project-files/<user_id>/<submission_id>/<file_id>.zip` y persiste `zip_path` en `project_submission_files`.
- **Edge function** (`ai-grade-submission`, modo `projectCodeZipGrading`): descarga el ZIP via `adminClient.storage.from('project-files').download()`, descomprime con `fflate`, **filtra por whitelist de extensiones de código** (.java, .py, .js/.ts/.tsx, .c/.cpp, .cs, .go, .rs, etc + makefile/dockerfile), trunca archivos >50KB, tope global 200K chars, concatena con encabezado `─── path ───` y manda al modelo. Usa el system prompt `project_full`.
- **Caso vacío**: si el ZIP no contiene archivos de código reconocidos, retorna grade=0 con feedback claro al estudiante.

### Trabajo en grupo en talleres y proyectos (V1: teacher_assigned, modo MIXTO)

Para que un grupo de N estudiantes comparta UNA misma entrega y reciba la misma nota. Replicado idéntico en talleres y proyectos.

- **DB** (migraciones 20260507150000 talleres y 20260507180000 proyectos): `workshops.group_mode` / `projects.group_mode` (`individual` | `teacher_assigned` | `self_signup` — V1 expone solo individual y teacher_assigned). Tablas `{workshop|project}_groups(id, {workshop|project}_id, name, signup_code)` + `{workshop|project}_group_members(group_id, user_id)` con trigger que evita estar en >1 grupo del mismo taller/proyecto. Columna `{workshop|project}_submissions.group_id` (cuando hay grupo, la submission pertenece al grupo).
- **RLS**: groups y members con SELECT abierto + write Docente/Admin. `*_submissions` extendido a "dueño O miembro del grupo de la submission O Docente/Admin" en SELECT/INSERT/UPDATE — eso permite que cualquier miembro del grupo edite la misma fila.
- **Modo MIXTO**: en un mismo taller/proyecto con `group_mode != 'individual'` pueden coexistir estudiantes con grupo (entregan en grupo, comparten una sola entrega y nota) y sin grupo (entregan individual). El estudiante sin grupo NO se bloquea — entrega normalmente. La UI no muestra warnings de "espera a tu grupo".
- **UI Docente**: toggle "Trabajo en grupo" en el form (solo cuando NO es externo). Botón "Grupos"/"Activar grupos" en el grid (icono UsersRound) — siempre visible para items no-externos. Click sin grupos activos auto-activa `teacher_assigned`. Abre [WorkshopGroupsEditor](src/components/WorkshopGroupsEditor.tsx) o [ProjectGroupsEditor](src/components/ProjectGroupsEditor.tsx) con **drag & drop nativo** (HTML5 drag API, sin librería) — arrastrar tarjeta de estudiante entre "Sin grupo" y los grupos creados; ring visual en drop target.
- **UI Estudiante**: en `app.student.workshops.tsx` y `app.student.projects.tsx` la query de submission filtra por `group_id` cuando aplica (cualquier miembro ve la misma entrega), y por `user_id` cuando no (modo individual o mixto sin grupo). Card "Tu grupo: X" arriba solo si `myGroup != null`.
- **Submission compartida**: `StudentWorkshopTaker` y `StudentProjectTaker` aceptan prop `groupId`. La query existente y el INSERT incluyen `group_id` cuando hay grupo. `user_id` se mantiene como "último editor".
- **Notificación de calificación**: `saveGrade` lee `submission.group_id`; si existe, inserta una notificación por cada miembro del grupo. Caso individual: solo al `user_id`.
- **Self-signup**: queda para V2. La columna `signup_code` ya está en la tabla para no migrar después.

### Multi-tenant: SuperAdmin vs Admin

La plataforma soporta varias instituciones (tenants) sobre la misma DB. Cada profile tiene `tenant_id`; el aislamiento de datos lo garantiza la RLS (cada tabla con `tenant_id` filtra por `current_tenant_id()` o joinea a `courses.tenant_id` cuando no tiene columna propia).

- **Rol `SuperAdmin`**: dueño de la plataforma. Opera cross-tenant. Visible solo en su instancia de la app (RLS `is_super_admin()` bypassa todas las policies; el front filtra el menú "Instituciones" para que solo aparezca en este rol).
- **Rol `Admin`**: dueño de una institución. Hace soporte/operación dentro de SU tenant.
- **Override "Ver como esta institución"**: el SuperAdmin elige un tenant desde `/app/superadmin/tenants` → se guarda el slug en `localStorage["examlab_tenant_override"]`. A partir de ahí `useTenant()` resuelve a ESE tenant (no al del profile), y la UI (banner azul `TenantOverrideBanner`, branding completo, label del sidebar) actúa como si el SuperAdmin "viviera" dentro de ese tenant. **Limpieza automática**: cuando el usuario cambia su `activeRole` a `SuperAdmin` vía el role-switcher, `AppLayout.handleRoleChange` llama `setTenantOverride(null)` — sin esto, el SuperAdmin volvía al modo cross-tenant con el branding del último tenant visto.
- **`isSuperAdminCrossTenant`**: helper sintético `activeRole === "SuperAdmin" && !hasTenantOverride`. Cuando es true: oculta logo + nombre del tenant en el sidebar (desktop + mobile + drawer), reemplaza el label sub-ExamLab por "Plataforma de Gestión Educativa" (key `tenant.platformBrand`), oculta `TenantQuotaCard`, y `TenantThemeProvider` limpia todas las CSS vars vía `clearTenantVars(root)`.
- **Filtros cross-tenant en módulos compartidos**: cuando el SuperAdmin entra a una pantalla que originalmente era admin (Usuarios, Cursos, Certificados, Auditoría, Cron, Estadísticas), aparece un `Select` extra con "Todas las instituciones / Por institución". El filtro modifica la query principal: usa `.eq('tenant_id', X)` cuando la tabla tiene la columna, o el patrón "2-step" cuando no (ej. certificates → primero `courses.id` del tenant, después `.in('course_id', ids)`). Si el tenant elegido no tiene rows, **cortar el query a corto antes** de pegarle a la tabla principal — un `.in('course_id', [])` en PostgREST devuelve TODOS los rows, no ninguno.
- **Crear / quitar usuarios de un tenant**: `/app/superadmin/tenants` → menú de tenant → "Gestionar usuarios". El dialog ([AssignUsersToTenantDialog](src/modules/superadmin/AssignUsersToTenantDialog.tsx)) muestra TODOS los profiles con un checkbox precargado al estado actual (miembros del tenant tildados). El diff calculado al guardar aplica UPDATE `profiles.tenant_id = tenant.id` para nuevos miembros y `tenant_id = NULL` para los que se desmarcan. Si hay quitados, `useConfirm({ tone: "destructive" })` pide confirmación con conteo. El trigger `tg_check_profile_tenant_change` rechaza individualmente si un user tiene cursos activos en su tenant viejo (la edge muestra el error friendly y sigue con los demás del batch).
- **Crear SuperAdmins desde el UI**: el rol SuperAdmin se puede otorgar (a un usuario nuevo o existente) desde `/app/admin/users` → "Nuevo usuario" / editar. El checkbox `SuperAdmin` solo se renderiza si el caller también es SuperAdmin (filtrado en el `ALL_ROLES.filter()` del front). La edge `bulk-import-users` valida server-side: callers permitidos = Admin **o** SuperAdmin; el rol `SuperAdmin` en el payload solo se persiste si `callerIsSuperAdmin` — un Admin común que mande `SuperAdmin` en un CSV/payload lo verá silenciosamente ignorado.
- **Impersonación tinted**: las acciones "Iniciar sesión como Admin" (`/app/superadmin/tenants`) y "Iniciar como" (`/app/admin/users`) usan la prop `iconColor` de `RowActionsMenu` para que el ícono adopte el primary del tenant correspondiente (literal por fila en el primer caso, `var(--brand-primary)` del theme en el segundo). Es pista visual: la acción te lleva al contexto de esa marca.

### Branding por tenant ([TenantThemeProvider](src/modules/tenants/TenantThemeProvider.tsx))

Sobrescribe los tokens OKLCH del theme (`--primary`, `--sidebar`, `--background`, `--card`, `--muted`, `--brand-primary`, etc.) con los colores del tenant activo en runtime — todos los componentes shadcn (Button primary, focus rings, Badge accent, sidebar nav, fondos de Card) heredan automáticamente.

- **`--primary` / `--sidebar`**: se setean al hex del tenant (`tenant.primary_color`). El foreground (texto sobre fondo branded) sale por luminancia sRGB del hex (umbral 0.55) o, si el tenant tiene `text_color` override, gana ese. `tenant.icon_color` controla `--sidebar-icon-color`, leído por los íconos del nav vía inline `style={{ color: "var(--sidebar-icon-color, currentColor)" }}`.
- **Fondos del área principal** dependen del theme actual (`useTheme().resolvedTheme`):
  - **Light mode**: `washHex(secondary)` mezcla 92% con blanco → fondo casi blanco con tinte sutil de marca.
  - **Dark mode**: `darkVariant(secondary, 8|12|15)` preserva hue + cap de saturación a 70% y baja lightness — secundario rojo → fondo rojo oscuro, azul → azul oscuro. Achromáticos (sat<5%) caen a neutro dark.
- **`clearTenantVars(root)`**: limpia TODAS las vars que el provider haya seteado. Llamado en el early-return cuando `activeRole === "SuperAdmin" && !readTenantOverride()` — modo cross-tenant pidiendo theme default OKLCH.
- **Reactividad al toggle de tema**: el effect tiene `resolvedTheme` en sus deps. Antes leía `classList.contains("dark")` una sola vez por run y dark-mode no propagaba sin recarga.

### Tema claro / oscuro ([use-theme.ts](src/hooks/use-theme.ts))

- **Default = `light`** (ex-`"system"`). Migración silenciosa: `readStoredTheme()` mapea cualquier valor distinto de `"light"`/`"dark"` (incluyendo `"system"` legacy y basura) a `"light"`. La opción "Sistema" del menú se removió — el usuario elige claro u oscuro explícitamente.
- **Estado compartido entre instancias**: cada `useTheme()` tenía state local. Cuando `ThemeToggle` cambiaba el tema, `TenantThemeProvider`'s hook NO se enteraba y dejaba aplicadas las CSS vars del tema viejo (síntoma: bordes cambiaban pero backgrounds quedaban iguales). Fix: `setTheme()` dispara un `CustomEvent("examlab:theme-changed", { detail: theme })`; todas las instancias se suscriben (more `storage` event para cross-tab) y sincronizan su state. Mismo patrón que el override del tenant.
- **Hidratación SSR (React #418)**: `useTheme()` inicializa el state DETERMINISTA a `"light"` — NO lee `localStorage` en el initializer. El HTML pre-renderizado no tiene `localStorage`, así que sale en "light"; si el primer render del cliente leyera "dark" de storage, el árbol React diferiría del pre-renderizado → hydration mismatch, visible en componentes theme-dependientes (`ThemeToggle`: ícono Sol vs Luna). El valor real se aplica **post-mount** (`sync()` en el effect). Para que el FONDO no parpadee claro→oscuro mientras tanto, un `<script>` inline al inicio del `<body>` en `__root.tsx` aplica la clase `.dark` desde `localStorage` ANTES del paint. El árbol React (íconos) puede parpadear un frame; el fondo no.

### Dashboards — patrón uniforme (4 stats + 2 cards)

Los 4 dashboards (`SuperAdmin`, `Admin`, `Teacher`, `Student`) en [app.index.tsx](src/routes/app.index.tsx) comparten estructura:

```tsx
<div className="flex flex-col gap-4 flex-1 min-h-0">
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{/* 4 <Stat /> */}</div>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-h-0">
    {/* 2 cards que llenan el alto restante */}
  </div>
</div>
```

- 4 stat cards arriba (`<Stat icon label value sub? color onClick? />`) en grid 2-col mobile / 4-col desktop. El componente es shared.
- 2 cards abajo en `grid-cols-1 sm:grid-cols-2`. `flex-1 + min-h-0` hace que crezcan hasta el final del viewport disponible. Cada card es `flex-col min-h-0`, con `flex-1 overflow-y-auto` en su lista interna para mantener el botón "Ver todos" anclado abajo.
- **Contenido por rol:**
  - **SuperAdmin**: Instituciones · Usuarios · Cursos · Cola IA | Instituciones recientes + Actividad reciente (audit_logs cross-tenant).
  - **Admin**: Cursos · Usuarios · Pendientes calificar · Pendientes docente | Cursos recientes + Actividad reciente (audit_logs del tenant).
  - **Teacher**: Notas pendientes · Cola IA · Pendientes mi respuesta · Sesiones hoy | Próximas clases + Próximos exámenes.
  - **Student**: Exámenes pendientes · Talleres pendientes · Proyectos pendientes · Conversaciones pendientes | Próximas clases + Próximos exámenes.
- **Regla**: no agregar cards anchos de 2 columnas ni filas secundarias de stats — el patrón es **rígido 4+2**. Los cards de información operativa (Cola IA detalle, Correos 24h) se accederon desde sus módulos dedicados del sidebar; el dashboard prioriza lo accionable.
- **Saludo del header**: muestra `profile.full_name` completo (no `.split(" ")[0]`).
- **Patrón `let cancelled = false` obligatorio** en el effect que carga datos del dashboard — el usuario navega rápido entre roles/secciones y sin guard el setState dispara warnings + toasts huérfanos en pantallas distintas.

### Broadcast docente → mensajes en /app/messages

`/app/messages` tiene un botón "Difundir a curso" (rol Docente/Admin) que llama la edge function `broadcast-course-message`.

**Multi-curso**: el dialog permite seleccionar **varios cursos** a la vez (lista de checkboxes + "Seleccionar todos"). El body manda `courseIds: string[]` (la edge sigue aceptando `courseId` legacy vía `normalizeCourseIds`). Un alumno matriculado en >1 curso seleccionado recibe **UNA sola** notif/correo/mensaje — la edge dedup por `user_id`. Autorización: Admin bypassa; Docente debe dictar **TODOS** los cursos seleccionados (uno no autorizado → 403, sin difusión parcial). Helpers puros en [src/modules/messaging/broadcast.ts](src/modules/messaging/broadcast.ts) (`normalizeCourseIds`, `dedupeRecipients`, `canonicalConvPair`, `buildBroadcastBody`) están testeados y **replicados** dentro del edge (Deno no importa de `src/` — si cambian, sincronizar ambos lados).

Efectos del broadcast:

1. **Notificación in-app por estudiante** (`kind='broadcast'`, título `📢 ...`). El predicado `_notification_kind_emails` excluye `broadcast`, así que NO dispara emails individuales.
2. **UN solo correo SMTP** con TODOS los estudiantes en BCC (privacidad — ningún alumno ve la lista del resto).
3. **Replicación al inbox de mensajes**: para cada alumno se asegura una conversación 1-a-1 con el sender (UPSERT con orden canónico `user_a < user_b`, `onConflict: "user_a,user_b", ignoreDuplicates: true` — preserva `cleared_at` / `last_read_at` existentes) y se inserta UN mensaje con body `"📢 subject\n\nmessage"` en cada una.

**Saltar el trigger `tg_notify_new_message`** es crítico para que la replicación no genere notif + email extras por mensaje insertado:

- Migración 20260707000000 agrega un check de GUC al trigger: `current_setting('app.skip_message_notif', true) = 'true'` → RETURN NEW sin crear notification.
- Nueva RPC `insert_broadcast_messages(_sender_id, _conv_ids[], _body)` SECURITY DEFINER hace `PERFORM set_config('app.skip_message_notif', 'true', true)` (transaction-local) y bulk-inserta los mensajes. Trunca body a 4000 chars (CHECK de `messages.body`). Valida `auth.uid() = _sender_id`.
- La edge llama la RPC con `userClient.rpc(...)` (no `admin`) para que `auth.uid()` coincida con el caller. Si falla la replicación, se audita `broadcast.messages_replication_failed` (severity warning) y se sigue — las notifs in-app y el BCC ya están aplicados.

**Resultado neto por broadcast**: 1 notif (`📢 …`) por alumno + 1 correo por destinatario + N mensajes en las conversaciones 1-a-1. Sin duplicación.

### Etiquetar contenido en mensajes (`#`)

En el chat 1-a-1 y en el composer de difusión el usuario puede etiquetar talleres/exámenes/proyectos escribiendo `#`. El componente reusable [TagTextarea](src/modules/messaging/TagTextarea.tsx) maneja el autocomplete inline (dropdown estilo Slack, navegable con flechas + Enter), inserta el token `[[T:type:id:label]]` en el body, y muestra un preview con el **nombre humano** debajo (el textarea no puede renderizar chips). El picker por tabs (`MessageTagPicker`, botón `#`) sigue como alternativa.

- **Detección del trigger**: `findActiveTagQuery(text, caret)` en [message-tags.ts](src/modules/messaging/message-tags.ts) — el `#` debe estar al inicio o tras espacio; un espacio cierra la mención (así "Taller #1" no se rompe). Testeado.
- **Render del chip**: en el bubble, `parseMessageBody` → `<Link to={tagRoute(tag, role)}>` con ícono + label. Redirige al listado del módulo según rol.
- **Difusión**: el body con tokens se replica como chips en /app/messages, pero en la notif/correo (que no renderizan chips) se **humaniza** a `#label` vía `humanizeTags` (replicado en SQL `dispatch_scheduled_messages` + en el edge de broadcast).

### Mensajes programados (Docente/Admin)

Permite programar el envío de un mensaje a futuro, en modo `direct` (1-a-1) o `broadcast` (a cursos). Tabla `scheduled_messages` + función SQL `dispatch_scheduled_messages()` que un **pg_cron cada minuto** ejecuta (migración 20260709000000).

- **Dispatch 100% en SQL** (sin edge): para `direct` inserta el mensaje en la conversación (el trigger `tg_notify_new_message` notifica + emaila); para `broadcast` replica la lógica del edge en PL/pgSQL — notif `kind='broadcast'` humanizada por alumno único + mensaje replicado con tokens crudos (chips) usando el GUC `app.skip_message_notif`.
- **Autorización RE-VALIDADA en dispatch** (no confía en lo agendado): `direct` → `can_message(creator, recipient)`; `broadcast` → Admin o el creator dicta TODOS los `course_ids`. Una fila no autorizada se marca `failed` con el motivo (no aborta el batch — loop con `BEGIN/EXCEPTION` por fila + `FOR UPDATE SKIP LOCKED`).
- **UI**: en el dialog de difusión un `DateTimePicker` opcional ("Programar envío") cambia el botón a "Programar"; en el composer del chat un botón reloj abre una fila para programar el directo. El botón "Programados" del header abre el dialog de gestión (lista + cancelar). Validación client-side: `validateScheduledSend` exige ≥1 min en el futuro.
- **RLS**: el creador gestiona los suyos (SELECT/INSERT/UPDATE/DELETE con `creator_id = auth.uid()`); INSERT exige rol Docente/Admin/SuperAdmin. SuperAdmin ve todos.

### Cambio de contraseña forzado en el primer login

Los usuarios los crea el Admin/SuperAdmin con contraseña temporal. En su primer inicio deben cambiarla antes de usar la app.

- **DB** (mig 20260710000000): `profiles.must_change_password BOOLEAN DEFAULT false`. Lo pone `true`: la edge `bulk-import-users` al CREAR un usuario nuevo, y `admin-update-password` cuando un Admin resetea la contraseña de OTRO (no la propia). Lo baja a `false` el propio usuario al cambiarla.
- **UI**: [ForceChangePasswordDialog](src/modules/auth/ForceChangePasswordDialog.tsx) montado en `AppLayout` cuando `user && profile?.must_change_password`. Es BLOQUEANTE: sin X, sin Cancelar, `onEscapeKeyDown`/`onPointerDownOutside`/`onInteractOutside` con `preventDefault`. Única salida alternativa: "Cerrar sesión". Al guardar hace `auth.updateUser({password})` → `profiles.update({must_change_password:false})` → `refreshRoles()` (re-carga el perfil → el diálogo se desmonta).
- **`useAuth` Profile** incluye `must_change_password?: boolean` (el `select("*")` ya lo trae; opcional en el type por compat con entornos sin la migración).
- **No es control de seguridad** (un cliente podría flipear el flag por API) — es un nudge de UX. La sesión ya es válida; lo que forzamos es el cambio de la contraseña temporal.

### Notificaciones realtime + push

`use-notifications.ts` hace polling cada 15s + Supabase realtime + refetch al volver al tab. Toast aparece en first-load detection. Set de IDs a nivel de módulo deduplica entre múltiples instancias del hook (sidebar bell + mobile header bell + dashboard). Si tab oculto, push via Service Worker.

### Módulo Cron (Admin / Docente)

Rutas: `/app/admin/ai-cron` (Admin, 2 tabs) y `/app/teacher/ai-cron` (Docente, solo cola IA). Etiqueta en sidebar: **"Cron"**. El `module_key` interno se mantiene como `ai_cron` por compat — renombrar implicaría migrar `module_visibility` + bookmarks.

**Tab "IA"** (`AiCronPage.tsx` → `AiQueuePanel` interno):

- Stats: pendientes / en proceso / fallados 24h / último éxito.
- Filtro por estado (activos / pending / processing / failed / done / cancelled / todos).
- Tabla de hasta 100 jobs. Por fila: panel expandible inline con id, target_table, target_row_id, intentos, error completo, fechas. Acciones: `Reintentar` (failed → pending vía `requeue_ai_grading_job`), `Procesar este job ahora` (bypass cron, invoca `ai-grading-worker` con `{ jobId }`), `Cancelar` (`cancel_ai_grading_job`).
- Admin extra: botón global "Procesar ahora" que invoca el worker sin jobId (drena toda la cola pending).
- Realtime: canal `ai_grading_queue_page` con debounce 800ms para evitar refresh-storm cuando el worker drena varios jobs a la vez.
- **Resolución de títulos**: 3 pasos de lookups (submissions + project*submission_files → profiles + exams + projects). NO usar embeds PostgREST `profile:profiles!fk*...`—`submissions.user_id`apunta a`auth.users`, NO a `profiles`, y el embed falla silencioso dejando "Examen / Examen".
- **Navegación**: TanStack file-routing necesita `navigate({ to: "/app/teacher/monitor/$examId", params: { examId } })`. URLs hand-built tipo `/app/teacher/monitor/abc-123` con `as any` **fallan silenciosas** — fue el bug original "ver detalle no abre". Plus, Admin no tiene RBAC a `/app/teacher/*` → para Admin devolvemos `null` y el detalle vive en el panel expandible.

**Tab "Supabase"** (`SupabaseCronPanel.tsx`, Admin-only):

- Lista `extensions.cron.job` vía RPC `admin_list_cron_jobs()` (que hace LEFT JOIN con `cron_job_descriptions`).
- Por job: nombre + schedule (con traducción a lenguaje natural — `describeSchedule()` cubre patrones comunes), descripción humana, último run con su status, Switch active/pausado, ícono `FileText` para editar descripción, ícono `Pencil` para editar schedule.
- Descripción en tabla `public.cron_job_descriptions(jobname PK, description, updated_at, updated_by)`. Seed inicial cubre los 11 jobs canónicos (migración 20260603104200). RPCs Admin-only: `admin_set_cron_job_description`, `admin_set_cron_job_active`, `admin_update_cron_job_schedule` — todas con `has_role(auth.uid(),'Admin')` + audit log.
- **No** se permite editar el `command` (SQL) ni crear/borrar desde UI — eso queda en migraciones versionadas. Alcance: pausar / reagendar / describir.
- **Inmediatez**: `cron.alter_job` es un UPDATE síncrono. Los cambios aplican al instante en la tabla; el scheduler de pg_cron los respeta en su próximo tick (~1 min). Los toasts y el banner del card lo aclaran. Tras toggle hacemos `await load()` para re-verificar contra DB.

### Cola de Generación IA (`ai_generation_queue`)

Análoga a la cola de calificación (`ai_grading_queue`) pero para **generación**: cuando el docente pide generar preguntas de taller/examen, archivos de proyecto o contenido didáctico con IA, y la mode global (`ai_model_settings.processing_mode`) es `async`, el job se **encola** en lugar de ejecutarse inline. El docente puede esperar a tener un código de "IA inmediata" o un Admin lo procesa más tarde sin bloquear el UI.

- **Tabla** ([supabase/migrations/20260603070000_ai_generation_queue.sql](supabase/migrations/20260603070000_ai_generation_queue.sql)): `ai_generation_queue(id, kind, invoke_target, body jsonb, source_table, source_id, course_id, created_by, status, attempts, inserted_count, last_error, started_at, completed_at, created_at)`. `kind ∈ {workshop_questions, exam_questions, project_files, content_generation}`. `invoke_target` = nombre del edge a llamar (ej. `ai-generate-questions`, `generate-contents`). RLS: SELECT/INSERT/UPDATE/DELETE solo `created_by = auth.uid()` o Admin/SuperAdmin.
- **Caso especial `content_generation`**: la fila destino (`generated_contents`) NO existe al encolar — el body lleva el form completo. El worker crea la fila + invoca `generate-contents`. `source_id` arranca en `NIL_UUID` (`00000000-...`) y se actualiza con el id real cuando el worker crea la fila, para que el panel pueda joinear.
- **Worker** ([supabase/functions/ai-generation-worker/index.ts](supabase/functions/ai-generation-worker/index.ts)): `verify_jwt=false` + auth interna. Body `{ jobId?: string }` — sin id es **drain mode** (FIFO, hasta 10 jobs). Claim optimista (`UPDATE ... WHERE status='pending'`) evita doble-procesamiento entre invocaciones concurrentes (cron + UI manual). En drain mode lee `ai_model_settings.processing_mode` y **se autoexcluye si es async** — preserva la semántica "encolé porque quería esperar código". Si llega un `jobId` específico, asume que el caller (UI con código IA activo, o Admin) sabe lo que hace y procesa igual.
- **Auto-retry transitorio**: `isTransientError(msg)` detecta `429 / 5xx / rate.limit / timeout / ECONN* / fetch.failed / quota.exceeded / service.unavailable / gateway.timeout / internal.server.error`. Si el error matchea y `attempts < MAX_ATTEMPTS (3)`, el worker re-encola el job a `pending` (limpia `started_at`, escribe `last_error="Reintento automático tras error transitorio (intento N/3): ..."`). El próximo tick del cron lo intenta otra vez. Errores NO transitorios (400, 401, content malformado) van a `failed` final sin reintentar — el docente decide manualmente. El patrón regex es **paralelo al del worker de grading** (`complete_ai_grading` SQL, mig 20260601001000) — si se actualiza uno, sincronizar el otro.
- **Cron** ([supabase/migrations/20260603080000_ai_generation_worker_cron.sql](supabase/migrations/20260603080000_ai_generation_worker_cron.sql)): `ai-generation-worker-hourly` en `15 * * * *` (offset vs grading en `:05` para no chocar). Drain con body `{}`. Descripción seedeada en `cron_job_descriptions` para que aparezca en el panel SuperAdmin → Supabase Cron.
- **Panel** (`AiGenerationQueuePanel.tsx`, montado como 3er tab de `/app/admin/ai-cron` y `/app/teacher/ai-cron` con ícono `Wand2`): lista jobs con filtro activos/all, expand inline (kind, target, source, body completo, error). Acciones:
  - Pending → botón ícono `Zap` ("Procesar ahora"): invoca `ai-generation-worker` con `{ jobId }`.
  - Failed → botón ícono `RefreshCw` ("Reintentar"): re-pone a `pending` y dispara el worker. Distinguir los íconos importa porque la intención semántica es distinta — el usuario debe saber si está forzando un job que ya estaba a la cola, o pidiendo un reintento de algo que ya falló.
  - Admin: botón global "Procesar todos" sin `jobId` (drain).
- **Distinción `processing_mode` global**: la mode `sync` vs `async` la setea Admin en `app.admin.ai-prompts.tsx` (tab "Modelo"). `sync` = la generación se ejecuta inline en el form (sin pedir código, sin encolar) y el cron del worker drena la cola que estuviera encolada. `async` = el form pide un código de "IA inmediata" o encola; el cron NO drena. Esto deja a los Admins decidir cuándo permitir generación libre vs cuándo controlar el gasto.
- **Vista unificada "Jobs" en `/app/{admin,teacher}/ai-cron`** (refactor 2026-06): antes existían 3 tabs separadas para el Docente (Activos/Historial/Generaciones) y 5 para el Admin (IA/Historial/Generaciones/Configuración/Supabase). El docente quería ver TODO lo que la IA hizo o tiene pendiente sin saltar entre tabs. La tab "Generaciones" se eliminó: su panel (`AiGenerationQueuePanel`) ahora se renderiza DEBAJO de `AiQueuePanel` dentro de la tab "Jobs" (antes "IA"/"Activos"), separados por un divisor + header "Generaciones". Cada panel mantiene su propia card + filtros — solo se renderizan juntos. El módulo conserva el `module_key` interno `ai_cron` por compat con `module_visibility` + bookmarks.
- **Edge `generate-contents` con `verify_jwt=false`** (supabase/config.toml): la edge la invoca tanto el `ai-generation-worker` (Bearer service*role_key, drain del job kind=content_generation) como la UI del docente (Bearer user JWT en flujo sync). Cuando el service_role del proyecto es del sistema nuevo (`sb_secret*\*`, no JWT parseable), el gateway con verify_jwt=true responde `401 UNAUTHORIZED_INVALID_JWT_FORMAT`antes de llegar al handler — error reportado: "generate-contents HTTP 401: Invalid JWT" desde Cola IA → Generaciones. Apagamos verify_jwt; la autorización fina se enforza via`body.id`+`adminClient`con RLS al leer/escribir`generated_contents`(mismo patrón que`ai-grading-worker`/`ai-grade-submission`).
- **Edge `ai-generate-questions` con `verify_jwt=false`** (supabase/config.toml + handler): mismo problema y solución que `generate-contents`. La edge la invoca el frontend (Bearer user JWT, flujo sync del docente) y `ai-generation-worker` (Bearer service_role_key, drain de jobs `kind ∈ {workshop_questions, exam_questions, project_files}` que apuntan a `invoke_target = "ai-generate-questions"`). Con verify_jwt=true el service_role `sb_secret_*` se rebota con 401 antes del handler — error reportado en Cola IA: "HTTP 401: UNAUTHORIZED_INVALID_JWT_FORMAT" en jobs de "Preguntas de taller" desde el worker. El handler valida internamente al inicio del `Deno.serve`: `bearer === SUPABASE_SERVICE_ROLE_KEY` → pass (worker), o user JWT válido vía `userClientFromRequest` → pass (UI). Sin esa validación, agregar verify_jwt=false dejaría la edge abierta a cualquiera con la URL (gastaría créditos IA + podría inyectar preguntas via service_role bypass de RLS).

### Módulo Soporte (PQRS Admin de tenant → SuperAdmin)

Canal de peticiones, quejas, reclamos y sugerencias del Admin de un tenant hacia el dueño de plataforma. Reemplaza el "email al SuperAdmin" como mecanismo informal.

- **DB** ([20260904000000_support_tickets.sql](supabase/migrations/20260904000000_support_tickets.sql)): tres tablas — `support_tickets` (cabecera + status + assignment + resolution_notes + soft-delete), `support_ticket_messages` (chat), `support_ticket_attachments` (archivos en bucket `support-attachments`). Categorías: `peticion`, `queja`, `reclamo`, `sugerencia`, `otro`. Status: `open` → `in_progress` → `waiting_admin` → `resolved` / `closed`. Trigger `_support_tickets_touch_updated_at` setea `resolved_at` automáticamente al pasar a resolved/closed.
- **RLS**:
  - SELECT: `created_by = auth.uid()` (admin del propio ticket) O `is_super_admin()`.
  - INSERT: solo Admin del tenant. WITH CHECK valida `tenant_id = (select tenant_id from profiles where id = auth.uid())` para que el admin no pueda abrir tickets a nombre de otro tenant.
  - UPDATE: SA puede todo; Admin solo puede modificar su ticket (típicamente status='closed' o priority). NO puede tocar `resolution_notes` ni `assigned_to`.
  - DELETE: solo SA (hard-delete; el soft-delete pasa por el column `deleted_at` que NO se expone al Admin via UPDATE).
- **Notificaciones (triggers SQL)**:
  - INSERT en tickets → notif `🎫 Nuevo ticket de soporte` a TODOS los SuperAdmins (`source_role='Admin'`), link `/app/superadmin/support?ticket=<id>`.
  - UPDATE de status → notif al `created_by` con label humano del status (`🎫 Ticket actualizado`).
  - INSERT en messages → si sender es SA, notif al `created_by`; si es Admin, notif al `assigned_to` o a TODOS los SA si no hay asignado.
- **Storage bucket `support-attachments`** (privado): RLS valida que el caller sea creator del ticket O SA. Path convention: `<ticket_id>/<random-uuid>.<ext>` — el ticket_id se extrae con `split_part(name, '/', 1)` en la policy para joinear con `support_tickets`. Las descargas usan `createSignedUrl(path, 60)` (60s de vigencia).
- **UI**:
  - [src/modules/support/SupportTicketDetailDialog.tsx](src/modules/support/SupportTicketDetailDialog.tsx): dialog COMPARTIDO entre Admin y SA con prop `mode`. Tiene chat realtime (suscripción a INSERT en `support_ticket_messages` filtrado por ticket_id), composer con Ctrl+Enter para enviar, adjuntar archivos (max 25 MB), download via signed URL.
  - [src/routes/app.admin.support.tsx](src/routes/app.admin.support.tsx): lista de SUS tickets + botón "Nuevo ticket" + stats 4-card.
  - [src/routes/app.superadmin.support.tsx](src/routes/app.superadmin.support.tsx): bandeja cross-tenant con filtros por estado/tenant/búsqueda. Default filter `active` (open + in_progress + waiting_admin).
- **Auto-asignación**: cuando el SA responde por primera vez a un ticket `open`, el dialog lo mueve automáticamente a `in_progress` y setea `assigned_to = currentUserId`. Si el SA mueve a resolved/closed sin assignment, también se auto-asigna.
- **Módulo en panel**: `{ key: "support", label: "Soporte" }` con roleKeyMap implícito (no virtual — directo). Solo aplica a Admin y SuperAdmin; Docente/Estudiante toggles quedan no-op. NAV item con icono `LifeBuoy`, label `nav.support` ("Soporte" / "Support").
- **Onboarding tour**: ADMIN_TOUR tiene step Soporte después de Papelera y antes de Configuración. SuperAdmin no tiene tour (decisión de producto).

### Restricción de mensajería al SuperAdmin

`can_message(_a, _b)` actualizado (mig [20260903000000](supabase/migrations/20260903000000_can_message_block_to_superadmin.sql)) para bloquear que Docente/Estudiante inicien chat con un SuperAdmin. Si CUALQUIERA de los dos lados es SA (sin importar otros roles que tenga), el otro DEBE ser Admin o SA. Esto se aplica simétrico — `open_conversation` y RLS de `messages.INSERT` consumen la misma función, así que el bloqueo es consistente UI + DB.

Caso operativo: el SuperAdmin recibe mensajes solo de Admins de tenants (cuestiones cross-tenant). El canal "Admin del tenant → SuperAdmin" para PQRS es el **módulo Soporte**, no mensajes directos.

### Card "Email (SMTP)" en SystemDiagnosticsPanel

El panel de Diagnósticos del SuperAdmin (`/app/superadmin/system` tab "Diagnósticos") tenía 9 `<StatusCard>` en grid `lg:grid-cols-2` — el último (Tareas programadas) quedaba huérfano en su fila. Se agregó un 10º card como contraparte natural de "Web Push": valida presencia de los 5 secrets críticos del SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`). Si todos están presentes, status `ok`; si falta cualquiera, `error` con la lista de secrets ausentes. Mantiene la simetría visual del grid sin requerir un edge function de prueba.

### Auto-sleep Java GUI runner (sin pedirle `Thread.sleep` al alumno)

El estudiante escribe `JFrame f = new JFrame(); f.setVisible(true);` y termina su `main`. Sin algo que mantenga viva la JVM, Xvfb captura un framebuffer negro porque Swing no alcanzó a pintar. Pedirle al alumno que ponga `Thread.sleep(4000)` al final del main es ruido pedagógico — no es lo que evalúa la pregunta y se les olvida.

- **`aws/code-runner/GuiBootstrap.java`**: wrapper que recibe `-Dexamlab.gui.mainClass=Main` y `-Dexamlab.gui.sleepMs=NNNN`, invoca el `main` del estudiante por reflection en un hilo daemon, espera `sleepMs` y hace `System.exit(0)`. Si el `main` lanza, desempaqueta `InvocationTargetException` para mostrar la causa real (NPE, etc.) y sale con code 2.
- **Dockerfile**: `COPY GuiBootstrap.java /opt/` + `javac -d /opt` durante el build. Sin costo en runtime.
- **`app.py`**: invoca `java -Dexamlab.gui.mainClass=Main -Dexamlab.gui.sleepMs=<delay-200> -cp tmp:/opt GuiBootstrap`. El sleep del bootstrap = `delay_ms` pedido − 200ms (margen para System.exit antes de que Python mate el proceso).
- **Pillow BGRX (no BGRA)**: Xvfb depth-24 usa 32 bits por píxel donde el 4to byte es padding (X), no alpha. Leer como BGRA con `Image.frombytes("RGBA", ..., "raw", "BGRA")` interpretaba ese padding como alpha=0 → PNG con transparencia → el visor mostraba checkerboard a través de la ventana Swing. Usar `Image.frombytes("RGB", ..., "raw", "BGRX")` descarta el byte de padding y el PNG sale opaco. Side benefit: PNGs ~25% más chicos (3 canales vs 4).
- **Fontconfig**: el Dockerfile hace `mkdir -p /var/cache/fontconfig && fc-cache -fv && chmod -R a+rX` en build. ENV `XDG_CACHE_HOME=/tmp` en runtime como fallback. Sin esto Swing pinta el JFrame pero sin texto (Fontconfig error: No writable cache directories).

### Selector de runner por pregunta en examen (resiliencia)

El admin configura UN proveedor global en `code_execution_settings`. Pero durante un examen pueden pasar fallos transitorios (Lambda cold start lento, OnlineCompiler 5xx, CheerpJ que no descarga `tools.jar`). Con UNA sola opción el estudiante pierde la pregunta.

- **Backend** ([supabase/functions/execute-code/index.ts](supabase/functions/execute-code/index.ts)): acepta `provider?: string` en el body. Whitelist: `onlinecompiler / jdoodle / aws_lambda` (CheerpJ es client-side, no llega al edge). Si llega un override válido lo usa; si no, default del admin. Audit metadata registra `provider`, `default_provider`, `provider_overridden` para detectar patrones de fallo.
- **Frontend** ([CodeRunnerPicker.tsx](src/modules/code/CodeRunnerPicker.tsx)): Select compacto sobre cada `CodeEditor` de pregunta `codigo`. Filtra opciones por lenguaje (CheerpJ solo para Java). Etiqueta "(default)" en la opción del admin; chip "Override" cuando el alumno cambia. Estado `runnerOverride: Record<questionId, provider>` en TakeExam.
- **`JavaGuiRunner`**: Select propio al lado del badge para alternar entre `cheerp` y `aws_screenshot` sin esperar al admin.

### Cancelar ejecución de código

Hasta que el alumno tiene una opción para cambiar de compilador, necesita poder cancelar el run en curso. CheerpJ NO expone API para matar la JVM (corre en un Web Worker), y los edge functions siguen ejecutando server-side hasta que el provider responda. Lo que SÍ hacemos: liberar la UI inmediatamente.

- **`CodeEditor`** acepta `onCancel?: () => void`. Botón `Cancelar` aparece a la derecha del de Ejecutar mientras `isRunning && onCancel`.
- **`runJavaInBrowser(src, signal?)`** acepta `AbortSignal`. `withTimeout(p, ms, signal?)` añade `signal.addEventListener("abort", ...)` a la carrera, rechazando con el sentinel exportado `CANCELLED_SENTINEL`. El caller distingue cancelación-de-usuario de error real en su catch.
- **TakeExam**: `runAbortersRef: Record<questionId, AbortController>`. `cancelRun(qid)` aborta el controller, limpia el slot, marca `runningCode=false`, toast informativo. `runCode` pasa el signal a CheerpJ y hace race con `cancelPromise` para el edge function (abandona la respuesta — el server termina solo). El catch silencia el sentinel.
- **`JavaGuiRunner`**: `abortRef` interno + botón `Cancelar` en el footer del dialog cuando `running || loadingCJ`.
- **Limitación documentada**: CheerpJ no se mata; el edge function tampoco se cancela server-side. Pero el alumno ya puede cambiar de compilador y reintentar sin esperar.

### Onboarding tour guiado (driver.js)

Tour interactivo de bienvenida que se dispara la primera vez que un usuario entra a la plataforma con un rol determinado. Anclado al sidebar — un paso por cada ítem visible + brand + role-switcher + footer (notificaciones, mensajes, opciones, logout).

**Estado actual (V1)**:
- ✅ **Admin**: 20 pasos completos (brand + role-switcher + 14 módulos del sidebar + 4 del footer)
- ⏳ **Docente**: pendiente — array `TEACHER_TOUR` vacío en [tour-config.ts](src/modules/onboarding/tour-config.ts)
- ⏳ **Estudiante**: pendiente — array `STUDENT_TOUR` vacío
- ❌ **SuperAdmin**: NO tiene tour por decisión de producto (operación cross-tenant, ya conoce la plataforma)

**Arquitectura**:

| Archivo | Rol |
|---|---|
| [src/modules/onboarding/tour-config.ts](src/modules/onboarding/tour-config.ts) | Arrays de pasos por rol. Cada paso: `{ element: 'selector CSS', title, description, side?, align? }` |
| [src/modules/onboarding/use-onboarding.ts](src/modules/onboarding/use-onboarding.ts) | Hook: lee `profile.onboarding_completed_roles` + `active-role-signal`. Decide `shouldShowFor` con 1s delay. Expone `complete()`, `restart()`, `dismiss()` |
| [src/modules/onboarding/OnboardingTour.tsx](src/modules/onboarding/OnboardingTour.tsx) | Wrapper de driver.js. Filtra pasos cuyo selector no exista en DOM. Al cerrar llama `onComplete(role)` (o `onDismiss()` si `manualMode`) |
| [src/modules/onboarding/onboarding-tour.css](src/modules/onboarding/onboarding-tour.css) | Overrides de `.driver-*` classes para que el popover use `var(--popover)`, `var(--primary)`, etc. Respeta dark mode y branding del tenant automáticamente |
| [supabase/migrations/20260605000000_onboarding_completed_roles.sql](supabase/migrations/20260605000000_onboarding_completed_roles.sql) | Columna `profiles.onboarding_completed_roles TEXT[]` + RPCs `mark_onboarding_complete(_role)` y `reset_onboarding(_role)` |

**Convenciones de anclaje**:

- **Ítems del sidebar nav**: atributo `data-tour-nav={item.to}` en cada `<Link>` / `<button>` del nav.map en [AppLayout.tsx](src/shared/components/AppLayout.tsx). El selector en el tour-config es `[data-tour-nav="/app/admin/courses"]` (path completo).
- **Elementos no-nav** (brand, role-switcher, footer): atributo `data-tour-id="<nombre>"` en el elemento. Selector: `[data-tour-id="brand"]`. Nombres existentes: `brand`, `role-switcher`, `user-info`, `notifications-bell`, `messages-bell`, `more-options`, `logout`.

**Cómo agregar un paso nuevo al tour de un rol**:
1. Identificar el elemento ancla en la UI.
2. Si es un nav item, ya tiene `data-tour-nav`. Si es otro elemento, agregar `data-tour-id="nombre-único"`.
3. Agregar entry en el array del rol correspondiente en `tour-config.ts`:
   ```ts
   { element: '[data-tour-id="nombre-único"]', title: '...', description: '...', side: 'right' }
   ```
4. El tour automáticamente lo incluye al desplegarse. Si el elemento no está en el DOM en ese momento (ej. visible solo en otra ruta), el filtro defensivo lo skipea sin error.

**Cómo agregar el tour de Docente/Estudiante**:
1. Llenar `TEACHER_TOUR` (o `STUDENT_TOUR`) en `tour-config.ts` con la misma estructura que `ADMIN_TOUR`.
2. No requiere cambios en `useOnboarding`, `OnboardingTour` ni `AppLayout` — el resto del pipeline ya soporta los 3 roles.

**Trigger del tour**:
- **Automático**: hook detecta `activeRole NOT IN profile.onboarding_completed_roles` → dispara con 1s delay después del login. Al completar/cerrar llama RPC `mark_onboarding_complete(role)` que agrega el rol al array.
- **Manual**: ítem "Ver tour guiado" en el dropdown del menú avatar (footer del sidebar). En modo manual NO toca el flag — el usuario puede ver el tour cuantas veces quiera.

**Limitaciones conocidas**:
- **Mobile**: el sidebar está oculto en `<md`. Los selectores no matchean → tour se cancela silenciosamente (filter elimina todos los pasos). Si se quiere tour en mobile, hay que abrir el drawer + agregar selectores específicos del drawer.
- **Página de toma de examen**: el sidebar puede estar visible pero los nav items son no-funcionales (`isTakingExam`). El tour igual se mostraría sobre items inactivos. Si se vuelve un problema, agregar guard en `useOnboarding` para no disparar cuando `isTakingExam`.

**Reset manual desde SQL (admin)**:
```sql
-- Re-mostrarle el tour a un usuario específico para un rol:
SELECT public.reset_onboarding('Admin');  -- como el propio usuario
-- O como service_role para forzar a un user específico:
UPDATE profiles
   SET onboarding_completed_roles = array_remove(onboarding_completed_roles, 'Admin')
 WHERE id = '<user_id>';
```

### Papelera (soft-delete) — `/app/trash`

Sistema de "borrado reversible" para 8 entidades padre: `courses`, `exams`, `workshops`, `projects`, `attendance_sessions`, `whiteboards`, `generated_contents`, `polls`. Toda eliminación de estas entidades pasa por el flujo soft → trash → purge a 30 días.

- **DB** ([20260816000000_trash_soft_delete.sql](supabase/migrations/20260816000000_trash_soft_delete.sql)): columnas `deleted_at TIMESTAMPTZ` + `deleted_by UUID REFERENCES auth.users` en las 8 tablas. Index parcial `WHERE deleted_at IS NOT NULL` por tabla. RPCs `trash_restore_item(_table, _id)` y `trash_hard_delete_item(_table, _id)` con `SECURITY INVOKER` (la RLS del caller aplica). Función `purge_deleted_items(_ttl INTERVAL DEFAULT '30 days')` con `SECURITY DEFINER` invocada por pg_cron job `purge-deleted-items-daily` a las 03:00 UTC.
- **Seed** ([20260816000010_seed_trash_module_visibility.sql](supabase/migrations/20260816000010_seed_trash_module_visibility.sql)): fila en `module_visibility` (`tenant_id IS NULL`) con `display_order=250`, enabled para Docente/Admin/SuperAdmin, disabled para Estudiante.
- **Helpers** ([src/modules/trash/soft-delete.ts](src/modules/trash/soft-delete.ts)): `softDelete(table, id)` y `softDeleteMany(table, ids)` para los handlers; `restoreItem(table, id)` y `hardDeleteItem(table, id)` invocan las RPCs. `TRASH_TABLE_LABEL` + `TRASH_NAME_COL` para mapping UI.
- **UI** ([src/routes/app.trash.tsx](src/routes/app.trash.tsx)): tabla unificada de las 8 tablas con `usePagination` + search + `useMultiSelect`. Bulk restore + bulk hard-delete. Badge "días restantes" colorado (rojo ≤3d, ámbar ≤7d). RBAC: solo Docente/Admin/SuperAdmin (en `src/shared/lib/rbac.ts`).
- **Handlers convertidos**: `app.admin.courses.tsx`, `app.teacher.exams.index.tsx`, `app.teacher.workshops.tsx`, `app.teacher.projects.tsx`, `app.teacher.attendance.tsx`, `app.teacher.whiteboards.index.tsx`, `app.teacher.contents.tsx`, `app.teacher.polls.tsx`. TODOS los listados principales filtran `is('deleted_at', null)` en su query inicial.
- **Tipo `ModuleKey`** en `use-module-visibility.ts` incluye `"trash"`. NAV path `/app/trash` mapeado en `NAV_PATH_TO_MODULE` para que respete display_order configurable.
- **Limitación V1**: `generated_contents` soft-delete NO borra archivos del Storage. Quedan disponibles al restaurar; al hard-delete físico quedan huérfanos hasta cleanup manual (TODO v2 — job que limpie storage al purge).
- **Tests** ([src/modules/trash/soft-delete.test.ts](src/modules/trash/soft-delete.test.ts)): cobertura del set canónico de tablas + `TRASH_TABLE_LABEL` / `TRASH_NAME_COL`.

### Snippets de código por sesión

Cada `attendance_session` puede tener N snippets de código (Java/Python/JavaScript) que el docente prepara en clase y los alumnos ven (y opcionalmente ejecutan) desde su vista de asistencia.

- **DB** ([20260814000000_session_code_snippets.sql](supabase/migrations/20260814000000_session_code_snippets.sql)): tabla `session_code_snippets(id, session_id, position, title, language, source_code, last_stdout, last_stderr, last_exit_code, last_executed_at)`. RLS: docente del curso CRUD, alumno SELECT.
- **UI** ([src/modules/sessions/SessionCodeSnippets.tsx](src/modules/sessions/SessionCodeSnippets.tsx) + [Dialog wrapper](src/modules/sessions/SessionCodeSnippetsDialog.tsx)): Monaco editor por snippet, autosave debounced 1.5s, botón Run via edge `execute-code` (pasa snippet.id como `questionId`), cacheado del último output. Modo readOnly para alumno: puede ejecutar pero output no persiste.
- **Integración**: dropdown "Snippets de código" en `app.teacher.attendance.tsx` (icono `Code2`); botón "Código" en `app.student.attendance.tsx` por fila de sesión. El dialog muestra mensaje friendly cuando alumno entra y no hay snippets.

### Pizarra de sesión COMPARTIDA con realtime broadcast

Toggle "Pizarra compartida" en el dialog de pizarra de sesión. Cuando ON, los alumnos matriculados pueden EDITAR la misma pizarra y los cambios se sincronizan en vivo via Supabase Realtime.

- **DB** ([20260815000000_session_shared_whiteboard.sql](supabase/migrations/20260815000000_session_shared_whiteboard.sql)): columna `attendance_sessions.whiteboard_shared BOOLEAN`. RPCs `update_session_whiteboard_scene(_session_id, _scene)` y `set_session_whiteboard_shared(_session_id, _shared)` ambas `SECURITY DEFINER` — la primera valida que el alumno solo puede escribir si `whiteboard_shared=true`, la segunda solo docente.
- **WhiteboardEditor** ([src/modules/whiteboard/WhiteboardEditor.tsx](src/modules/whiteboard/WhiteboardEditor.tsx)): nueva prop `realtimeChannelName?: string`. Cuando se pasa, se suscribe al canal Supabase Realtime; cada local change emite broadcast `scene_update` (debounce 200ms) con `clientId` único por pestaña; al recibir broadcast ajeno aplica `updateScene` con `commitToHistory:false / captureUpdate:never`. Badge "Compartida en vivo" cuando SUBSCRIBED.
- **Limitación**: last-write-wins en DB (no OT). Si dos personas dibujan EXACTAMENTE al mismo tiempo, puede haber ~1.5s de ping-pong hasta estabilizar.
- **Student access**: botón "Pizarra" (azul cielo) en `app.student.attendance.tsx` aparece SOLO cuando `session.whiteboard_shared=true`. Reusa `SessionWhiteboardDialog` con `studentMode=true` (oculta el toggle).

### Viewport persistente Excalidraw

`WhiteboardEditor` acepta `viewportStorageKey?: string`. Cuando se pasa:
- Al mount lee `scrollX/scrollY/zoom` de localStorage y los merge a `initialData.appState`.
- En cada onChange persiste con debounce 500ms.

Usado por `MultiPageWhiteboard` (`examlab_wb_view:page:<id>`) y `SessionWhiteboardDialog` (`examlab_wb_view:session:<id>`). Antes el viewport se perdía al cerrar/reabrir — bug reportado por usuarios.

### Librerías predefinidas en Excalidraw

[src/modules/whiteboard/excalidraw-libraries.ts](src/modules/whiteboard/excalidraw-libraries.ts) — 8 items curados (flowchart proceso/decisión/inicio/IO, UML clase, data structures nodo/array/linked-list). Pasados al editor via `initialData.libraryItems` → aparecen en el panel "Library" del aside derecho. Hand-crafted para no inflar el bundle.

- **Tests** ([src/modules/whiteboard/excalidraw-libraries.test.ts](src/modules/whiteboard/excalidraw-libraries.test.ts)): cobertura de shape válido (id único, elements con campos required, fontFamily en texts).

### Python execution + tkinter GUI en AWS Lambda

Lambda runner extendido para Python (no solo Java). Soporta `mode='run'` con `language='python'` (subprocess `/usr/bin/python3` AL2023) y `mode='tkinter_screenshot'` (paralelo a `gui_screenshot` de Java) con `TkinterBootstrap.py` que monkey-patchea `Tk.__init__` para programar destroy automático.

- **Dockerfile**: `dnf install -y python3 python3-tkinter tk tcl unzip` (este último crítico — la base image AL2023 NO lo trae y el OpenJFX install lo necesita).
- **Migration 20260813000000**: añade `python_gui` al CHECK de `questions`, `workshop_questions`, `project_files`, `question_bank`. Columna `code_execution_settings.python_gui_provider`. Defensiva con `to_regclass` por si la tabla `question_bank` no existe (caso real en producción).
- **PythonGuiRunner** ([src/modules/code/PythonGuiRunner.tsx](src/modules/code/PythonGuiRunner.tsx)): paralelo a `JavaGuiRunner` pero solo `aws_screenshot` (no hay Pyodide+tkinter en WASM).
- **AI grading**: nuevo directive `python_gui` con rúbrica tkinter (Label/Button/pack/grid/mainloop).
- **Admin panel**: nuevo RadioGroup `python_gui_provider` (color sky).

### Polls — UX del generador de slots (modo Auto/Manual)

Generador de slots tipo Doodle (`/app/teacher/polls` → tipo `slot`):
- Badge "Auto" / "Manual" sobre el input de cupo.
- Auto-cálculo `ceil(matriculados / total_slots)` solo cuando `cupoManual=false`. Si el docente tipea, pasa a Manual y el useEffect deja de sobreescribir. Botón "← Volver a auto" revierte.
- Panel resumen en vivo: `N fechas × M slots/día = Z slots · Capacidad total: X / Y` verde si alcanza, ámbar accionable si faltan cupos.
- `setCupoManual(false)` en el reset del dialog para no heredar manual de poll anterior.

### Polls asociadas a sesión

`polls.attendance_session_id` ya existía en schema; ahora hay UI:
- **Form de crear/editar encuesta** ([app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx)): Select "Asociar a sesión (opcional)" que lista sesiones del curso ancla. Acepta `prefilledSessionId`/`prefilledCourseId` para abrir desde una sesión concreta.
- **`LaunchPollDialog`** (existente) abre desde el dropdown del docente en `app.teacher.attendance.tsx`.

### Sessions import/export — 7 columnas (round-trip preservado)

`SESSIONS_TEMPLATE` extendido en [app.teacher.attendance.tsx](src/routes/app.teacher.attendance.tsx) a `session_date, title, cut_name, start_time, duration_minutes, meeting_url, recording_url`. Importer parsea start_time (HH:MM o HH:MM:SS), duration_minutes (int >= 0), URLs (tal cual). Filas con session_date inválido se descartan; filas con campos opcionales inválidos NO abortan (los campos quedan null).

Generador paramétrico de sesiones (`GenerateSessionsDialog`) ya existía en `src/modules/contents/`.

### Onboarding tour — tours completos para 3 roles

[src/modules/onboarding/tour-config.ts](src/modules/onboarding/tour-config.ts) tiene ADMIN_TOUR (~22 steps), TEACHER_TOUR (~24 steps), STUDENT_TOUR (~15 steps). Cada tour incluye:
- Bienvenida (brand + role switcher).
- Recorrido por TODOS los módulos del sidebar del rol.
- Step "Papelera" en Admin y Docente.
- **Flujos "Cómo crear X"** con HTML `<ol>` en cada description para los módulos críticos: en Docente — crear curso/examen/taller/proyecto/sesión/pizarra/encuesta; en Estudiante — entregar examen/taller/proyecto + check-in de asistencia.
- Footer (4 items: user-info, notifs, mensajes, more-options).

`description` admite HTML simple (`<strong>`, `<em>`, `<ol>`, `<ul>`, `<li>`, `<code>`) — driver.js usa `innerHTML`. Mantener bajo ~600 chars para que el popover no se salga del viewport en mobile.

`OnboardingTour.tsx` filtra steps cuyo selector NO existe en DOM — útil para módulos opcionales (Banco de preguntas se puede ocultar globalmente).

- **Tests** ([src/modules/onboarding/tour-config.test.ts](src/modules/onboarding/tour-config.test.ts)): integridad estructural de los 3 tours, no hay selectores duplicados, descriptions con `<ol>` en flujos críticos, cobertura de módulos clave por rol.

---

## Convenciones de código

- **Toda fecha visible al usuario** debe pasar por los helpers de `src/lib/format.ts`. NO usar `new Date(x).toLocaleString()` directo en JSX.
- **Decimales en inputs de notas**: usar `<DecimalInput>`. Texto de ayuda "Decimales con coma (ej. 4,5)" cerca del input.
- **Acciones de fila en tablas/grids**: `<RowAction label icon onClick />`. NO `<Button variant="ghost" title>`.
- **Loaders**: `<Spinner size>` o `<SectionLoader>` / `<PageLoader>`. NO `<Loader2 className="h-4 w-4 animate-spin">` directo.
- **Estados de submission/workshop/etc.**: `<StatusBadge status>`. NO `<Badge>` con clases ad-hoc.
- **Confirmaciones**: `useConfirm()` (de `src/shared/components/ConfirmDialog.tsx`). NO `window.confirm()` nativo, NO Dialog custom para confirmar.
- **Inline styles `style={{}}`**: prohibidos para layout/colores estáticos. Reemplazar siempre por Tailwind classes (incluso valores arbitrarios: `h-[60vh]`, `border-l-violet-500`). Se permiten SOLO para: (a) CSS vars del theme dinámico (`var(--sidebar-icon-color)`, `tenant.primary_color` por fila), (b) dimensiones/transformaciones runtime (`width: progress + "%"`, `transform: scale(zoom)`), (c) `env(safe-area-inset-*)` iOS, (d) valores de DB/usuario (color hex pickers). Backgrounds repetidos (ej. damero): extraer utility en `src/styles.css` (ver `bg-checkerboard`). El audit de inline styles dio 35 hits totales, 34 justificados, 1 trivial — el repo está sano; mantenerlo así.
- **Patrón de campos desactivados** (memoria de feedback): cuando un flag UI desactiva un grupo de campos, **omitirlos del INSERT/UPDATE** payload en lugar de mandar dummies. Evita errores tipo "Could not find the 'X' column in schema cache" cuando hay schema cache stale.
- **`react-hooks/exhaustive-deps` con `load()`**: el patrón canonical para queries de carga es una función `load` definida en el component (sin `useCallback`) llamada desde `useEffect(() => { void load(); }, [trigger])`. ESLint pide `load` en deps pero `load` se redefine cada render → loop infinito si lo metes. Se acepta la supresión `// eslint-disable-next-line react-hooks/exhaustive-deps`. Si refactorizas, usa `useCallback(load, [...realDeps])` — pero el costo de mantener las deps de useCallback típicamente excede el beneficio. Si vas a tocar uno, déjalo igual a menos que haya un bug funcional.
- **`useEffect` con async + `setState` / `toast`**: SIEMPRE meter un guard `let cancelled = false` y limpiarlo en el cleanup. Si el usuario navega antes de que el `await` resuelva, el setState dispara warning "set state on unmounted" y el toast aparece huérfano en la pantalla nueva. Patrón:
  ```tsx
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await fetch(...);
      if (cancelled) return;
      setX(data);
    })();
    return () => { cancelled = true; };
  }, [deps]);
  ```
  Aplicado en dashboards `app.index.tsx`, `app.student.courses.tsx`, `app.student.grades.tsx`. Para nuevos `useEffect` con async, copia el patrón.
- **Banco de preguntas — gating por curso del docente**: el `question_bank` vive POR CURSO (RLS lo enforza vía `course_teachers`). Un Docente que NO está en `course_teachers` de ningún curso ve el selector "Curso" vacío y el botón "Nueva pregunta" disabled. UX obligatorio: mostrar mensaje accionable bajo el Select ("Pedile al Admin del tenant que te asigne a un curso para empezar") + empty state con texto distinto cuando `!courseId` ("Elegí un curso") vs `courseId && rows.length === 0` ("Aún no tienes preguntas"). El botón "Crear la primera" del empty state SOLO se renderiza cuando hay courseId — sino el dialog abre sin curso y el INSERT explota. Para SuperAdmin / Admin la query bypasa el inner join y trae todos los cursos del tenant.
- **Bulk import users — root cause de "Database error creating new user" 500**: causa raíz era la combinación de (1) `handle_new_user` rechazaba UNIQUE violation contra el unique index sobre `LOWER(institutional_email)` (mig 20260906 lo arregla con re-vinculación de huérfanos), (2) FK `course_enrollments.user_id` → `profiles.id` sin `ON UPDATE CASCADE` rompía la re-vinculación si había enrollments huérfanos (mig 20260909 cambia a CASCADE). Tras Publish de ambas migs el bulk import funciona limpio incluso con residuos de intentos previos. El `diag_likely_cause: "unknown_trigger_failure"` en audit_logs ANTES del deploy ahora aparece como creación exitosa. Si vuelves a verlo post-deploy, el bug es realmente OTRO trigger — investigar `pg_trigger` en `auth.users` + `public.profiles` + `public.user_roles`. Convención de testing: la edge `bulk-import-users` espera `roles` como STRING separado por `|` (NO array TypeScript). El cliente UI manda string desde el CSV parse — si se prueba con curl pasando array, devuelve `TypeError: "split is not a function"`.
- **Encabezado de módulo (top-level)**: módulos accedidos desde el sidebar nav usan `<PageHeader>` SIN `backTo` (no tiene sentido un "Volver" cuando entras desde el nav). El conteo de items va en el `subtitle` (ej. "12 cursos registrados", "8 de 24 proyectos"). Las acciones (botón "Nuevo X", `ImportExportMenu`, etc.) van en el slot `actions`. El ícono del módulo en `icon`. Esto reemplaza el patrón inline `<h1 className="text-2xl…">` que aparece en algunas pantallas viejas — al tocar esa pantalla, migrar a `PageHeader` para uniformidad.
- **Encabezado de página de detalle**: usar `<PageHeader backTo="/app/.../parent" title subtitle actions />`. La diferencia con el top-level es solo el `backTo` (el componente es el mismo). Detalle = entrar desde una fila/click, NO desde el sidebar.
- **Embeds PostgREST con FKs**: `submissions.user_id` apunta a `auth.users`, NO a `profiles`. Embed tipo `profile:profiles!submissions_user_id_fkey(...)` **falla en silencio** (sin error, sin data). Si necesitas joinear submission + profile, hacer 2 queries separadas: `submissions` → IDs → `profiles.in('id', userIds)`.
- **Navegación TanStack con params**: usar `navigate({ to: "/app/teacher/monitor/$examId", params: { examId } })`. NUNCA `navigate({ to: \`/app/teacher/monitor/${id}\` as any })` con URL interpolada — falla en silencio porque el router no matchea el patrón `$examId`.
- **`CREATE OR REPLACE FUNCTION` y cambio de RETURNS**: si una función ya existe y cambia el row type de OUT parameters (ej. agregar una columna al `RETURNS TABLE(...)`), Postgres tira `cannot change return type of existing function`. Hay que `DROP FUNCTION IF EXISTS name(args)` antes del `CREATE`. Solo aplica cuando cambian las columnas — agregar lógica al body con misma firma sí soporta `OR REPLACE`.
- **pg_cron**: vive en schema `extensions.cron.*` en Supabase. Las funciones de gestión (`alter_job`, `schedule`, `unschedule`) son síncronas — el UPDATE a `cron.job` aplica al instante, el scheduler lo respeta en su próximo tick (~1 min).
- **Errores de Supabase en `toast.error`**: NO usar `toast.error(error.message)` — los mensajes vienen en inglés técnico (`"duplicate key value violates unique constraint..."`). Usar `toast.error(friendlyError(error))` de `@/shared/lib/db-errors`, que traduce códigos SQLSTATE comunes (23503, 23502, 23514, 42501, P0001, PGRST116, etc.) + patrones de red/auth a español. Aplicar también en `catch (e) { toast.error(friendlyError(e)) }`. Para mensajes de `RAISE EXCEPTION` desde funciones SQL, P0001 deja pasar el mensaje original — escribir esos RAISEs en español.
- **Nombres de tablas: `course_enrollments` (no `course_students`)**: la tabla de matrículas alumno↔curso es `course_enrollments`. `course_students` NUNCA existió como tabla — solo como nombre de la RPC `notify_course_students` (función que notifica a todos los alumnos del curso). Una query a `from("course_students")` rompe con `PGRST205` y `hint: "Perhaps you meant the table 'public.course_schedules'"`. Si refactoras stats de "alumnos por curso", usar `course_enrollments`.
- **SuperAdmin hereda nav de Admin**: cuando `activeRole === "SuperAdmin"`, el filtro `visibleNav` retorna `true` para items con `roles: ["Admin"]` (línea ~672 de AppLayout). Esto deja al SuperAdmin acceder a /app/admin/users, /app/admin/courses, etc. sin agregarle el rol Admin en cada `roles`. Confirmado por la regla RBAC `{ prefix: "/app/admin", roles: ["Admin", "SuperAdmin"] }` en `src/shared/lib/rbac.ts`. Si añades una nueva ruta /app/admin/X, NO necesitás listar SuperAdmin en sus `roles` del NAV — basta con `roles: ["Admin"]` y el sidebar lo muestra al SuperAdmin automáticamente.
- **Filtros cross-tenant en módulos compartidos**: si la tabla tiene `tenant_id`, aplicar `.eq("tenant_id", X)` directo. Si NO la tiene (ej. `certificates`, `submissions`), usar patrón 2-step: primero `select("id").from("courses").eq("tenant_id", X)` → array de IDs → `.in("course_id", ids)` en la query principal. **Crítico**: si `ids.length === 0`, cortar el query antes de pegarle a la tabla principal (setear `items=[]` y `return`) — un `.in("X", [])` en PostgREST devuelve TODOS los rows, no ninguno. El filtro UI debe quedar oculto en el branch Admin-no-SuperAdmin (la RLS ya acota a su tenant).
- **Conversaciones canónicas (`messages`/`conversations`)**: la tabla `conversations` tiene CHECK `user_a < user_b` (orden lexicográfico de UUID) y UNIQUE `(user_a, user_b)`. Cuando inserts una conversación entre 2 users, calcular el orden canónico antes: `const [user_a, user_b] = a < b ? [a, b] : [b, a]`. Si confías la dedup al CHECK, vas a fallar con violación de constraint. UPSERT con `onConflict: "user_a,user_b", ignoreDuplicates: true` preserva `cleared_at` / `last_read_at` de la fila vieja.
- **"Eliminar conversación para mí" (soft delete por usuario)**: el RPC `clear_conversation(_conv_id)` setea `user_a_cleared_at` o `user_b_cleared_at` según el caller — NO borra la fila ni los mensajes. La RLS de `messages` filtra los `created_at <= mi_cleared_at` (invisibles para mí, visibles para el otro). **La lista del sidebar** (`/app/messages`) filtra ADEMÁS a nivel client: si tengo `cleared_at` Y `lastMessage` es null (RLS no devolvió mensajes nuevos), oculto la conversación de mi lista. Sin este filtro client-side, el inbox quedaba lleno de cards "vacías" tras varios deletes — UX confusa que el QA reportó. **Resurrección automática**: cuando el otro me manda un mensaje nuevo, `lastMessage.created_at > mi_cleared_at`, el filtro lo deja pasar y la conversación reaparece con SOLO los mensajes nuevos (los viejos siguen ocultos por RLS). Si reformulas esta lógica, asegurarte que `loadAll` siga filtrando por `(myClearedAt && !lastMessage) → skip`.
- **Generador de slots Doodle (encuestas, V2)** ([src/modules/polls/slot-generation.ts](src/modules/polls/slot-generation.ts)): el docente agrega N FECHAS manualmente + UNA ventana horaria compartida + paso + cupo → genera cross-product `fechas × slots-por-día`. V1 tenía dos `DateTimePicker` (Inicio + Fin) que cruzaba días continuos — confuso porque "9-12 lun, mar, mié" producía también slots de lun 12:00 hasta mié 12:00 cruzando la noche. V2 separa fechas vs ventana → modelo más natural. La función `generateSlotsForDates({ dates, timeStart, timeEnd, stepMin, cupo })` es PURA (sin React, sin Date.now, sin toast) y devuelve `[{ label, max_responses }]` con label tipo `"mié, 10 de jun · 9:00 AM"`. Companion `suggestSlotCupo(...)` calcula el ceil de matriculados/slots para que TODOS quepan. Tests exhaustivos en `slot-generation.test.ts` (22 casos: invalid input, edge cases, dedup, formato 12h, cross-product). Locale es-CO hardcoded — Intl produce "10 de jun" con la preposición; las tests esperan ese formato exacto.
- **Componentes compartidos entre rutas (Admin/Docente)**: ej. `app.teacher.courses.tsx` reusa `AdminCourses` por `import { AdminCourses } from "./app.admin.courses"`. Bugs en el componente afectan a ambas rutas. Esto se hace **a propósito** para paridad de funcionalidad — la diferencia entre Admin y Docente vive en RLS y en filtros UI runtime, no en componentes separados.
- **Hydration mismatch (React #418) en initializers de useState**: NUNCA leer `localStorage`, `window.location`, `document`, ni cualquier API del browser en el initializer de `useState(() => ...)`. El primer render del cliente DEBE coincidir bit-a-bit con el HTML pre-renderizado, que NO tiene browser APIs disponibles. Si el initializer produce un valor distinto al post-paint del servidor, React tira `Minified React error #418` (visible como toast huérfano "Uncaught Error" en audit logs). Patrón obligatorio: `useState(VALOR_DETERMINISTICO)` + `useEffect(() => { ...lee storage/URL... setX(...) }, [])` que corre POST-mount. Aplicado en `useTheme` (mig original) y `auth.index.tsx` (email, rememberMe, selectedSlug — bug reportado en producción). MISMO patrón vale para `useState<Foo>(() => new Date())` y similares — usar valor inicial determinístico y setearlo en effect.
- **RBAC: SuperAdmin en rutas de Docente**: la regla genérica `/app/teacher` = `[Docente]` BLOQUEA al SuperAdmin aunque el NAV declare `roles: ["Docente", "SuperAdmin"]`. Si el item del nav incluye SuperAdmin, agregar una excepción RBAC específica en `src/shared/lib/rbac.ts` ANTES de la regla genérica `/app/teacher` (longest-prefix gana). Ej. `/app/teacher/exams`, `/app/teacher/workshops`, `/app/teacher/calendar` tienen excepciones individuales — al agregar un nuevo item del nav `/app/teacher/X` con SA, agregar también su regla RBAC. Sin esto el SA ve el ítem en el sidebar pero click lo manda a `/app/unauthorized` — silencioso y confuso.
- **Hard-delete tenants requiere cleanup explícito de FKs RESTRICT + cascade a auth.users**: 6 tablas tienen FK a `tenants.id` con `ON DELETE RESTRICT` (profiles, courses, academic_programs, academic_periods, academic_subjects, videos). Un `DELETE FROM tenants` directo falla con 23503 sin nombrar la tabla bloqueante. La RPC `hard_delete_tenant` (mig 20260905000000, reemplaza la 20260902000000) hace el cleanup en orden: capturar `v_user_ids` de los profiles del tenant (excluyendo al caller y a SuperAdmins por defensa), `DELETE academic_*`, `DELETE videos`, `DELETE courses` (cascade limpia exams/workshops/etc.), `DELETE profiles` del tenant, `DELETE tenants` envuelto en `BEGIN/EXCEPTION`, `DELETE FROM auth.users WHERE id = ANY(v_user_ids)` AL FINAL para que las cascadas vía courses/enrollments hayan corrido primero. **Decisión de diseño**: el comportamiento original (`UPDATE profiles SET tenant_id = NULL` preservando users) se reemplazó por DELETE físico — el user reportó "el usuario de prueba sigue vivo después de borrar el tenant" y eso no era el comportamiento esperado del hard-delete. Cuando agregues una nueva tabla con `tenant_id REFERENCES tenants ON DELETE RESTRICT`, actualizar `hard_delete_tenant` para incluir su DELETE. Si agregás una FK a `auth.users` con RESTRICT, también actualizar (el segundo EXCEPTION handler dará el detalle de la FK bloqueante).
- **Bulk operations: mostrar el PRIMER error real, no solo "N con error"**: `Promise.allSettled` sobre N llamadas → contar fallos pero NO descartar el detalle. Patrón: `toast.error(\`${ok} ok, ${failed} con error. Primero: "${first.name}" — ${friendlyError(first.error)}\`, { duration: 12000 })`. Sin esto el usuario ve "2 con error" sin pista del por qué — caso reportado al hard-deletear tenants con FKs RESTRICT y al fallar RLS de operations bulk. Aplicado en `app.trash.tsx` (bulkRestore + bulkHardDelete). Cualquier bulk operation nueva debe seguir este patrón.
- **Panel unificado de IA debe preservar visibilidad del error**: cuando `UnifiedAiQueuePanel` unificó las 2 colas (grading + generation) perdió silenciosamente el panel expandible que mostraba el `last_error` completo. Patrón obligatorio en cualquier panel de queue/jobs: (1) preview del error truncado en 1 línea SIEMPRE visible cuando hay `last_error` (sin requerir click), (2) panel expandible con detalle completo + botón **Copiar al portapapeles** (`navigator.clipboard.writeText`), (3) shape del query debe incluir `body` para jobs de generación. Sin esto el docente no puede diagnosticar por qué un job falló y se vuelve "silent fail" reportado.
- **Backups DB: incluir SuperAdmin en validación**: cuando un módulo se introdujo pre-SuperAdmin (ej. db_backups mig 20260523100000), las policies/RPCs solo validan `has_role(_, 'Admin')`. Al introducir SA, todas las RPCs `admin_*_db_backup` + las 3 RLS policies necesitaron paralelizar a `OR public.is_super_admin()` (mig 20260903100000). Mismo aplica al edge `db-backup-runner` (línea ~72) que validaba solo Admin. Al añadir un módulo Admin-only nuevo, decidir si SA debe acceder y agregar la validación paralela desde el inicio.
- **Helper centralizado `isStaffRole(roles)` / `isAdminLike(roles)` / `isSuperAdmin(roles)` / `isStudent(roles)`** ([src/shared/lib/roles.ts](src/shared/lib/roles.ts)): NO duplicar `roles.includes("Docente") || roles.includes("Admin")` inline — usar el helper. `isStaffRole` = Docente OR Admin OR SuperAdmin (para pantallas `/app/teacher/*` que el SA accede para soporte/diagnóstico). `isAdminLike` = Admin OR SuperAdmin (gestión de tenant). El bug recurrente que ataja: agregar un módulo nuevo Docente y olvidar SA → SA recibe "Necesitas rol Docente" silencioso. Aplicado en 7 rutas teacher (attendance, workshops, projects, exams, gradebook, ai-prompts, statistics) + audit-logs teacher.
- **auditFromEdge: pasar `tenantId` explícito** ([supabase/functions/_shared/audit.ts](supabase/functions/_shared/audit.ts)): cuando una edge corre como service_role, `auth.uid()` es NULL → el trigger SQL `tg_set_tenant_id` que lee `current_tenant_id()` retorna NULL → el audit_log queda con `tenant_id=NULL`. La RLS endurecida del Admin (mig 20260528010000) exige `tenant_id = current_tenant_id()` (NO acepta NULL), así que esos logs SOLO los ve el SA — el Admin del tenant los pierde. Fix: `auditFromEdge` acepta prop `tenantId?` opcional + fallback que lo resuelve desde `profiles.tenant_id` del actorId. Cualquier edge nueva que llame `auditFromEdge` debe pasar el `tenantId` del DESTINO (no del actor) cuando opera sobre un tenant distinto al del caller — caso típico: SA importando users a un tenant específico. Aplicado en `bulk-import-users`.
- **GlobalErrorLogger `isBrowserNoise`** ([src/shared/components/GlobalErrorLogger.tsx](src/shared/components/GlobalErrorLogger.tsx)): filtra 4 patrones de ruido del browser/PWA lifecycle que NO son bugs accionables y inundan `audit_logs`: "Failed to update a ServiceWorker", "newestWorker is null", "Lock ... was released because another request stole", "Script error." (cross-origin sin info). Aplicado en `onError` + `onRejection` ANTES del logEvent. Si reportes futuros muestran errores reales que el filter está silenciando, ajustar el regex — pero no quitar el filter entero (los SW errors son ~50% del volumen sin valor).
- **Año dinámico en JSX (`new Date().getFullYear()`) requiere wrapping en componente con estado** ([src/routes/index.tsx](src/routes/index.tsx)): inline `{new Date().getFullYear()}` en el footer SSR-rendereaba el año del worker (UTC) y el cliente lo re-evaluaba con su TZ — si la hidratación cruzaba medianoche local cerca del 31-dic, mismatch y React #418 intermitente. Patrón: componente `<CurrentYear />` con `useState<number | null>(null)` + `useEffect(() => setYear(new Date().getFullYear()), [])`. SSR y primer render del cliente devuelven el mismo placeholder vacío `"    "` (4 chars para no saltar layout); el año real se rellena post-mount. Mismo patrón para CUALQUIER cosa derivada de `new Date()` o `Date.now()` que se renderee en JSX y se ejecute en SSR.
- **`vh → dvh` en `max-h` de DialogContent** (regla obligatoria para mobile iOS): en iOS Safari `vh` usa el viewport MÁXIMO (URL bar colapsada). Cuando la URL bar está visible, un modal con `max-h-[90vh]` se desborda ~80-100px abajo (footer cortado, scroll roto). El base `DialogContent` ([src/components/ui/dialog.tsx:60](src/components/ui/dialog.tsx#L60)) usa `dvh` (dynamic viewport height — respeta el viewport ACTUAL). NO sobreescribir con `vh` en subdialogs. Para limitar altura usar `max-h-[Ndvh]`. Audit de 2026-06-08 encontró 26 archivos con `vh` que se cambiaron en batch a `dvh`.
- **Touch targets en mobile ≥32px**: cualquier botón clickeable en mobile debe tener un hit zone ≥32x32px (iOS recomienda 44px). Patrones a evitar: `<button>` bare con solo ícono `<Eye h-4 w-4>` y posición absoluta (touch zone ~16px), `h-6 w-6` o `h-7 w-7 p-0`. Fix: `h-8 w-8 p-0` o `p-1.5 rounded` para expandir hit zone sin alterar visual. Convención aplicada en password reveal buttons (5 ubicaciones), pickers de mes/whiteboard/diagram (5 ubicaciones).
- **`bg-checkerboard` utility en src/styles.css**: damero gris/blanco (light) o zinc-800/700 (dark) usado para distinguir contenido pintado de fondo transparente — antes inline `style={{ backgroundImage: 'linear-gradient(...)' }}` copiado en JavaGuiRunner + PythonGuiRunner + hex-color-input. Centralizado en utility CSS para que cualquier nuevo lugar use `className="bg-checkerboard"`.
- **Inline styles `style={{}}`**: prohibidos para layout/colores estáticos. Reemplazar siempre por Tailwind classes (incluso valores arbitrarios: `h-[60vh]`, `border-l-violet-500`). Permitidos SOLO para: (a) CSS vars del theme dinámico (`var(--sidebar-icon-color)`, `tenant.primary_color` por fila), (b) dimensiones/transformaciones runtime (`width: progress + "%"`, `transform: scale(zoom)`), (c) `env(safe-area-inset-*)` iOS, (d) valores de DB/usuario (color hex pickers). Backgrounds repetidos (ej. damero): extraer utility en `src/styles.css` (ver `bg-checkerboard`). El audit de inline styles dio 35 hits totales, 34 justificados, 1 trivial — el repo está sano; mantenerlo así.
- **Safe-area iOS en elementos `fixed` bottom**: cualquier `fixed bottom-X` que pueda mostrarse en mobile debe usar `bottom-[max(env(safe-area-inset-bottom),Xrem)]` para no quedar tapado por el home indicator de iOS o gesture bar de Android. En desktop `env(safe-area-inset-bottom)=0` → el max() resuelve al fallback, comportamiento idéntico. Aplicado en `MessagesFab.tsx`. Pattern preemptivo: agregalo desde el inicio aunque el elemento esté `hidden md:flex` hoy.
- **Tests con `useConfirm()` mockean `@/shared/components/ConfirmDialog`, NO `window.confirm`**: el `vi.spyOn(window, "confirm")` no funciona porque ya no usamos confirm nativo. Patrón:
  ```ts
  const confirmResult = { value: true };
  vi.mock("@/shared/components/ConfirmDialog", () => ({
    useConfirm: () => async () => confirmResult.value,
    ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
  // En tests: confirmResult.value = false; // simular cancelación
  ```
  Evita renderizar el AlertDialog Radix real (que requiere portal). Aplicado en `FeedbackCommentAttachments.test.tsx`.

## Grabación de tours para HeyGen (avatars IA)

Pipeline para regenerar los 3 background videos que se overlapean con un avatar HeyGen. Vive en `docs/heygen/`.

### Estructura

- `docs/heygen/README.md` — pipeline general.
- `docs/heygen/admin.md` / `docente.md` / `estudiante.md` — guión que va al avatar (sección `> Script`) + recomendaciones de cortes visuales por segundo.
- `docs/heygen/recordings/admin.webm` + `teacher.webm` + `student.webm` — los 3 backgrounds (versionados en git con nombres limpios sin timestamp).
- `docs/heygen/recordings/README.md` — cómo regenerar + cómo usar en HeyGen.
- `scripts/record-tour.ts` — script Playwright que recorre la app real (https://examlab.lovable.app).
- `.env.recording` (gitignored) — credenciales del usuario demo.
- `recordings/` (gitignored como `/recordings/` anchored — para NO matchear `docs/heygen/recordings/`) — output dir efímero con archivos timestamped.

### Correr (Windows)

```bash
# Usar NODE, NO bun. Razón: bun + playwright en Windows tiene bug
# con remote-debugging-pipe → chromium.launch() timeout 180s.
# Node 22+ con --experimental-strip-types corre el mismo .ts en <1s.
node --experimental-strip-types scripts/record-tour.ts --role=admin
node --experimental-strip-types scripts/record-tour.ts --role=teacher
node --experimental-strip-types scripts/record-tour.ts --role=student

# Después copiar al dir versionado (sin timestamp):
cp recordings/admin-*.webm docs/heygen/recordings/admin.webm
cp recordings/teacher-*.webm docs/heygen/recordings/teacher.webm
cp recordings/student-*.webm docs/heygen/recordings/student.webm
```

En Mac/Linux probablemente `bun run record:tour:teacher` funcione (el bug es solo en Windows). Igual el `package.json` ya tiene los scripts npm apuntando a `node --experimental-strip-types`.

### Cuenta multi-rol + `selectActiveRole` + SPA nav

`test-fesna@examlab.test` (FESNA) tiene los 3 roles. Por defecto entra como Admin. Para grabar Docente/Estudiante el script:

1. `login()` → submit → redirect `/app`.
2. `selectActiveRole(role)` → `waitForSelector('[data-tour-id="role-switcher"]', timeout: 8s)` → lee el rol actual del trigger; si ya es el target, skip. Si no, click en `[role="combobox"]` (Radix), click en la option, espera 1.5s para que el sidebar re-renderee con el nav del rol nuevo.
3. `recordScenes()` navega entre módulos via CLICKS en `[data-tour-nav="..."]` del sidebar (SPA navigation — NO recarga, preserva el active role que vive en memoria del módulo `active-role-signal.ts`, sin localStorage). Para rutas no presentes en el sidebar del rol activo (ej. `/app/messages` cross-rol, `/app/trash`), fallback a `page.goto()` + `selectActiveRole()` para re-seleccionar.

Si el active role se pierde entre scenes, el video del Docente termina mostrando el sidebar del Admin — bug reportado en el primer round antes del fix de SPA navigation.

### `ffmpeg` de Playwright es minimal

Playwright bundle-ea su propio `ffmpeg` en `~/.cache/ms-playwright/ffmpeg-*/`, pero ese build es solo para muxing VP8/VP9 (lo que graba) y NO incluye `libx264` ni `-preset`. Para convertir a MP4 hay que instalar ffmpeg standalone (`winget install ffmpeg`). HeyGen acepta `.webm` directo, así que la conversión es opcional.

## Estado actual del proyecto (snapshot 2026-06-08)

### Migraciones críticas recientes (verificar que están en main + Lovable Publish)

- `20260906000000_handle_new_user_tolerate_unique.sql` — fix del bulk import 500 "Database error creating new user". Permite re-vincular profiles huérfanos.
- `20260907000000_platform_settings_support_emails.sql` — tabla `platform_settings` (SA-only) + `support_emails_enabled` toggle + predicate `_notification_kind_emails` extendido con `kind='support'`.
- `20260908000000_gc_storage_policies_super_admin.sql` — las 4 policies de `generated-contents` bucket extendidas con `OR is_super_admin()`.
- `20260909000000_course_enrollments_on_update_cascade.sql` — FK `course_enrollments.user_id` con `ON UPDATE CASCADE` (necesario para que la re-vinculación del handle_new_user no falle).
- `20260910000000_email_settings_super_admin_update.sql` — policy `email_settings_update_admin` extendida con `OR is_super_admin()` para que el SA pueda editar.

### Tests

- `bun test` corre 81 archivos, 1415 tests (target). Algunos tests requieren jsdom (`document is not defined` con el runtime bun puro — siempre usar el runner vitest).
- Tests pure helpers: `src/modules/sessions/csv.ts`, `src/modules/contents/upload-external-helpers.ts`, `src/shared/lib/roles.ts`, `src/modules/onboarding/tour-config.ts`. Si necesitás testear un helper nuevo, extraelo del componente React a su propio módulo y agregale tests sin mocks de DOM.

### Pendiente (no urgente)

- Pegar URLs de los MP4 finales de HeyGen en `src/modules/onboarding/tour-config.ts` (los 3 `videoUrl: null` con TODO).
- Considerar agregar regla ESLint `import/extensions: ["error", "always"]` — para forzar extensión explícita en imports y prevenir regresión del bug TanStack tsr-split que requería `from "@/modules/sessions/csv.ts"` con extensión.

## Política de comentarios

Esto codifica los criterios que usamos para decidir qué comentarios escribir, qué borrar y qué dejar en paz. Pensado para reducir ruido sin perder contexto load-bearing.

**Escribir un comentario solo cuando el WHY no es derivable del código:**

- Un workaround a un bug externo (ej. `BGRX` en Pillow porque Xvfb depth-24 expone padding como alpha)
- Una decisión arquitectónica que tiene alternativas obvias y las descartamos (ej. "duplicado a propósito acá para no acoplar 2 rutas sobre concepto puramente UI")
- Una invariante que cruza archivos / lenguajes (ver lista abajo)
- Una restricción de dominio/negocio que no es evidente de leer el código

**NO escribir comentarios para:**

- Lo que el código bien-nombrado ya dice (`// guarda en state` antes de `setX(value)`)
- Archaeology de cambios pasados ("Antes era X, ahora Y") cuando X ya no aporta WHY al Y actual
- TODOs hipotéticos sin owner ni timeframe
- Reseñar lo que el commit ya documenta

**Invariantes cross-file que deben mantenerse en sincronía** (cada extremo apunta al otro):

| Archivos                                                                                                                                                                                                                                                                                                                                                                                               | Qué debe coincidir                                                                                                                                   | Riesgo si divergen                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/attendance/attendance-code.ts` ↔ `supabase/migrations/20260507100100_attendance_check_in_pgcrypto_fix.sql` (`compute_attendance_code`)                                                                                                                                                                                                                                                    | Cálculo TOTP-like (sha256 + 7 hex + mod 1M + pad 6)                                                                                                  | Docente y server difieren → check-in rechazado                                                                                                                                            |
| `src/modules/notifications/notification-email.ts` ↔ `supabase/functions/send-email/index.ts` (`shouldSendEmail` interno) ↔ SQL `_notification_kind_emails`                                                                                                                                                                                                                                             | Predicado "este kind+link emaila"                                                                                                                    | Emails se mandan / no mandan inconsistentemente                                                                                                                                           |
| `src/routes/app.forum.$courseId.tsx` (`computeForumState`) ↔ `src/routes/app.forum.$courseId.$forumId.tsx` (`isForumOpen`) ↔ SQL `public.is_forum_open()`                                                                                                                                                                                                                                              | Predicado "foro abierto"                                                                                                                             | UI dice abierto pero RLS rechaza el INSERT, o viceversa                                                                                                                                   |
| `src/shared/lib/format.ts`                                                                                                                                                                                                                                                                                                                                                                             | LOCALE = "es-CO" hardcoded                                                                                                                           | App se ve distinta según OS del usuario (lo que originó la centralización)                                                                                                                |
| `src/modules/tenants/TenantThemeProvider.tsx` (`clearTenantVars`) ↔ `src/shared/components/AppLayout.tsx` (`isSuperAdminCrossTenant` + gates de logo/label/quota)                                                                                                                                                                                                                                      | Definición de "SuperAdmin cross-tenant puro": `activeRole === "SuperAdmin" && !readTenantOverride()`                                                 | Branding del tenant queda en cross-tenant, o se quitan vars cuando NO debían quitarse                                                                                                     |
| `supabase/migrations/20260707000000_broadcast_messages_in_inbox.sql` (`app.skip_message_notif`) ↔ `supabase/functions/broadcast-course-message/index.ts` (`insert_broadcast_messages`)                                                                                                                                                                                                                 | Nombre del GUC + lógica de skip del trigger `tg_notify_new_message`                                                                                  | Renombrar el GUC en uno sin actualizar el otro → broadcast vuelve a duplicar notifs + emails                                                                                              |
| `src/modules/messaging/broadcast.ts` (`normalizeCourseIds`, `dedupeRecipients`, `canonicalConvPair`, `buildBroadcastBody`, `humanizeTags`) ↔ `supabase/functions/broadcast-course-message/index.ts` (réplicas inline) ↔ `supabase/migrations/20260709000000_scheduled_messages.sql` (`dispatch_scheduled_messages` replica dedup + canonical pair + humanize en PL/pgSQL para el broadcast programado) | Normalización de cursos, dedup de alumnos, orden canónico de conversación, formato 📢 + truncado a 4000, humanización de tags `[[T:...]]` → `#label` | Lógica divergente → broadcast (inmediato o programado) manda duplicados, viola el CHECK de `messages.body`, muestra tokens crudos en notif/correo, o interpreta distinto el set de cursos |
| `src/modules/messaging/message-tags.ts` (`buildTagToken`/`parseMessageBody` regex) ↔ `src/modules/messaging/broadcast.ts` (`humanizeTags` regex) ↔ SQL `dispatch_scheduled_messages` (`regexp_replace`)                                                                                                                                                                                                | Formato del token `[[T:type:id:label]]` (whitelist de tipos + id hex + label sin `]`)                                                                | Cambiar el formato del token en uno sin los otros → tags no se parsean, no se humanizan, o se rompe el chip                                                                               |
| `src/hooks/use-theme.ts` (`STORAGE_KEY` + `EVENT_NAME`) ↔ `src/routes/__root.tsx` (script inline pre-paint que lee `'examlab-theme'`)                                                                                                                                                                                                                                                                  | Nombre de la key en localStorage (`examlab-theme`) + nombre del custom event                                                                         | Cambiar la key en uno sin el otro → el script pre-paint no aplica `.dark` (flash) o el tema se desincroniza entre instancias                                                              |
| `supabase/functions/ai-generation-worker/index.ts` (`isTransientError`) ↔ `supabase/migrations/20260601001000_*` (regex en `complete_ai_grading` SQL)                                                                                                                                                                                                                                                  | Regex que detecta errores transitorios reintenttables (429, 5xx, rate.limit, timeout, ECONN\*, fetch.failed, quota.exceeded, etc.)                   | Divergen → grading reintenta un error que generación marca failed final (o viceversa). UX inconsistente entre las dos colas                                                               |
| `src/modules/onboarding/tour-config.ts` (selectores CSS `[data-tour-nav="..."]` / `[data-tour-id="..."]`) ↔ `src/shared/components/AppLayout.tsx` (atributos `data-tour-nav={item.to}` en nav.map + `data-tour-id="brand|role-switcher|user-info|notifications-bell|messages-bell|more-options|logout"` en sidebar)                                                                                                | Conjunto de anclajes del tour guiado: el path del ítem nav o el nombre del data-tour-id en AppLayout debe coincidir con el selector en tour-config | Renombrar / mover un anchor sin actualizar el otro → el paso se filtra silenciosamente (defensivo en OnboardingTour) y el tour pierde ese punto sin error visible |

**Archivos donde no se debe explicar más de lo que ya está:**

- `routeTree.gen.ts` — autogenerado por TanStack, no tocar
- Migraciones SQL deployadas — son inmutables en el modelo Lovable. Comentarios nuevos no llegan a la DB; solo sirven a quien lea source.

**Cosas que SÍ están bien documentadas en CLAUDE.md (no duplicar inline)**:

- Mobile-first grids, design system, helpers de formato
- Convenciones de código (esta sección + las anteriores)
- Patrones específicos por feature (foros, cron, AI grading, etc.)

## Notas de git

- Al agregar archivos con `$` en el nombre, usar comillas simples:
  ```bash
  git add 'src/routes/app.student.take.$examId.tsx'
  ```
- `git push origin main` después de commit. NO `--force`. Si remote avanzó (Lovable empuja a veces), `git pull --rebase origin main` antes de pushear.
- Warnings tipo "LF will be replaced by CRLF" son normales en Windows — ignorar.

# Optimizaciones — ExamLab

> Revisión de rendimiento/costo/bundle (2026-07-07). Barrido sobre queries DB, render/bundle
> cliente, costo de IA en edges y realtime. Ordenado por impacto/esfuerzo. Los quick wins de bajo
> riesgo YA se aplicaron; los de mayor esfuerzo o que cambian comportamiento de IA quedan
> documentados para aprobación.

## ✅ Aplicadas (quick wins, bajo riesgo — sin cambio de comportamiento)

| # | Optimización | Archivo | Impacto |
|---|---|---|---|
| A1 | **Monitor de examen: reload debounceado + poll 10s→60s.** El canal de `submissions` (event `*`) llamaba `load()` (4 queries) sin debounce en cada autosave de cada alumno (~1.5s) → tormenta de queries en examen en vivo. Ahora agrupa ráfagas en 800ms; el poll es solo fallback a 60s. | `app.teacher.monitor.$examId.tsx` | **Alto** (elimina decenas de queries/seg durante exámenes) |
| A2 | **Inbox de mensajes: fusionar 2 queries en 1.** Por conversación hacía `select(id,sender_id,created_at)` + una 2ª `select(*) limit 1` redundante para el body. Ahora una sola query trae los campos de MessageLite; `recent[0]` es el último mensaje. | `app.messages.tsx` | **Alto** para usuarios con muchas conversaciones (2N→N queries) |
| A3 | **OnboardingTour (driver.js) lazy.** driver.js + su CSS se bundleaban en el shell de cada `/app/*`. Ahora `lazy()` + gate `shouldShowFor \|\| manual` → el chunk carga solo cuando corre un tour. | `AppLayout.tsx` | Medio (bundle del shell) |
| A4 | **AttendanceQRScanner (html5-qrcode, ~200 KB) lazy.** Se bundleaba en la ruta de Asistencia; ahora carga solo al abrir el escáner (uso ocasional, hay fallback manual). | `app.student.attendance.tsx` | Medio (bundle de una ruta común) |
| A5 | **Service worker cachea `.jar`/`.wasm`.** El regex de assets omitía `.jar` → CheerpJ re-bajaba `tools.jar` (~18 MB) cada sesión para Java-GUI. | `public/sw.js` | Medio (para estudiantes de Java-GUI) |
| A6 | **Verificación DB: índices RLS-hot OK.** Las columnas que golpean las RLS nuevas (`course_enrollments`, `course_teachers`, `*_assignments`, `forum_upvotes`) ya tienen índices compuestos → los `EXISTS` no hacen seq scan. Sin acción necesaria. | — | (confirmado sano) |

tsc EXIT=0. Cliente/SW → requieren Publish.

## ⏳ Recomendadas — cambian comportamiento de IA (validar antes de aplicar)

- **AI-1 · Apagar "thinking" de Gemini + cap `max_tokens` en el path compartido** (`_shared/ai-model.ts`,
  `aiChatCompletionFailover`). Hoy el payload es solo `{ model, messages }` — sin `max_tokens` ni control
  de reasoning. Gemini 2.5 Flash factura tokens de "thinking" (invisibles) al precio de salida; en ops
  cortas (tutor, evaluate-exam-time, plagio, soporte) puede ser varias× el output visible. **Alto ahorro,
  pero NO tocar `ai-grade-submission`** (la calidad de calificación depende del razonamiento). Propuesta:
  `reasoning_effort:"none"` + `maxTokens` solo para los edges de bajo riesgo, dejando grading intacto.
  **Requiere validar calidad con calificaciones reales antes de mergear.**
- **AI-2 · Tier "lite" para ops baratas** (`gemini-2.5-flash-lite`). El `modelOverride` ya existe pero
  nadie lo pasa. tutor-chat (alto volumen), evaluate-exam-time, support-ai-suggest, platform-support-chat
  y el triage de detect-plagiarism podrían usar flash-lite (materialmente más barato); grading se queda
  en flash/pro. Combinado con AI-1 el ahorro compone. Requiere `ai_model_settings.model_lite` o un mapa
  por función. **Validar que la calidad del tutor no se degrade.**
- **AI-3 · Context caching del material del tutor** (`tutor-chat/index.ts`): ~6K+ tokens de prefijo
  estable (system + 22 KB de material) se re-facturan por cada mensaje. Usar caching explícito de Gemini
  por versión de contenido, o mantener el prefijo byte-idéntico y primero para maximizar el cache
  implícito. (El cache de extracción docx/pptx→`files[].body` YA funciona — no tocar.)

## ⏳ Recomendadas — mayor esfuerzo (aprobar por lote)

- **OPT-7 · `useAuth` → contexto único.** Hoy es un hook per-componente (~104 sitios); cada instancia
  abre su propio `onAuthStateChange` + 2 queries (`profiles`+`user_roles`). Una página monta ~5-6 →
  ~10-12 queries duplicadas por navegación + refetch simultáneo en cada `TOKEN_REFRESHED` horario.
  Fix: `AuthProvider` en la raíz + `useContext`; la firma pública queda igual (los 104 call-sites no
  cambian). Esfuerzo medio, impacto alto y transversal.
- **OPT-9 · Consolidar notificaciones.** `use-notifications` se monta 3-4× (NotificationBell ×2,
  MessagesFab, dashboard); cada instancia polla 15s + su propio canal realtime (sin dedup real de red).
  Consolidar en una suscripción compartida (contexto/singleton ref-contado). Quick partial: subir el
  poll a 30-60s (realtime cubre el caso normal).
- **OPT-10 · Estadísticas: N×~12 queries.** `app.admin.statistics` corre `loadCourseDataset` (~12 queries)
  por curso en `Promise.all` sin límite → 30 cursos ≈ 360 queries concurrentes por carga/filtro. Fix
  ideal: RPC `admin_course_stats_summary(tenant_id)` (1 fila/curso); interino: batchear con `.in("course_id", ids)`.
- **OPT-12 · Grading de proyectos: `storage.list` por (entrega × archivo-ZIP).** `app.teacher.projects`
  hace `#entregas × #slots-ZIP` round-trips a Storage al abrir el dialog. Fix: `list` una vez por prefijo
  `<root>/<sub.id>`, o persistir `zip_path` en DB al entregar.

## ⏳ Secundarias (barrido futuro, menor prioridad)

- `select("*")` + paginación client-side en tablas que crecen: `app.admin.users` (todos los profiles),
  `app.certificates`. Mover a `.range()` server-side + columnas explícitas.
- Canal realtime de mensajes se re-suscribe al cambiar de conversación (`app.messages.tsx`, `activeConvId`
  en deps). Leerlo de un ref y keyar el canal por `[myUserId]` (mismo patrón que `use-realtime-timer`).
- Conteos de destinatarios de difusión: N count-queries acotadas (~20 cursos) → una `.in()` + count en JS.

## ✔️ Verificado sano (no requiere acción)

Excalidraw, pptxgenjs/jspdf: `await import()` lazy correcto. Monaco: CDN vía `@monaco-editor/react` (no
bundle). recharts/xlsx: route-split o hand-rolled. Paneles de cola IA, `use-poll-realtime`,
`use-kahoot-game`, `WhiteboardEditor` y los `useMemo` de grids grandes: estabilizados/debounceados/paginados.
Cache de re-extracción del material del tutor: funciona como documentado.

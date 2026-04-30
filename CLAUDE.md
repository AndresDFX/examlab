# ExamLab — Claude Context

## Plataforma y despliegue

- **Hospedado en Lovable** (lovable.dev). Lovable gestiona Supabase automáticamente.
- El usuario **NO tiene acceso directo al dashboard de Supabase**.
- Flujo de despliegue: `git push origin main` → usuario da click en **Publish** en Lovable.
- Las migraciones van en `supabase/migrations/*.sql` — Lovable las aplica en Publish.
- Remote git: `git@github-vivetori:vivetori/examlab.git` (nombre: `origin`)

## Stack

- React 18 + TanStack Router v1 + TypeScript
- UI: shadcn/ui (Card, Button, Badge, Dialog, Alert…)
- DB: Supabase (PostgreSQL + RLS)
- i18n: react-i18next
- Offline: idb-keyval (IndexedDB)
- Toast: sonner

## Archivos clave

| Archivo | Propósito |
|---------|-----------|
| `src/routes/app.student.take.$examId.tsx` | Pantalla de toma de examen (estudiante) |
| `src/routes/app.student.exams.tsx` | Lista de exámenes del estudiante |
| `src/routes/app.student.review.$examId.tsx` | Revisión de resultados |
| `src/integrations/supabase/types.ts` | Tipos generados de Supabase |
| `src/lib/offline-sync.ts` | IndexedDB sync (`clearLocalAnswers`, `setupOfflineSync`) |
| `src/hooks/use-realtime-timer.ts` | Timer del examen (solo inicializa una vez cuando `initialSeconds > 0`) |
| `src/utils/proctoring.ts` | `MAX_WARNINGS=3`, `warningLabel`, `shouldMarkSuspicious` |

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

### Navegación secuencial (forzada para todos los exámenes)
```ts
const visible = [questions[currentIdx]].filter(Boolean); // siempre 1 pregunta
```
Los botones siempre son Anterior / Siguiente / Finalizar, sin importar `exam.navigation_type`.

### Timer
Solo `computeSecondsLeft(exam?.end_time)`. El hook `useRealtimeTimer` inicializa una sola vez cuando `initialSeconds > 0`. No intentar calcular tiempo efectivo por estudiante.

### Offline sync
`clearLocalAnswers(examId)` debe llamarse antes de crear una nueva fila de submission, para evitar el toast "X respuesta(s) sincronizada(s)" cuando el docente borra la sesión anterior.

## Notas de git

Al agregar archivos con `$` en el nombre, usar comillas simples:
```bash
git add 'src/routes/app.student.take.$examId.tsx'
```

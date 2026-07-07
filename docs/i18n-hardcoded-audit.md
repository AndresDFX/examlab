# Auditoría i18n — hardcoded Spanish (2026-07-07)

Audit exhaustivo (workflow, 8 finders): **262 strings user-facing hardcodeados en español** en 63 archivos. El app es es-first; el inglés no cubría estas pantallas.

**Seguridad del fix**: cada string → `t("clave", { defaultValue: "<español>" })` + clave en es.json (español) y en.json (inglés). El ES no cambia; solo el EN pasa de español→inglés.

## ✅ Lote 1 — hecho (commits d04d678b, 9bf73a37)

26 archivos i18n-izados + ~112 claves. es=en=8037, 0 defaultValue ausentes de en.json, tsc EXIT=0.

## ⏳ Pendiente — lote 2 (36 archivos)

El workflow se cortó por límite de sesión (resetea ~1:20pm Bogotá). Retomar con resumeFromRunId (los agentes OK replay de cache; solo corren los que fallaron):
```
Workflow({ scriptPath: ".../i18n-ize-hardcoded-spanish-wf_834d969a-e1c.js", resumeFromRunId: "wf_17f17f31-6fb", args: [<lista .tsx>] })
```

Archivos pendientes (con # de hallazgos):

- `src/modules/admin/AdminCodeExecutionPanel.tsx` (22)
- `src/shared/components/IntroVideoGate.tsx` (14)
- `src/components/ui/multi-select.tsx` (11)
- `src/modules/whiteboard/WhiteboardEditor.tsx` (8)
- `src/shared/components/AssignSelector.tsx` (8)
- `src/modules/whiteboard/WeeklyScheduleView.tsx` (7)
- `src/shared/components/ImportExportMenu.tsx` (7)
- `src/components/ui/list-filters.tsx` (5)
- `src/modules/whiteboard/SessionWhiteboardDialog.tsx` (4)
- `src/modules/whiteboard/TextPageEditor.tsx` (4)
- `src/routes/app.teacher.monitor.$examId.tsx` (3)
- `src/modules/contents/GenerateSessionsDialog.tsx` (3)
- `src/shared/components/DuplicateOptionsDialog.tsx` (3)
- `src/shared/components/ActivityStatusSelect.tsx` (3)
- `src/shared/components/ReopenClosedBanner.tsx` (3)
- `src/shared/components/ThemeToggle.tsx` (3)
- `src/components/ui/date-picker.tsx` (3)
- `src/shared/components/ConfirmDialog.tsx` (2)
- `src/components/ui/search-input.tsx` (2)
- `src/components/ui/loaders.tsx` (2)
- `src/components/ui/hex-color-input.tsx` (2)
- `src/components/ui/password-input.tsx` (2)
- `src/modules/messaging/message-tags.ts` (1)
- `src/modules/sessions/SessionCodeSnippetsDialog.tsx` (1)
- `src/modules/contents/MarkdownEditorDialog.tsx` (1)
- `src/modules/contents/EditExternalContentDialog.tsx` (1)
- `src/modules/exams/proctoring.ts` (1)
- `src/modules/contents/content-display-name.ts` (1)
- `src/modules/contents/session-plan.ts` (1)
- `src/shared/components/MeetingLink.tsx` (1)
- `src/components/ui/empty-state.tsx` (1)
- `src/components/ui/page-header.tsx` (1)
- `src/components/ui/row-actions-menu.tsx` (1)
- `src/components/ui/badge-overflow.tsx` (1)
- `src/components/ui/course-list-cell.tsx` (1)
- `src/components/ui/spinner.tsx` (1)

### .ts (revisión manual — helpers/constantes, i18n en el punto de uso o son data)
- `src/modules/messaging/message-tags.ts` (1) — TAG_TYPE_LABEL: Taller/Examen/Proyecto/C
- `src/modules/exams/proctoring.ts` (1) — warningLabel(): Salida de pestaña/ventan
- `src/modules/contents/content-display-name.ts` (1) — El nombre no puede estar vacío. / El nom
- `src/modules/contents/session-plan.ts` (1) — Sesión ${i+1} (default session title, re

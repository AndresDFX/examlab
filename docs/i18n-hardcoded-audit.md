# Auditoría i18n — hardcoded Spanish (2026-07-07) — ✅ RESUELTO

Audit exhaustivo (workflow, 8 finders): **262 strings user-facing hardcodeados en español** en 63 archivos.
El app es es-first; el inglés no cubría estas pantallas. **Todos i18n-izados** (2 lotes, workflow de 59 agentes).

**Seguridad del fix**: cada string → `t("clave", { defaultValue: "<español>" })` + clave en es.json (español)
y en.json (inglés). El ESPAÑOL no cambia; solo el inglés pasa de español→inglés.

## Resultado
- **56 archivos .tsx** i18n-izados (lote 1: 26 · lote 2: 30). Commits `d04d678b`, `9bf73a37`, `2e203502`.
- **es.json = en.json = 8230 claves**, 0 faltantes en cualquier lado, 0 `defaultValue` ausentes de en.json,
  0 placeholders `{{}}` desalineados.
- `tsc` EXIT=0 (los 56 archivos compilan). Tests de componentes editados 47/47 (ajustado spinner.test:
  el default reusa `common.loading`).

## Validación estructural previa (limpia)
- Sincronía es↔en perfecta. `t()` sin defaultValue ausentes del catálogo: 0 (las sospechosas eran plurales i18next).
- Placeholders desalineados: 0 reales (FraudPanel pasa `pluralAdj`/`highSuffix` en el código).

## Pendiente menor — 4 archivos .ts (no-componente)
No se pueden i18n-izar con `useTranslation` (hook) — necesitan i18n en el punto de USO o son data:
- `src/modules/exams/proctoring.ts` — `warningLabel()` (labels de proctoring; i18n-izar en el consumidor).
- `src/modules/messaging/message-tags.ts` — `TAG_TYPE_LABEL` (mapa de labels de chips; i18n en el consumidor).
- `src/modules/contents/content-display-name.ts` — mensajes de validación (i18n en el consumidor vía toast).
- `src/modules/contents/session-plan.ts` — "Sesión {i}" (título por DEFECTO de sesión = data editable, no UI chrome).

⚠️ **Deploy**: los commits de i18n se pushearon después del último Publish → requieren **re-Publish** en Lovable
para que el inglés llegue a producción.

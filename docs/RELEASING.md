# Versionado y notas de versión — ExamLab

Estrategia LIGERA para saber, de ahora en adelante, **qué cambió en cada release**.
Se engancha con el `CHANGELOG.md` existente (protocolo `[[changelog-protocol]]`), no lo
reemplaza.

## Esquema de versión: SemVer aligerado

`MAJOR.MINOR.PATCH`. La **unidad de release es el Publish de Lovable** (no el commit).
Arrancamos en **1.0.0** (la app ya está en producción con instituciones reales; 1.0.0 =
"acá empezamos a versionar").

| Bump | Cuándo | Ejemplo |
|------|--------|---------|
| **PATCH** (1.0.0→1.0.1) | el Publish solo trae `fix`/`chore`/`docs`/`refactor` | hotfix |
| **MINOR** (1.0.x→1.1.0) | el Publish incluye ≥1 `feat` (caso más común) | feature nueva |
| **MAJOR** (1.x→2.0.0) | hito que el usuario DEBE notar (rediseño grande, módulo comercial, cambio de paradigma) — raro | "versión de marketing" |

No es SemVer estricto (ExamLab es un SaaS, no una librería con API pública) → por eso "aligerado".

## Fuente de verdad de la versión

1. **git tag** `vX.Y.Z` sobre el commit publicado → es el registro durable de "este commit == esta versión en prod". **El tag manda.**
2. `package.json` → campo `"version"` (copia legible/embebible en el bundle). **Ojo:** tocar `package.json` obliga a `bun install` para regenerar `bun.lock` y commitear **ambos** (el CI valida la sincronía del lockfile).

## Proceso de notas de versión (≈5 min por Publish)

Aprovecha que ya usamos Conventional Commits en español (`tipo(scope): descripción`).

1. Commits desde el último tag:
   ```bash
   git log v<anterior>..HEAD --no-merges --pretty=format:"%s" | grep -E "^(feat|fix)(\(|:)"
   ```
   Solo `feat` y `fix` van a notas de usuario. `docs`/`chore`/`refactor`/`test`/`ci` = ruido interno (no se publican).
2. Agrupar en **🎉 Novedades** (`feat`) y **🔧 Correcciones** (`fix`).
3. Ordenar por SCOPE traducido a área de usuario:

   | scope | área para el usuario |
   |-------|----------------------|
   | sesiones / attendance | Sesiones y asistencia |
   | serverconsole | Consola / terminal |
   | whiteboards | Pizarras |
   | kahoot / polls | Reto en vivo y encuestas |
   | correos / email | Notificaciones por correo |
   | ux | Experiencia de uso |
   | ia / ai | Asistente y calificación IA |
   | i18n / demos / chore | (INTERNO — no publicar) |
4. Reescribir cada subject técnico a **beneficio de usuario, español no técnico**:
   - `feat(sesiones): tipo de sesión (Presencial/Virtual/Autónoma)` → "Ahora cada sesión se marca como Presencial, Virtual o Autónoma; las autónomas avisan a los estudiantes."
   - `fix(ux): no recargar al cambiar de pestaña` → "La app ya no se recarga al cambiar de pestaña (la pizarra y la consola conservan tu trabajo)."
5. Pegar como entrada versionada en el **Historial** del `CHANGELOG.md`, tagear y (opcional) anunciar.

## Formato en el CHANGELOG

`CHANGELOG.md` tiene 3 bloques: **Protocolo de trabajo**, **Decisiones / invariantes vigentes**, **Historial**. Solo el **Historial** se versiona; los otros dos quedan igual (las reglas durables siguen subiéndose a "Decisiones / invariantes", como pide el protocolo).

Cada entrada nueva:

```markdown
## [1.1.0] — 2026-07-24

### 🎉 Novedades
- **Sesiones y asistencia:** cada sesión se marca como Presencial, Virtual o Autónoma; las autónomas notifican a los estudiantes.

### 🔧 Correcciones
- **Experiencia de uso:** la app ya no se recarga al cambiar de pestaña del navegador.

### Interno (equipo)
- Commits: `abc1234`, `def5678`
- Migraciones: `20261490000000`, …
- Notas: requiere Publish en Lovable.
```

Convenciones: fecha `AAAA-MM-DD`, `## [X.Y.Z]` con corchetes (parseable), secciones fijas 🎉/🔧/Interno (omitir las vacías), hashes SOLO en "Interno".

## Rutina por Publish

1. Decidir bump: ¿hay algún `feat` desde el último tag? → MINOR; solo fixes → PATCH; hito → MAJOR.
2. Subir `package.json` a la nueva versión + `bun install` + commit `chore(release): vX.Y.Z`.
3. `git log v<anterior>..HEAD` filtrando feat/fix → redactar Novedades/Correcciones.
4. Agregar la entrada versionada al Historial del CHANGELOG (y subir a "Decisiones/invariantes" cualquier regla durable nueva).
5. `git push origin main` → **Publish** en Lovable → `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Mostrar la versión / novedades en la app (opcional, por fases)

- **Fase 1 (mínimo, ~1h):** inyectar `pkg.version` al bundle con `define: { __APP_VERSION__ }` en `vite.config` y mostrarla en el footer de la landing + el menú del avatar. Cero infra.
- **Fase 2 (recomendada):** pestaña "Novedades" dentro del **Asistente de la plataforma** (`/app/assistant`, ya centraliza ayuda/FAQ/videos) que renderiza un markdown/JSON **bundleado** con las últimas versiones. Sin tabla nueva en DB.
- **Fase 3 (opcional):** modal "¿Qué hay de nuevo?" al subir versión (comparar `__APP_VERSION__` vs `localStorage["examlab_last_seen_version"]`), solo Admin/Docente. Respetar el patrón anti-hidratación (no leer localStorage en el initializer de `useState`).

No usar el sistema de notificaciones (`kind='broadcast'`) para anunciar releases: genera una notif/correo por usuario por versión — demasiado ruidoso para deploy continuo. Reservarlo para hitos MAJOR puntuales.

## Arranque (pendiente, una vez)

- [ ] `package.json`: agregar `"version": "1.0.0"` + `bun install` + commitear `package.json` y `bun.lock`.
- [ ] `git tag v1.0.0 <commit en prod>` + `git push origin v1.0.0`.
- [x] `CHANGELOG.md`: Historial versionado a partir de la entrada de arranque (ver `## [1.1.0]`).
- [ ] (Fase 1 in-app) `__APP_VERSION__` en `vite.config` + versión en footer/avatar.

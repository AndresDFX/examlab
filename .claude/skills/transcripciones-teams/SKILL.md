---
name: transcripciones-teams
description: Baja de Teams web la transcripción (.vtt) y el enlace de la grabación de cada clase ya dictada en la UNIAJC y los deja en la sesión correspondiente de ExamLab (la transcripción alimenta al Tutor IA con lo que dijo el docente; la grabación la ven los estudiantes en sus sesiones). Úsalo cuando el usuario pida «sube las transcripciones», «trae las grabaciones de Teams», «sincroniza las clases de Teams con ExamLab» o «pon las grabaciones en las sesiones».
---

# Transcripciones y grabaciones de Teams → ExamLab

Sin aprobación de TI no hay API de Microsoft, así que esto maneja **Teams web** con la sesión
del docente, como un usuario.

```
node .claude/skills/transcripciones-teams/scripts/sincronizar.cjs --dias 70            # ensayo
node .claude/skills/transcripciones-teams/scripts/sincronizar.cjs --dias 70 --enviar   # sube
```

`--curso <codigo>` limita a un curso de `cursos.json`.

## Cómo funciona
- Recorre la app **«Resúmenes de reuniones»** de Teams (fijada en la barra lateral): lista solo
  las reuniones con grabación o transcripción, con título y fecha. El calendario no sirve: el
  diálogo de una instancia no deja elegir otras fechas.
- Cruza cada resumen con la sesión de ExamLab del **mismo curso y la misma fecha** (`cursos.json`:
  `titulo` es un fragmento del título de la reunión). Un parcial movido de día no se empareja:
  sale en la tabla como «sin sesión en ExamLab ese día».
- Transcripción: botón «Descargar» → `.vtt` → acción `upload_transcript` del edge `calendar`
  (idempotente por hash). Grabación: «Ver en el explorador» → enlace de SharePoint sin parámetros
  de rastreo → `attendance_sessions.recording_url` (solo si estaba vacío).
- Actúa como el docente (SuperAdmin de `.env.uniajc` + `admin-impersonate`). La sesión de Teams
  vive en `privado/teams-perfil`; si caduca, pide iniciar sesión en la ventana (o usa
  `TEAMS_USUARIO` / `TEAMS_CLAVE` de `.env.uniajc` si existen). Lo subido queda en
  `privado/transcripciones-teams/registro.jsonl` y los `.vtt` en esa misma carpeta.

## Trampas
- Teams escribe los acentos como entidades (`Casta&#241;o`); el lector de VTT las decodifica. Sin
  eso el docente no se reconoce y `teacher_text` queda vacío.
- La lista de resúmenes no trae el año: se asume el del semestre.
- `cursos.json` se actualiza cada semestre.

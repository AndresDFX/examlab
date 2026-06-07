# Recordings — backgrounds para HeyGen

Videos generados por `scripts/record-tour.ts` recorriendo la app real
(https://examlab.lovable.app) con la cuenta del tenant FESNA.

## Archivos

| Archivo | Rol | Duración | Scenes | Tamaño |
|---|---|---|---|---|
| `admin.webm` | Admin | ~75s | 12 módulos (dashboard, users, courses, académico, certificados, prompts IA, cola IA, estadísticas, auditoría, soporte, papelera, configuración) | 4.2 MB |
| `teacher.webm` | Docente | ~115s | 17 módulos (dashboard, mis cursos, banco preguntas, exámenes, talleres, proyectos, calificaciones, asistencia, pizarras, encuestas, contenidos, calendario, mensajes, estadísticas, cron IA, auditoría, papelera) | 7.4 MB |
| `student.webm` | Estudiante | ~90s | 15 módulos (dashboard, mis cursos, exámenes, talleres, proyectos, calificaciones, asistencia, contenidos, encuestas, pizarras compartidas, calendario, biblioteca videos, tutor IA, retroalimentación, certificados) | 12 MB |

## Regenerar

```bash
# Desde la raíz del repo:
node --experimental-strip-types scripts/record-tour.ts --role=admin
node --experimental-strip-types scripts/record-tour.ts --role=teacher
node --experimental-strip-types scripts/record-tour.ts --role=student

# Después copiar a este dir con nombres limpios sin timestamp:
cp recordings/admin-*.webm docs/heygen/recordings/admin.webm
cp recordings/teacher-*.webm docs/heygen/recordings/teacher.webm
cp recordings/student-*.webm docs/heygen/recordings/student.webm
```

`recordings/` (raíz) está en `.gitignore` — es el output dir efímero
del script con archivos timestamped. Los videos finales versionados
viven acá en `docs/heygen/recordings/` con nombres limpios.

## Usar en HeyGen

1. HeyGen → **Create video** → **Custom video**.
2. **Background**: subí el `.webm` que corresponda al rol.
3. **Script**: pegá el contenido del `> Script` de `../admin.md` / `../docente.md` / `../estudiante.md`.
4. **Avatar**: elegí uno (recomendaciones en cada `.md`).
5. **Voice**: español neutro o es-CO.
6. Render → descargar el MP4 final.
7. Pegá la URL del MP4 final en `src/modules/onboarding/tour-config.ts` (campo `videoUrl` del `ADMIN_TOUR_META` / `TEACHER_TOUR_META` / `STUDENT_TOUR_META`).

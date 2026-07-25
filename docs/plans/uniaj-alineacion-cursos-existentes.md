# Uniaj — Revisión de alineación de cursos existentes con los features nuevos

> Generado 2026-07-25. Tenant **Uniaj**. **No destructivo**: es una revisión/recomendación; NO se modificaron los cursos finalizados (decisión "solo el curso nuevo").

## Cursos existentes revisados

| Curso | Estado | Sesiones | Tipos de sesión | Retos en vivo | Contenidos | Pizarras |
|---|---|---|---|---|---|---|
| Programación II-341C (2026-1) | **finalizado** | 3 | 3 virtual, 0 presencial, 0 autónoma | 0 | 0 | 0 |
| Seminario de Sistemas-341C | **finalizado** | 3 | 3 virtual, 0 presencial, 0 autónoma | 0 | 0 | 0 |

Ambos son **registros históricos cerrados** (periodo 2026-1, `status='finalizado'`, con estudiantes y notas ya consolidadas).

## Principio de alineación

Para un curso **finalizado**, "alinear con los features nuevos" **no** significa mutar el registro histórico (romper la trazabilidad de un periodo cerrado), sino: (a) verificar que ningún feature nuevo lo dejó inconsistente, y (b) asegurar que la **próxima versión** adopte los features. La versión **Programación II 2026-2** creada en este trabajo ya materializa (b).

## Gap-analysis por feature nuevo

| Feature nuevo | Estado en los cursos finalizados | Recomendación |
|---|---|---|
| **Tipos de sesión** (presencial/virtual/autónoma) | Todas las sesiones quedaron `virtual` (default retro de la migración `20261480000000`). | **No tocar.** El curso ya pasó; reclasificar sesiones históricas no aporta. La versión 2026-2 clasifica sesiones al crearlas. |
| **Retos en vivo (Kahoot)** | 0 en ambos. | **No tocar** (estudiantes ya salieron). La versión 2026-2 ya trae **3 retos**. |
| **Papelera (soft-delete)** | Aplica a nivel plataforma; ambos cursos `deleted_at IS NULL`. Sin inconsistencia. | Ninguna acción. |
| **Consola v86 / hojas código-consola en pizarra** | 0 pizarras. | N/A para curso cerrado. |
| **Contenidos ejecutables + Tutor IA** | 0 contenidos. | N/A retroactivo; sembrar contenidos en la 2026-2 si se desea Tutor IA. |
| **Sesiones autónomas + notificación** | N/A (curso cerrado; nadie a notificar). | Adoptar en cursos activos. |
| **Modelo de pesos por corte** | Ambos ya usan `grade_cuts` (3 cortes). **Consistentes.** | Ninguna acción. |
| **Duplicar parametrizable / orden por columna / paginación / filtros por estado** | Son UI a nivel plataforma (no datos por curso). | Ya disponibles automáticamente. |

## Conclusión

- **Ningún feature nuevo dejó a los cursos finalizados en estado inconsistente** — no hay nada que "reparar".
- La alineación con valor real es **hacia adelante**: la nueva versión **Programación II-341C · 2026-2** ya incorpora tipos de sesión, retos en vivo y el modelo de cortes actualizado.
- **Recomendación de política**: no mutar cursos `finalizado` (preservar el histórico); alinear creando la **nueva versión por periodo** (como se hizo), que nace con todos los features.
- Si en el futuro se quisiera adoptar un feature en un curso **activo** (no finalizado) — p. ej. Seminario de Sistemas 2026-2 —, aplican los mismos pasos que se usaron para Programación II 2026-2 (clonar estructura + agregar retos en vivo).

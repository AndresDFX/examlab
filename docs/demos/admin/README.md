# Serie de demos en video — Rol Administrador

Serie de videos cortos e independientes que documentan, paso a paso, el rol
**Administrador** de ExamLab. Cada módulo es un video autónomo (intro + cuerpo +
outro) pensado para unirse después en una serie continua.

- **Tenant sandbox para toda la serie:** `Demo Global Corp` (institución limpia,
  provisionada por el SuperAdmin de la plataforma). El usuario que graba es un
  Administrador que pertenece **únicamente** a ese tenant.
- **Tono de voz:** serio, profesional, demostrativo-educativo. **Cero lenguaje
  comercial / de ventas.**
- **Resolución:** 1920×1080 · cursor visible · tema claro (salvo que el módulo
  indique lo contrario).

## Regla transversal (obligatoria en TODOS los módulos)

En cada video, voz + visual deben hacer **evidente** que:

1. **Aislamiento multi-tenant** — el Admin solo ve y opera datos de
   *Demo Global Corp*. Los listados, conteos y la auditoría están acotados a la
   institución (lo garantiza la RLS por `tenant_id`). Nunca aparecen datos de
   otra institución.
2. **Separación de roles (RBAC)** — el menú lateral y las acciones disponibles
   reflejan exactamente lo que el rol Administrador permite. Nunca se muestran
   herramientas propias de otros roles (Docente/Estudiante) ni operaciones
   cross-tenant (esas son del SuperAdmin).

Cada guion incluye al menos un *beat* explícito de cada punto.

## Convenciones visuales del guion (para el editor)

Los guiones usan esta notación abreviada:

| Notación | Significado |
|---|---|
| `ZOOM-IN(objeto, %)` / `ZOOM-OUT` | Paneo/acercamiento suave (~600 ms, ease-in-out) hacia el objeto. |
| `CURSOR→(objeto)` | Mover el ratón con trayectoria visible hasta el objeto. |
| `CLICK(objeto)` | Clic con **efecto ripple** + leve “pop”. |
| `HIGHLIGHT(objeto)` | Oscurecer el resto de la pantalla al ~55 % y mantener nítido el objeto (spotlight). |
| `LOWER-THIRD("texto")` | Rótulo inferior discreto. |
| `PAN(de → a)` | Desplazamiento de cámara entre dos puntos. |

Principios de ritmo: acercamiento cuando la voz nombra un botón/dato; soltar
(zoom-out) al cambiar de tema; resaltar (dim) cuando se introduce un campo o área
nueva; el cursor siempre precede al clic.

## Índice de módulos

| # | Módulo | Ruta principal | Beat multi-tenant / RBAC |
|---|---|---|---|
| 1 | [Acceso multi-tenant y Dashboard General](modulo-01-acceso-y-dashboard.md) | `/auth` → `/app` | Acceso segmentado por institución; dashboard solo de *Demo Global Corp* |
| 2 | [Gestión de Usuarios y Roles (RBAC)](modulo-02-usuarios-y-roles.md) | `/app/admin/users` | Altas dentro del tenant; los roles definen qué ve cada usuario |
| 3 | [Estructura Académica](modulo-03-estructura-academica.md) | `/app/admin/academic` | Catálogo académico propio de la institución |
| 4 | [Gestión de Cursos](modulo-04-cursos.md) | `/app/admin/courses` | Cursos/matrículas del tenant; docentes asignables de la institución |
| 5 | [Contenidos y Biblioteca de Videos](modulo-05-contenidos-y-videos.md) | `/app/teacher/contents`, `/app/videos` | Repositorio de material del inquilino |
| 6 | [Configuración de IA (Prompts · Modelo · Cola)](modulo-06-configuracion-ia.md) | `/app/admin/ai-prompts`, `/app/admin/ai-cron` | Política de IA por institución |
| 7 | [Configuración del Tenant](modulo-07-configuracion-tenant.md) | `/app/admin/settings` | Branding, cuotas, visibilidad de módulos, API key, correos — todo del propio tenant |
| 8 | [Certificados](modulo-08-certificados.md) | `/app/certificates` | Certificados ligados a cursos del tenant |
| 9 | [Estadísticas e Informes](modulo-09-estadisticas-e-informes.md) | `/app/admin/statistics`, `/app/admin/report-templates` | Analítica acotada a la institución |
| 10 | [Auditoría, Soporte (PQRS) y Papelera](modulo-10-auditoria-soporte-papelera.md) | `/app/admin/audit-logs`, `/app/admin/support`, `/app/trash` | Auditoría solo del tenant; soporte = canal Admin→plataforma |
| 11 | [Cuenta, Notificaciones y Cierre de Sesión](modulo-11-cuenta-y-sesion.md) | footer del sidebar | El selector de rol materializa el RBAC; logout limpia el contexto del tenant |

## Estado

| Módulo | Guion | Grabado | Voz / avatar | Montaje final |
|---|---|---|---|---|
| 1–11 | ✅ Redactado | ⏳ | ⏳ | ⏳ |

> Orden lógico de la serie: ingreso (1) → personas (2) → estructura académica (3)
> → cursos (4) → contenido (5) → IA (6) → configuración (7) → resultados y
> gobierno (8–10) → cierre (11).

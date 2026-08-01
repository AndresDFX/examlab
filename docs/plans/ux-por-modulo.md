# Programa de UX módulo por módulo

> Complementa [`ux-mejoras.md`](ux-mejoras.md), que fue una auditoría puntual con 10 problemas.
> Esto es el **programa continuo**: un estado por módulo, medido con el mismo criterio siempre, para
> saber qué queda y poder retomarlo sin re-descubrir nada.

## Método

Los checks mecánicos se corren con un script sobre las **46 rutas** que
[`NAV_PATH_TO_MODULE`](../../src/shared/lib/module-catalog.ts) mapea a los **31 módulos** del
catálogo. Cada check corresponde a uno ya escrito en [`CLAUDE.md`](../../CLAUDE.md), así que el
resultado se compara contra el estándar del propio repo y no contra un criterio inventado:

| Check | Qué verifica |
|---|---|
| **P1** | `container mx-auto` o padding de página en la ruta (el shell ya lo pone) |
| **P2** | `text-[Npx]` arbitrario en vez de los tokens `text-xs` / `text-2xs` / `text-3xs` |
| **P3** | Ícono de `PageHeader` con un hue crudo, que pisa el color de la institución |
| **R2** | `grid-cols-N` sin variante responsive en el **mismo** `className` |
| **R5** | `vh` en vez de `dvh` (la barra de URL de iOS) |
| **Táctil** | Elemento interactivo con alto declarado < 32px |
| **HTML** | `<button>` anidado dentro de otro `<button>` |

Dos cosas que el script **no** puede decidir y por eso van a revisión manual: la jerarquía de
acciones (P4) y si una fila o card debe ser la puerta a su entidad (P5). Eso pide leer la pantalla.

## Estado mecánico: limpio

**0 hallazgos en los 30 módulos con ruta.** Es el resultado de las tandas anteriores; el valor de
tenerlo medido es que ahora una regresión se nota.

Tres falsos positivos que el script tuvo y que conviene no volver a perseguir:

- **`grid-cols-2` en un `TabsList`** no es una violación de R2. Dos o tres pestañas lado a lado es lo
  correcto; apilarlas sería peor. R2 existe para que las columnas de **contenido** no queden
  ilegibles. El script ahora las excluye.
- **`grid-cols-N` base junto a su variante responsive** en el mismo `className` daba 10 hits falsos.
  El check ahora exige que NO haya ninguna variante `sm:`/`md:`/`lg:`/`xs:` en esa misma clase.
- **Un `h-3` dentro de un botón** suele ser el ícono, no el botón. Hay que mirar si el botón declara
  su propio alto o padding.

## Lo que queda: densidad de columnas (P7)

P7 pide **≤ 8 columnas visibles en `lg`**. Medido por bloque `<TableHeader>`, no por archivo — un
archivo puede tener 3 tablas y el número sumado no dice nada:

| Grid | Total | Visibles en móvil | Estado |
|---|---|---|---|
| `exams` — [app.teacher.exams.index.tsx:881](../../src/routes/app.teacher.exams.index.tsx) | **12** | 4 | pendiente |
| `tenants` — [app.superadmin.tenants.tsx:1025](../../src/routes/app.superadmin.tenants.tsx) | 9 | 6 | pendiente |
| `users` — [app.admin.users.tsx:1900](../../src/routes/app.admin.users.tsx) | 9 | 5 | pendiente |
| `workshops` — [app.teacher.workshops.tsx:3063](../../src/routes/app.teacher.workshops.tsx) | 9 | 4 | pendiente |
| `projects` — [app.teacher.projects.tsx:2613](../../src/routes/app.teacher.projects.tsx) | 9 | 4 | pendiente |

**El móvil ya está bien resuelto en todos**: 4-6 columnas visibles gracias al ocultamiento
progresivo. Lo que falta es la densidad en pantalla grande, y el síntoma es el que describe el
problema 7 de `ux-mejoras.md`: con `table-fixed` y 12 columnas, el **título** —el dato que identifica
la fila— se comprime a ~18 caracteres.

## Revisión manual por módulo

Estado del recorrido. Un módulo se marca hecho cuando se revisó su jerarquía de acciones (P4), si sus
filas son puertas (P5) y su flujo, no solo cuando pasa los checks mecánicos.

| Módulo | Mecánico | Revisión manual | Qué se hizo / qué falta |
|---|---|---|---|
| `messages` | ✅ | ✅ | Botones anidados en la fila de conversación (HTML inválido) → la casilla en modo selección pasó a indicador con `aria-pressed` en la fila, y el checkbox de hover salió como hermano absoluto. Falta: `hover:bg-muted/40` vs `hover:bg-accent` de P5 (visual, toda la bandeja) |
| `attendance` | ✅ | ✅ | Diálogo de check-in con Escape, foco al abrir, trampa de Tab y restauración; `aria-modal` recuperado. Falta: migrarlo al `Dialog` del design system (pide prueba con cámara en dispositivo) |
| `workshops` | ✅ | 🔶 | Formulario agrupado en 3 secciones (P8); 2 encabezados colapsables pasaron de ~16px a 32px táctiles. Falta: grid de 9 columnas |
| `exams` | ✅ | 🔶 | Formulario agrupado en 3 secciones (P8). Falta: grid de **12** columnas — el peor del programa |
| `contents` | ✅ | 🔶 | Celda de nombre con `flex-1` y badges que ya no le roban ancho; 3 columnas con ocultamiento progresivo. Falta: partir los 14 ítems del menú de fila |
| `gradebook` | ✅ | 🔶 | Encabezado fijo (`sticky`) + región acotada, tinte de corte de 4 a 6 tonos. Falta: decidir si orden/paginación aplican a una superficie de EDICIÓN |
| `grades` | ✅ | 🔶 | Selector de curso a ancho completo en móvil, columna Peso oculta en móvil. Falta: P4 — es pantalla de lectura, 0 botones primarios; documentar como excepción |
| `users` | ✅ | ⬜ | Diálogo a `sm:max-w-2xl`, grid de 3 columnas con `xs:`. Falta: grid de 9 columnas; 2 campos de contraseña sin `PasswordInput` |
| `dashboard` | ✅ | ⬜ | Bloqueado: §4.1 y §4.2 del plan piden **dos decisiones de producto** (si el ranking del Reto sale del inicio del alumno; si el calendario de mes se reduce a una tira de 7 días) |
| `projects` | ✅ | ⬜ | Falta: grid de 9 columnas; cards que no son puerta (P5) |
| `tenants` | ✅ | ⬜ | Falta: grid de 9 columnas |
| Los otros 19 | ✅ | ⬜ | Sin hallazgos mecánicos; falta el pase de flujo |

## Cómo retomarlo

1. Correr el script de checks mecánicos. Si algún módulo dejó de estar en 0, es una regresión y va
   primero.
2. Seguir por el frente de P7 en el orden de la tabla (arranca por `exams`, 12 columnas).
3. Para cada módulo, la revisión manual mira lo que el script no ve: ¿hay **una** acción primaria
   sobre el pliegue? ¿la fila entera es la puerta a su entidad? ¿el formulario está agrupado si pasa
   de 8 campos?

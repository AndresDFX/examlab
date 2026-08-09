# Universidades — contenido fuente como submódulos

Cada subcarpeta de `universidades/` es (o será) un **submódulo de Git** que apunta al repo
real de esa universidad, siguiendo su rama `main`. Ver la sección "Contenido académico de
universidades" en el [`CLAUDE.md`](../CLAUDE.md) de la raíz para el propósito completo y las
reglas de uso.

No edites nada dentro de estas carpetas desde Examlab. No corras `git submodule add`/`update`
a mano: usá `scripts/update-universidades.sh`.

## Estado

| Universidad | Repo | Estado |
|---|---|---|
| CUN | `https://github.com/AndresDFX/CUN` | ⏳ **Pendiente** — el repo existe pero no tiene ningún commit todavía. |
| UNIAJ | `https://github.com/AndresDFX/UNIAJ` | ⏳ **Pendiente** — el repo existe pero no tiene ningún commit todavía. |

### Por qué están pendientes

Un submódulo de Git referencia un **commit concreto** de la rama seguida; un repo sin commits
no tiene ninguno al que apuntar, así que `git submodule add -b main <url> universidades/<nombre>`
falla con `fatal: 'origin/main' is not a commit`. No es un problema de URL ni de permisos —
ambos repos son accesibles — es que están vacíos.

### Cómo se destraba

En cuanto CUN o UNIAJ tengan un primer commit en `main` (subido desde DENTRO de cada repo, no
desde acá), correr una vez por universidad:

```bash
git submodule add -b main https://github.com/AndresDFX/CUN universidades/CUN
git submodule set-branch --branch main universidades/CUN
git add .gitmodules universidades/CUN
git commit -m "chore: agregar universidades/CUN como submódulo"
```

(análogo para UNIAJ). De ahí en adelante, `scripts/update-universidades.sh` las mantiene al
día automáticamente.

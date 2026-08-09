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
| CUN | `https://github.com/AndresDFX/CUN` | ✅ Conectada como submódulo, sigue `main`. |
| UNIAJ | `https://github.com/AndresDFX/UNIAJ` | ✅ Conectada como submódulo, sigue `main`. |

Para traer lo más nuevo de cada una: `scripts/update-universidades.sh`.

### Si se agrega una universidad nueva

Cuando el repo de la universidad ya tenga al menos un commit en `main` (un submódulo referencia
un commit concreto — no se puede agregar un repo vacío), correr una vez:

```bash
git submodule add -f -b main https://github.com/AndresDFX/<Nombre> universidades/<Nombre>
git submodule set-branch --branch main universidades/<Nombre>
git add .gitmodules universidades/<Nombre>
git commit -m "chore: agregar universidades/<Nombre> como submódulo"
```

El `-f` es necesario porque `universidades/*/` está en `.gitignore` (para no levantar ruido de
archivos sueltos) — no bloquea al submódulo una vez agregado, solo el `add` inicial. De ahí en
adelante, `scripts/update-universidades.sh` la mantiene al día automáticamente junto con las
demás.

#!/usr/bin/env bash
# Sincroniza universidades/<nombre> con la rama `main` del repo real de cada
# universidad (submódulos de Git) y deja registro del sync en el historial de
# Examlab.
#
# Qué hace, en orden:
#   1. `git submodule update --remote --merge` — trae el HEAD actual de la
#      rama configurada (main) de CADA submódulo. `--merge` en vez de
#      `--checkout` (el default): si algún día alguien edita algo a mano
#      DENTRO de una carpeta de universidad (no debería, ver CLAUDE.md), un
#      merge lo respeta en vez de pisarlo en modo detached HEAD silencioso.
#   2. Si algo cambió, un commit en EXAMLAB (no en las universidades) que
#      registra el nuevo puntero de submódulo — trazabilidad de "qué vio
#      Examlab de cada universidad y cuándo".
#   3. Imprime qué universidades cambiaron desde el sync anterior.
#
# Uso:
#   scripts/update-universidades.sh
#
# Precondición: cada universidad debe estar registrada como submódulo en
# `.gitmodules` (ver universidades/README.md para el estado de cada una). Si
# `.gitmodules` no existe todavía —ninguna universidad se pudo agregar aún,
# p. ej. porque su repo está vacío—, el script no falla: avisa y termina.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -f .gitmodules ]; then
  echo "No hay submódulos registrados todavía (.gitmodules no existe)."
  echo "Ver universidades/README.md para el estado de cada universidad."
  exit 0
fi

# `git submodule status` imprime "<sha> <ruta> (<describe>)" por submódulo —
# capturar esto antes/después del update es más confiable que comparar el
# árbol a mano, porque ya es el formato que git usa para reportar el estado.
before="$(git submodule status -- universidades)"

echo "Actualizando submódulos de universidades/ (rama main de cada una)…"
git submodule update --remote --merge -- universidades

after="$(git submodule status -- universidades)"

if [ "$before" = "$after" ]; then
  echo "Sin cambios: todas las universidades ya estaban al día."
  exit 0
fi

fecha="$(date +%Y-%m-%d)"
git add universidades/
git commit -m "chore: actualizar contenido de universidades ${fecha}"

echo ""
echo "Universidades actualizadas:"
# `|| true`: diff sale 1 cuando encuentra diferencias — que es justo el caso
# esperado acá. Sin esto, `set -o pipefail` lo propaga y el script termina en
# 1 después de haber hecho su trabajo bien.
{ diff <(echo "$before") <(echo "$after") || true; } \
  | grep -E '^>' \
  | awk '{print $3}' \
  | sed 's#^universidades/##' \
  | sort -u \
  | sed 's/^/  - /'

# -*- coding: utf-8 -*-
"""Sincroniza el CUERPO de los agentes .cursor/agents → .claude/agents.

Preserva el frontmatter propio de Claude (model, tools) y toma name + description
(+ cualquier otro campo de contenido) desde Cursor para que el comportamiento sea idéntico.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURSOR = ROOT / ".cursor" / "agents"
CLAUDE = ROOT / ".claude" / "agents"

FRONT_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
DEFAULT_CLAUDE_MODEL = "claude-opus-4-8"


def split_fm(text: str):
    m = FRONT_RE.match(text)
    if not m:
        return None, text
    return m.group(1), text[m.end() :]


def get_simple(fm: str, key: str):
    m = re.search(rf"^{re.escape(key)}:\s*(.+)$", fm, re.M)
    return m.group(1).strip() if m else None


def get_description_block(fm: str) -> str:
    m = re.search(r"^description:\s*\|\s*\n(.*?)(?=^[a-zA-Z_][\w-]*:|\Z)", fm, re.M | re.S)
    if m:
        return m.group(0).rstrip()
    m = re.search(r"^description:\s*(.+)$", fm, re.M)
    if m:
        return m.group(0).rstrip()
    return "description: |\n  (sin descripción)"


def get_tools_block(fm: str | None) -> str | None:
    if not fm:
        return None
    m = re.search(r"^tools:\s*\n((?:[ \t]+-.*\n?)+)", fm, re.M)
    if not m:
        return None
    return "tools:\n" + m.group(1).rstrip()


def sync_one(src: Path, dst: Path) -> str:
    src_fm, src_body = split_fm(src.read_text(encoding="utf-8"))
    if src_fm is None:
        raise ValueError(f"Sin frontmatter en {src}")

    dst_fm = None
    if dst.exists():
        dst_fm, _ = split_fm(dst.read_text(encoding="utf-8"))

    name = get_simple(src_fm, "name") or src.stem
    desc = get_description_block(src_fm)

    model = get_simple(dst_fm, "model") if dst_fm else None
    if not model or model == "inherit":
        model = DEFAULT_CLAUDE_MODEL

    tools = get_tools_block(dst_fm)
    # Si Claude no tenía tools, hereda un set razonable para agentes de generación
    if not tools:
        tools = "tools:\n  - Read\n  - Write\n  - Edit\n  - Glob\n  - Grep\n  - Bash"

    parts = [f"name: {name}", f"model: {model}", desc, tools]
    new_text = "---\n" + "\n".join(parts) + "\n---\n\n" + src_body.lstrip("\n")
    if not new_text.endswith("\n"):
        new_text += "\n"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(new_text, encoding="utf-8")
    return f"{src.name}: model={model}"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if not CURSOR.is_dir():
        print("No existe", CURSOR)
        return 1
    CLAUDE.mkdir(parents=True, exist_ok=True)
    for src in sorted(CURSOR.glob("*.md")):
        msg = sync_one(src, CLAUDE / src.name)
        print("SYNCED", msg)
    print(f"OK — cuerpo de Cursor espejado a Claude ({CURSOR.name} → {CLAUDE})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# Genera schema_clean.sql a partir de schema.sql, removiendo:
#   1) Bloques COPY "public"."x" ... FROM stdin; ... terminados con backslash-dot.
#      Supabase Studio no los soporta -- solo funcionan en psql CLI.
#   2) Meta-comandos backslash-restrict / backslash-unrestrict (idem).
# Uso: python _clean.py
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))
src_path = os.path.join(HERE, "schema.sql")
out_path = os.path.join(HERE, "schema_clean.sql")

with open(src_path, encoding="utf-8") as f:
    src = f.read()

# 1) COPY blocks: desde COPY ... FROM stdin; hasta la linea de terminador.
copy_pat = re.compile(
    r'^COPY "public"\..*? FROM stdin;\n.*?^\\\.\n',
    re.MULTILINE | re.DOTALL,
)
out, n_copy = copy_pat.subn("", src)

# 2) Meta-comandos psql que rompen en SQL editor web.
meta_pat = re.compile(r"^\\(restrict|unrestrict) .*\n", re.MULTILINE)
out, n_meta = meta_pat.subn("", out)

with open(out_path, "w", encoding="utf-8", newline="\n") as f:
    f.write(out)

print("COPY blocks removidos:", n_copy)
print("Meta-cmds removidos:  ", n_meta)
print("Archivo escrito:      ", out_path)

# Genera el Excel de control de USUARIOS DEMO (docentes de prueba) para ir
# marcando a quién se le entregó cada cuenta. Sin dependencias: arma un .xlsx
# (OOXML) mínimo válido con strings inline, vía zipfile.
#
#   python scripts/gen-demo-users-xlsx.py
#
# Salida: docs/demos/correos/ExamLab-Usuarios-Demo.xlsx
import os, zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "demos", "correos")
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, "ExamLab-Usuarios-Demo.xlsx")

URL = "https://examlab.lovable.app/auth"
TENANT = "ExamLab Demo"
PWD = "ExamlabDemo2026"
NOTAS = (
    "Cuenta de demo. Al iniciar sesión, selecciona la institución \"ExamLab Demo\". "
    "El espacio empieza vacío: crea tu propio curso para empezar y usa la IA para generar "
    "exámenes/talleres (corre al instante). No incluye estudiantes (la matrícula la hace un "
    "administrador), así que el ciclo completo de calificación de entregas reales se ve en los "
    "videos demo, no en esta cuenta. La contraseña es genérica y no caduca al primer ingreso. "
    "Si la IA falla puntualmente, suele ser disponibilidad del modelo (es una demo): espera unos "
    "minutos y reintenta — no es un error de la plataforma. "
    "La cuenta tiene dos roles (Docente y Estudiante): cambia con el selector arriba del menú para ver ambas vistas."
)

HEADERS = ["#", "Nombre", "Email (usuario)", "Contraseña", "Rol", "Institución",
           "URL de ingreso", "Entregado a", "Fecha entrega", "Notas"]
USERS = [
    ["Docente Demo 1", "docente1@demo-examlab.co"],
    ["Docente Demo 2", "docente2@demo-examlab.co"],
    ["Docente Demo 3", "docente3@demo-examlab.co"],
    ["Docente Demo 4", "docente4@demo-examlab.co"],
    ["Docente Demo 5", "docente5@demo-examlab.co"],
]
rows = [HEADERS]
for i, (name, email) in enumerate(USERS, 1):
    rows.append([str(i), name, email, PWD, "Docente + Estudiante", TENANT, URL, "", "", NOTAS])

def col_letter(n):  # 0 -> A
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def cell(ref, val):
    if val == "":
        return f'<c r="{ref}"/>'
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(str(val))}</t></is></c>'

sheet_rows = []
for ri, row in enumerate(rows, 1):
    cells = "".join(cell(f"{col_letter(ci)}{ri}", v) for ci, v in enumerate(row))
    sheet_rows.append(f'<row r="{ri}">{cells}</row>')

# anchos de columna (aprox) para legibilidad
cols = (
    '<cols>'
    '<col min="1" max="1" width="4"/>'
    '<col min="2" max="2" width="18"/>'
    '<col min="3" max="3" width="28"/>'
    '<col min="4" max="4" width="18"/>'
    '<col min="5" max="5" width="10"/>'
    '<col min="6" max="6" width="16"/>'
    '<col min="7" max="7" width="36"/>'
    '<col min="8" max="8" width="22"/>'
    '<col min="9" max="9" width="14"/>'
    '<col min="10" max="10" width="30"/>'
    '</cols>'
)
sheet = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + cols +
    '<sheetData>' + "".join(sheet_rows) + '</sheetData>'
    '</worksheet>'
)
content_types = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>'
)
root_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)
workbook = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Usuarios Demo" sheetId="1" r:id="rId1"/></sheets>'
    '</workbook>'
)
wb_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '</Relationships>'
)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", root_rels)
    z.writestr("xl/workbook.xml", workbook)
    z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
    z.writestr("xl/worksheets/sheet1.xml", sheet)
print("OK ->", OUT)

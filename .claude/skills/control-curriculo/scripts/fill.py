import json, os, win32com.client as w
B="G:/Mi unidad/Trabajos/Empleo/UNIAJ/"
TPL=B+"Formatos/PLAN DE CURSO ACTUALIZADO.doc"
FIX={('Programación II','1'):(None,'Configuración del entorno','Lectura de conceptos previos'),
     ('Programación II','6'):(None,'Manejo de eventos en la GUI','Ajustes del código'),
     ('Programación II','10'):(None,'Revisión de código entre pares; Rastreo con depurador',None)}
CODES={'Programación II':'FI303204','Seminario de Sistemas':'FI303301','Bases de Datos II':'FI303215','Arquitectura de Sistemas Computacionales':'FI303380','Introducción a la Ingeniería':'FI300101'}
app=w.Dispatch('Word.Application'); app.Visible=False
for c in json.load(open('plans.json',encoding='utf-8')):
    d=app.Documents.Open(os.path.abspath(TPL),ReadOnly=True,AddToRecentFiles=False)
    t=d.Tables(1)
    for i,r in enumerate(c['rows']):
        f=FIX.get((c['name'],r[0]))
        if f: r=[r[0]]+[f[k] or r[k+1] for k in range(3)]
        for k in range(4): t.Cell(i+2,k+1).Range.Text=r[k]
    for _ in range(t.Rows.Count-1-len(c['rows'])): t.Rows(t.Rows.Count).Delete()
    rng=d.Range(0,0); rng.InsertBefore(f"PLAN DE CURSO — {c['name']} ({CODES[c['name']]}) · Grupo {c['grupo']} · Periodo 2026-2 · Docente: Julian Andres Castaño Espinosa\r")
    rng=d.Paragraphs(1).Range; rng.Font.Bold=True; rng.Font.Size=11
    outdir=B+"Cursos/"+c['folder']+"/Entregas docente/2026-2/"; os.makedirs(outdir,exist_ok=True)
    base=os.path.normpath(outdir)+os.sep+f"PLAN DE CURSO - {c['name']} - {c['grupo']} - 2026-2"
    d.SaveAs2(base+".docx",FileFormat=16); d.ExportAsFixedFormat(base+".pdf",17); d.Close(False); print(base)
app.Quit()

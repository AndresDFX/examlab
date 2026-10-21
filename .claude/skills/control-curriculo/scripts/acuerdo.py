import os, win32com.client as w
B=r"G:\Mi unidad\Trabajos\Empleo\UNIAJ\Cursos"
SRC=B+r"\Programacion II\Entregas docente\2026-2\ACUERDO PEDAGOGICO - Programación II - 2026-2.docx"
G={'LB141F':('Martes 18:30 – 20:00','08/09/2026','17/11/2026',['29/09','06/10 – 20/10','20/10','27/10 – 17/11','17/11'],'08/09 – 29/09'),
   'SB141B':('Jueves 14:30 – 16:00','10/09/2026','19/11/2026',['01/10','08/10 – 22/10','22/10','29/10 – 19/11','19/11'],'10/09 – 01/10'),
   'SB141C':('Martes 14:30 – 16:00','08/09/2026','17/11/2026',['29/09','06/10 – 20/10','20/10','27/10 – 17/11','17/11'],'08/09 – 29/09')}
OBJ=("Reconocer los fundamentos y campos de acción de la Ingeniería de Sistemas para comprender su impacto social, ambiental y tecnológico, favoreciendo el desarrollo de soluciones sostenibles.\v"
     "Resultado de aprendizaje: desarrolla soluciones de software para necesidades tecnológicas mediante el uso eficiente de recursos y adaptación responsable al entorno.")
app=w.Dispatch('Word.Application'); app.Visible=False
for g,(hor,ini,fin,c,c1) in G.items():
    d=app.Documents.Open(SRC,ReadOnly=True,AddToRecentFiles=False); T=d.Tables
    def s(t,r,k,v): T(t).Cell(r,k).Range.Text=v
    s(1,2,2,'Introducción a la Ingeniería'); s(1,3,2,g); s(1,3,4,'1'); s(1,4,4,ini+' (Sesión 1)')
    s(2,2,1,OBJ)
    s(3,2,1,f"[PRELLENADO 2026-2 — pendiente socialización con el grupo]\vPeriodo académico: {ini} al {fin}.\vPendiente: aprobación/ajustes con estudiantes, listado oficial, vocero y firmas.\vNo se inventan nombres ni códigos de estudiantes.")
    s(4,1,1,f"Acuerdo sobre los aspectos metodológicos\vPeriodo 2026-2 · Grupo {g} · {hor} (90 min; inicio efectivo 10 min después).\v"
      "Modalidad: Virtual síncrona por Microsoft Teams; actividades en plataformas gratuitas en la nube.\v"
      "Estructura de sesión: apertura (10 min) · teoría y guía del docente (45 min) · actividad en 5 equipos fijos en salas de grupo (17 min) · exposiciones de 3 min por equipo (15 min) · cierre (3 min). El vocero del equipo rota cada sesión.\v"
      "Enfoque: aprendizaje basado en proyectos (ABPr) con un proyecto de equipo durante todo el semestre.\v"
      f"Calendario: 11 sesiones ({ini}–{fin}) que cubren los 16 temas del microcurrículo (5 sesiones dobles). Ningún festivo cae en el día de clase.")
    s(4,2,1,"Acuerdo sobre los aspectos de evaluación\v(30% / 30% / 40% — validar en socialización con el grupo)\v"
      f"Primer corte (30%) — [{c1}/2026] · Sesiones 1–4:\v* 10% Evaluación de corte (Sesión 4 — {c[0]}/2026) | 12% Exposiciones de equipo y actividades en clase | 8% Asistencia y participación\v"
      f"Segundo corte (30%) — [{c[1]}/2026] · Sesiones 5–7:\v* 10% Evaluación de corte (Sesión 7 — {c[2]}/2026) | 12% Exposiciones de equipo y actividades en clase | 8% Asistencia y participación\v"
      f"Tercer corte (40%) — [{c[3]}/2026] · Sesiones 8–11:\v* 15% Exposición final del proyecto (Sesión 11 — {c[4]}/2026) | 20% Informe final del proyecto | 5% Asistencia y participación")
    for p in d.Paragraphs:
        if p.Range.Text.startswith('Docente: Julian'):
            r=p.Range; r.MoveEnd(1,-1)
            r.Text=f"Docente: Julian Andres Castaño Espinosa · Correo: julianacastano@profesores.uniajc.edu.co · Horario: {hor} (90 min) · Modalidad: Virtual (Microsoft Teams) · Código: FI300101 · Periodo: {ini}–{fin} · 11 sesiones / 16 temas · PRELLENADO 2026-2 — campos de estudiantes pendientes."
    out=B+r"\Introduccion a la Ingenieria\Entregas docente\2026-2\ACUERDO PEDAGOGICO - Introducción a la Ingeniería - "+g+" - 2026-2"
    d.SaveAs2(out+".docx",FileFormat=16); d.ExportAsFixedFormat(out+".pdf",17); d.Close(False); print(out)
app.Quit()

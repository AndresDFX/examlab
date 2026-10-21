import json, re, unicodedata, sys
B="G:/Mi unidad/Trabajos/Empleo/UNIAJ/Cursos/"
old=json.load(open('old.json',encoding='utf-8'))
def oldrows(key):
    k=[x for x in old if key in x][0]; t=old[k][0]
    return [r for r in t[1:] if r[1]]
def norm(s): return ''.join(c for c in unicodedata.normalize('NFD',s.lower()) if unicodedata.category(c)!='Mn')
STOP=set('de la el los las y en a del con para por un una al se su sus o e curso sesion clase introduccion'.split())
def toks(s): return {w for w in re.findall(r'[a-z0-9]+',norm(s)) if len(w)>3 and w not in STOP}
def mdtable(path):
    L=open(path,encoding='utf-8').read().splitlines()
    for i,l in enumerate(L):
        if l.startswith('|') and 'Sesi' in l and 'Tema' in l:
            hdr=[h.strip() for h in l.strip('|').split('|')]
            rows=[]
            for m in L[i+2:]:
                if not m.startswith('|'): break
                rows.append(dict(zip(hdr,[c.strip() for c in m.strip('|').split('|')])))
            return rows
def clean(s): return re.sub(r'\*\*|\(solo evaluaci[oó]n\)|\(\+ diagn[oó]stico\)','',s).strip(' ·')
def build(mdpath, oldkey):
    rows=mdtable(mdpath); olds=oldrows(oldkey); used=set(); out=[]
    tema_key=[k for k in rows[0] if k.startswith('Tema')][0]
    ti_key=next((k for k in rows[0] if k.startswith('Trabajo independiente')),None)
    for r in rows:
        n=re.sub(r'\D','',r['Sesión']); tema=clean(r[tema_key])
        m=re.search(r'Parcial\s*(\d)|Evaluaci[oó]n de corte',tema,re.I)
        if m and 'proyecto' not in norm(tema):
            c=m.group(1) or '?'
            out.append([n,f"Parcial {c}: evaluación de cierre del corte {c} (virtual síncrona)",f"Evaluación del corte {c}",f"Repaso de los temas del corte {c}"]); continue
        partes=[p.strip() for p in re.split(r'\s\+\s|\s·\s',tema) if p.strip()]
        tid=[];ti=[]
        for p in partes:
            tp=toks(p); best=None;bs=0
            for j,o in enumerate(olds):
                s=len(tp & toks(o[1]))
                if s>bs: bs,best=s,j
            if best is not None:
                used.add(best); tid.append(olds[best][2].rstrip('.')); ti.append(olds[best][3].rstrip('.'))
        if ti_key and r.get(ti_key) and r[ti_key] not in ('—',''): ti=[r[ti_key]]
        out.append([n,tema,'; '.join(dict.fromkeys(tid)) or 'Taller guiado en clase','; '.join(dict.fromkeys(ti)) or 'Taller de la sesión'])
    return out
COURSES=[
 ('Programacion II','Plan curso/2026-2/PLAN_DE_CURSO_2026-2.md','PROGRAMACION II','Programación II','341C'),
 ('Seminario de Sistemas','Plan curso/2026-2/PLAN_DE_CURSO_2026-2.md','SEMINARIO DE SISTEMAS','Seminario de Sistemas','341C'),
 ('Bases de Datos II','Plan curso/2026-2/PLAN_DE_CURSO_2026-2.md','BASE DE DATOS II','Bases de Datos II','641A-2'),
 ('Arquitectura de Sistemas Computacionales','Plan curso/2026-2/PLAN_DE_CURSO_2026-2.md','ARQUITECTURA','Arquitectura de Sistemas Computacionales','6303C'),
]+[('Introduccion a la Ingenieria',f'Plan curso/2026-2/CALENDARIO_2026-2 - {g}.md','INTRODUCCI','Introducción a la Ingeniería',g) for g in ('LB141F','SB141B','SB141C')]
res=[]
for folder,md,key,name,g in COURSES:
    res.append({'folder':folder,'name':name,'grupo':g,'rows':build(B+folder+'/'+md,key)})
json.dump(res,open('plans.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
for c in res:
    print('##',c['name'],c['grupo'])
    for r in c['rows']: print('  ',' | '.join(r))

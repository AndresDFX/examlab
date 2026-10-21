import sys, os, json, win32com.client as w
app=w.Dispatch('Word.Application'); app.Visible=False
out={}
for src in sys.argv[2:]:
    d=app.Documents.Open(os.path.abspath(src), ReadOnly=True, AddToRecentFiles=False)
    ts=[]
    for t in d.Tables:
        rows=[]
        for r in range(1,t.Rows.Count+1):
            row=[]
            for c in range(1,t.Columns.Count+1):
                try: row.append(t.Cell(r,c).Range.Text.replace('\r\x07','').replace('\r',' ').strip())
                except Exception: row.append(None)
            rows.append(row)
        ts.append(rows)
    out[src]=ts; d.Close(False)
app.Quit()
json.dump(out,open(sys.argv[1],'w',encoding='utf-8'),ensure_ascii=False,indent=1)

# -*- coding: utf-8 -*-
import sys,json,pathlib,resource,base64,io,time
import pypdfium2 as pdf
from pypdfium2 import raw
start=time.monotonic();file=pathlib.Path(sys.argv[1])
if file.stat().st_size>10*1024*1024:raise ValueError('file_too_large')
doc=pdf.PdfDocument(str(file));pages=[]
try:
 if len(doc)>10:raise ValueError('page_limit')
 for n in range(len(doc)):
  page=doc[n];tp=page.get_textpage();text=tp.get_text_bounded();tp.close();w,h=page.get_size();large_image=False
  for obj in page.get_objects():
   if obj.type==raw.FPDF_PAGEOBJ_IMAGE:
    x1,y1,x2,y2=obj.get_pos()
    if abs((x2-x1)*(y2-y1))>w*h*0.25:large_image=True
  if len(text.strip())>=80 and not large_image:pages.append({'page':n+1,'text':text,'source':'pdfium_text'})
  else:
   bitmap=page.render(scale=min(2,1600/max(w,h)));image=bitmap.to_pil();buf=io.BytesIO();image.convert('RGB').save(buf,format='JPEG',quality=85);pages.append({'page':n+1,'image':'data:image/jpeg;base64,'+base64.b64encode(buf.getvalue()).decode(),'source':'pdfium_render'});image.close();bitmap.close()
  page.close()
 if sum(len(p.get('text','')) for p in pages)>60000:raise ValueError('text_limit')
 if len(json.dumps(pages).encode())>12*1024*1024:raise ValueError('payload_limit')
 rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
 print(json.dumps({'pages':pages,'nativeMaxRssKiB':rss/1024 if sys.platform=='darwin' else rss,'nativeMs':round((time.monotonic()-start)*1000)}))
finally:doc.close()

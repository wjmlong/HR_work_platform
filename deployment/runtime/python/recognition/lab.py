"""Isolated resume recognition experiment; no application/database dependencies."""
import base64,copy,hashlib,io,json,re,time,unicodedata,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
import pymupdf
import requests
from PIL import Image,ImageOps

VERSION='source-vision-4'
FIELDS=['name','phone','email','school','major','education','intent','experienceYears','firstEmployment','skills','companies']
def compact(value):
    return ''.join(unicodedata.normalize('NFKC',str(value)).lower().split())

def check_hash(path,expected):
    if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=expected:raise ValueError('source_integrity_error')

def image_url(data):
    with Image.open(io.BytesIO(data)) as original:
        im=ImageOps.exif_transpose(original).convert('RGB')
        # Preserve fine text on long resumes, bounded to avoid oversized API payloads.
        im.thumbnail((2200,8000));out=io.BytesIO();im.save(out,format='JPEG',quality=92)
    return 'data:image/jpeg;base64,'+base64.b64encode(out.getvalue()).decode()

def xml_text(data):
    if b'<!DOCTYPE' in data or b'<!ENTITY' in data:raise ValueError('unsafe_xml')
    root=ET.fromstring(data)
    def walk(n):
        tag=n.tag.rsplit('}',1)[-1]
        if tag=='AlternateContent':
            choice=next((c for c in n if c.tag.endswith('}Choice')),None)
            if choice is None:choice=next(iter(n),None)
            return walk(choice) if choice is not None else ''
        if tag=='t':return n.text or ''
        if tag=='tab':return '\t'
        if tag in ('br','cr'):return '\n'
        return ''.join(walk(c) for c in n)+ ('\n' if tag in ('p','tr') else '')
    return walk(root)

def read_document(path,kind):
    path=Path(path);raw=path.read_bytes();pages=[];text='';warnings=[]
    if len(raw)>64*1024*1024:raise ValueError('file_too_large')
    if kind=='pdf':
        with pymupdf.open(path) as doc:
            if doc.needs_pass:raise ValueError('encrypted_pdf')
            if len(doc)>100:raise ValueError('page_limit')
            for i,page in enumerate(doc):
                text=page.get_text(sort=True)
                coverage=sum((r['bbox'][2]-r['bbox'][0])*(r['bbox'][3]-r['bbox'][1]) for r in page.get_image_info())/max(page.rect.get_area(),1)
                zoom=min(2,2200/max(page.rect.width,1),8000/max(page.rect.height,1))
                data=page.get_pixmap(matrix=pymupdf.Matrix(zoom,zoom),alpha=False).tobytes('jpeg',jpg_quality=92)
                pages.append({'number':i+1,'text':text,'needs_ocr':len(text.strip())<150 or coverage>.25,'image':image_url(data)})
        text='\n\n'.join(p['text'] for p in pages)
    elif kind=='docx':
        with zipfile.ZipFile(path) as z:
            if len(z.infolist())>1000 or sum(n.file_size for n in z.infolist())>100*1024*1024:raise ValueError('archive_limit')
            names=z.namelist()
            parts=[n for n in names if n=='word/document.xml' or re.fullmatch(r'word/(?:header|footer)\d+\.xml',n)]
            if not parts:raise ValueError('invalid_docx')
            text='\n'.join(xml_text(z.read(n)) for n in parts)
            for name in names:
                if name.startswith('word/media/') and not name.endswith('/'):
                    try:
                        data=z.read(name)
                        with Image.open(io.BytesIO(data)) as im:w,h=im.size
                        if w>=500 and h>=500:
                            pages.append({'number':len(pages)+1,'text':'','needs_ocr':True,'image':image_url(data),'part':name})
                    except zipfile.BadZipFile:warnings.append('corrupt_media:'+name)
                    except (OSError,ValueError):continue
    elif kind in ('png','jpg','jpeg','webp','image'):
        pages=[{'number':1,'text':'','needs_ocr':True,'image':image_url(raw)}]
    elif kind=='paste':text=json.loads(raw.decode('utf-8-sig'))
    elif kind in ('txt','email'):
        for enc in (('utf-16',) if raw.startswith((b'\xff\xfe',b'\xfe\xff')) else ('utf-8-sig','gb18030')):
            try:text=raw.decode(enc);break
            except UnicodeDecodeError:continue
        else:raise ValueError('unknown_text_encoding')
    else:raise ValueError('unsupported_format:'+kind)
    if not isinstance(text,str):raise ValueError('invalid_text')
    return {'text':text,'pages':pages,'warnings':warnings}

def decode_response(data):
    c=data['choices'][0]
    if c.get('finish_reason')!='stop':raise ValueError('model_finish_'+str(c.get('finish_reason')))
    # Some compatible providers emit literal newlines inside strings. Preserve them;
    # never repair missing braces or accept a truncated response.
    result=json.loads(c['message']['content'],strict=False)
    if not isinstance(result,dict):raise ValueError('invalid_json_object')
    return result

class Client:
    def __init__(self,config_file):
        self.config=json.loads(Path(config_file).read_text(encoding='utf-8-sig'))
        if not self.config['base_url'].startswith('https://'):raise ValueError('https_required')
    def call(self,system,content,max_tokens=6500):
        c=self.config;body={'model':c['model'],'messages':[{'role':'system','content':system},{'role':'user','content':content}],'thinking':{'type':'disabled'},'temperature':0,'max_tokens':max_tokens,'response_format':{'type':'json_object'},'stream':False}
        started=time.monotonic()
        for attempt in range(3):
            try:
                response=requests.post(c['base_url'].rstrip('/')+'/chat/completions',json=body,headers={'Authorization':'Bearer '+c['api_key']},timeout=(15,120))
                if response.status_code in (429,500,502,503,504) and attempt<2:time.sleep(2**attempt);continue
                if response.status_code!=200:raise ValueError('provider_http_'+str(response.status_code))
                data=response.json();result=decode_response(data)
                return result,{'requested_model':c['model'],'returned_model':data.get('model'),'usage':data.get('usage',{}),'seconds':round(time.monotonic()-started,3),'attempts':attempt+1}
            except (requests.Timeout,requests.ConnectionError):
                if attempt==2:raise ValueError('provider_connection_failed') from None
                time.sleep(2**attempt)

def validate_prediction(result,source):
    result=copy.deepcopy(result);kind=result.get('document_type')
    if kind not in ('resume','cover_letter','other','unknown'):raise ValueError('invalid_document_type')
    p=result.setdefault('profile',{});warnings=result.setdefault('warnings',[])
    if not isinstance(p,dict) or not isinstance(warnings,list):raise ValueError('invalid_profile')
    evidence=result.get('evidence',[])
    if not isinstance(evidence,list):raise ValueError('invalid_evidence')
    if kind not in ('resume','cover_letter'):
        result['profile']={k:[] if k in ('skills','companies') else None for k in FIELDS};return result
    for field,value in list(p.items()):
        if value is None or value==[] or value=='':continue
        quotes=[e.get('quote','') for e in evidence if isinstance(e,dict) and e.get('field') in (field,'profile.'+field)]
        if not any(q and compact(q) in compact(source) for q in quotes):
            p[field]=[] if isinstance(value,list) else None;warnings.append('unverified_evidence:'+field)
    for field in FIELDS:p.setdefault(field,[] if field in ('skills','companies') else None)
    # Project summary fields from the model's structured facts; do not infer a
    # school from chronology or employment from a graduation date.
    history=result.get('employmentHistory')
    if isinstance(history,list) and p['firstEmployment'] and not any(isinstance(h,dict) and h.get('type') in ('full_time','part_time') for h in history):
        p['firstEmployment']=None;warnings.append('first_employment_requires_non_internship_evidence')
    degrees={'secondary':1,'associate':2,'bachelor':3,'master':4,'doctor':5,'高中':1,'中专':1,'专科':2,'大专':2,'本科':3,'学士':3,'硕士':4,'博士':5}
    education=result.get('educationHistory',[])
    degree_rows=[h for h in education if isinstance(h,dict) and h.get('degree') in degrees] if isinstance(education,list) else []
    if degree_rows:
        highest=max(degrees[h['degree']] for h in degree_rows)
        top=[h for h in degree_rows if degrees[h['degree']]==highest]
        if len(top)==1:
            for field in ('school','major'):
                value=top[0].get(field)
                equivalent=p[field] and isinstance(value,str) and (compact(value) in compact(p[field]) or compact(p[field]) in compact(value))
                if isinstance(value,str) and value and value in source and not equivalent and value!=p[field]:
                    p[field]=value;evidence.append({'field':field,'quote':value,'source':'document','basis':'highest_degree_history'});warnings.append('reconciled_highest_degree:'+field)
    degree_terms={'secondary':['高中','中专'],'associate':['专科','大专','associate'],'bachelor':['本科','学士','bachelor'],'master':['硕士','master','msc','研究生'],'doctor':['博士','phd','ph.d','doctor']}
    if p['education']:
        quotes=' '.join(e.get('quote','') for e in evidence if isinstance(e,dict) and e.get('field') in ('education','profile.education'))
        normalized=compact(quotes).replace('博士后','')
        if not any(compact(t) in normalized for t in degree_terms.get(p['education'],[])):
            p['education']=None;warnings.append('degree_not_explicit_in_evidence')
        elif p['education']=='master' and '研究生' in normalized and not any(t in normalized for t in ['硕士','master','msc']):
            warnings.append('graduate_degree_level_requires_review')
    for field in ('name','phone','email'):
        value=p[field]
        quotes=[e.get('quote','') for e in evidence if isinstance(e,dict) and e.get('field') in (field,'profile.'+field)]
        if value and not any(compact(value) in compact(q) for q in quotes):p[field]=None;warnings.append('value_not_in_evidence:'+field)
    for field in ('name','phone','email','school','major','education','intent','firstEmployment'):
        if p[field] is not None and not isinstance(p[field],str):raise ValueError('invalid_field:'+field)
    years=p['experienceYears']
    if isinstance(years,str):
        try:
            value=years.strip()
            if re.fullmatch(r'\d+(?:\.\d+)?\s*年',value):value=value[:-1].strip()
            years=float(value);p['experienceYears']=years
        except ValueError:raise ValueError('invalid_years') from None
    if years is not None and (isinstance(years,bool) or not isinstance(years,(int,float)) or not 0<=years<=80):raise ValueError('invalid_years')
    for field in ('companies','skills'):
        if not isinstance(p[field],list) or any(not isinstance(x,str) for x in p[field]):raise ValueError('invalid_field:'+field)
    return result

def get_path(row,path):
    for k in path.split('.'):
        if not isinstance(row,dict):return None
        row=row.get(k)
    return row

def score(gold,predictions):
    errors=[];total=correct=missing=cases=0
    for item in gold:
        if item.get('review_status')!='verified':continue
        cases+=1;pred=predictions.get(item['id']);missing+=pred is None
        for field,expected in item['expected'].items():
            total+=1;actual=get_path(pred,field) if pred is not None else '[missing prediction]'
            if actual=='':actual=None
            accepted=expected.get('any') if isinstance(expected,dict) else [expected]
            ok=pred is not None and any(actual==v or isinstance(actual,str) and isinstance(v,str) and compact(actual)==compact(v) for v in accepted)
            if ok:correct+=1
            else:errors.append({'id':item['id'],'field':field,'expected':expected,'actual':actual})
    return {'correct':correct,'total':total,'cases':cases,'missing':missing,'accuracy':round(correct/total,4) if total else 0.0,'errors':errors}

def source_groups(rows):
    parents={r['id']:r['id'] for r in rows};seen={}
    def root(k):
        while parents[k]!=k:parents[k]=parents[parents[k]];k=parents[k]
        return k
    for r in rows:
        tokens=['candidate:'+v for v in r.get('candidate_ids',[])]+['mail:'+v for v in r.get('mail_keys',[])]+['text:'+r['text_hash']] if r.get('text_hash') else ['candidate:'+v for v in r.get('candidate_ids',[])]+['mail:'+v for v in r.get('mail_keys',[])]
        for t in tokens:
            if t in seen:parents[root(r['id'])]=root(seen[t])
            seen[t]=r['id']
    return {r['id']:root(r['id']) for r in rows}

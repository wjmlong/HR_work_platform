"""Isolated document process using the reviewed source-vision-4 implementation."""
import argparse,json,pathlib,shutil,subprocess,sys,tempfile,time
import lab,prompts,year_claims

def recognize(request,client):
    started=time.monotonic();calls=[]
    def call(system,content,tokens=10000):
        value,meta=client.call(system,content,tokens);calls.append(meta);return value
    with tempfile.TemporaryDirectory(prefix='resume-recognition-') as tmp:
        if 'text' in request:
            if not isinstance(request['text'],str):raise ValueError('invalid_text')
            source={'text':request['text'],'pages':[],'warnings':[]};kind='txt'
        else:
            file=pathlib.Path(request['file']);kind=request['kind'];lab.check_hash(file,request['sha256'])
            if kind in ('doc','wps'):
                directory=pathlib.Path(tmp);original=directory/('original.'+kind);shutil.copyfile(file,original)
                subprocess.run(['soffice','-env:UserInstallation='+(directory/'office-profile').as_uri(),'--headless','--convert-to','pdf','--outdir',tmp,str(original)],check=True,timeout=90,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                file=directory/'original.pdf';kind='pdf'
            source=lab.read_document(file,kind)
        transcript=[];warnings=[]
        for page in source['pages']:
            data=call(prompts.OCR,[{'type':'text','text':'原始页面 '+str(page['number'])},{'type':'image_url','image_url':{'url':page['image'],'detail':'high'}}])
            if not isinstance(data.get('text'),str):raise ValueError('invalid_ocr_text')
            transcript.append({'page':page['number'],'text':data['text'],'method':'deepseek_vision'});warnings+=data.get('uncertain',[])
        text='\n\n'.join('【第%d页】\n%s'%(p['page'],p['text']) for p in transcript) if kind=='pdf' else source['text']+'\n'+'\n'.join('【内嵌图片%d】\n%s'%(p['page'],p['text']) for p in transcript)
        if len(text)>400000:raise ValueError('text_limit')
        prediction=call(prompts.EXTRACT,text)
        raw=prediction.get('profile',{}).get('experienceYears')
        if year_claims.needs_normalization(raw):
            quotes=[e.get('quote','') for e in prediction.get('evidence',[]) if e.get('field') in ('experienceYears','profile.experienceYears')]
            normalized=year_claims.normalize_claim(raw,quotes,lambda system,content:call(system,content,1000))
            prediction.setdefault('normalizations',{})['experienceYears']=normalized;prediction['profile']['experienceYears']=normalized['value']
            if normalized['kind']!='exact':prediction.setdefault('warnings',[]).append('inexact_experience_years:'+str(raw))
        prediction=lab.validate_prediction(prediction,text)
        prediction['warnings']+=source.get('warnings',[])+['OCR:'+str(w) for w in warnings]
        return {'status':'ok','prediction':prediction,'source_text':text,'transcript':transcript,'calls':calls,'seconds':round(time.monotonic()-started,3)}

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--config',type=pathlib.Path,required=True);args=ap.parse_args()
    try:
        request=json.loads(sys.stdin.read(3*1024*1024));result=recognize(request,lab.Client(args.config));print(json.dumps(result,ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status':'error','error_type':type(error).__name__}),file=sys.stderr);sys.exit(1)

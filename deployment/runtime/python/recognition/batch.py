"""Full replay using production recognizer; no model-response cache is read."""
import argparse,concurrent.futures,json,pathlib,time,re
import lab
from cli import recognize

def process(root,row,config,out):
    target=out/(row['id']+'.json')
    if target.exists() and json.loads(target.read_text(encoding='utf-8')).get('status')=='ok':return 'already_processed_this_run'
    started=time.time()
    try:
        file=root/row['path'];lab.check_hash(file,row.get('sha256',row['id']))
        if row['kind']=='email':request={'text':'【邮件主题】'+row.get('subject','')+'\n【正文】\n'+file.read_text(encoding='utf-8')}
        else:request={'file':str(file),'kind':row['kind'],'sha256':row.get('sha256',row['id'])}
        result={'id':row['id'],'source_sha256':row.get('sha256',row['id']),**recognize(request,lab.Client(config)),'started_at':started,'finished_at':time.time()}
    except Exception as error:
        code=str(error)
        result={'id':row['id'],'status':'error','error_type':type(error).__name__,'error_code':code if re.fullmatch(r'[a-zA-Z0-9_:.-]{1,100}',code) else type(error).__name__,'started_at':started,'finished_at':time.time()}
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');return result['status']

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root',type=pathlib.Path);p.add_argument('--config',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);a=p.parse_args()
    a.out.mkdir(parents=True,exist_ok=True);rows=[r for r in json.loads((a.root/'manifest.json').read_text(encoding='utf-8'))['records'] if not r.get('container_only')]
    with concurrent.futures.ProcessPoolExecutor(max_workers=4) as pool:
        fs=[pool.submit(process,a.root,r,a.config,a.out) for r in rows]
        for i,f in enumerate(concurrent.futures.as_completed(fs),1):print(json.dumps({'processed':i,'total':len(rows),'status':f.result()}),flush=True)

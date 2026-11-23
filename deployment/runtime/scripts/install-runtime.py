"""Install isolated V4 agents; never edit old recruiting or OKR runtime files."""
import hashlib,json,os,pathlib,plistlib,shutil,subprocess,sys,time,urllib.parse,urllib.request
from runtime_plan import make_plan,deployment_transition,backup_strategy

def atomic_json(file,value):
    temporary=file.with_suffix('.tmp')
    with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as stream:json.dump(value,stream,ensure_ascii=False,indent=2)
    temporary.replace(file)

def release_proof(release):
    files={}
    for directory in ['dist','migrations','web-dist']:
        for file in sorted((release/directory).rglob('*')):
            if file.is_file():files[str(file.relative_to(release))]=hashlib.sha256(file.read_bytes()).hexdigest()
    for name in ['package.json','package-lock.json']:files[name]=hashlib.sha256((release/name).read_bytes()).hexdigest()
    return files

def stage_control(plan,action,release_id):
    runtime=pathlib.Path(plan['runtime']);private=runtime/'private';node=shutil.which('node')
    if not node or not release_id or len(release_id)!=16 or any(c not in '0123456789abcdef' for c in release_id):raise SystemExit('Expected a prepared release ID')
    release=runtime/'releases'/release_id
    if release.is_symlink() or release.resolve()!=release:raise SystemExit('Invalid release path')
    manifest=json.loads((release/'release-manifest.json').read_text())
    if release_proof(release)!=manifest['files']:raise SystemExit('Prepared release bytes changed')
    receipt_file=private/'deployments'/(release_id+'.json');r=json.loads(receipt_file.read_text())
    agents=pathlib.Path.home()/'Library/LaunchAgents';domain='gui/'+str(os.getuid());marker=private/'maintenance.json'
    def save():atomic_json(receipt_file,r)
    def loaded(item):return subprocess.run(['launchctl','print',domain+'/'+item['label']],capture_output=True,text=True)
    def stop(item):
        file=agents/(item['label']+'.plist')
        if file.exists():
            old=plistlib.loads(file.read_bytes())
            if old.get('Label')!=item['label'] or not any(str(runtime) in str(x) for x in old.get('ProgramArguments',[])):raise SystemExit('Refusing unrelated launch agent')
        state=loaded(item);pids=[]
        if state.returncode==0:
            import re
            pids=re.findall(r'^\s*pid = (\d+)',state.stdout,re.M)
            subprocess.run(['launchctl','bootout',domain+'/'+item['label']],check=True,capture_output=True)
        deadline=time.monotonic()+45
        while loaded(item).returncode==0 or any(subprocess.run(['kill','-0',pid],capture_output=True).returncode==0 for pid in pids):
            if time.monotonic()>deadline:raise SystemExit('V4 agent did not stop: '+item['role'])
            time.sleep(.2)
    def start(item):
        if loaded(item).returncode==0:stop(item)
        role=item['role'];file=agents/(item['label']+'.plist')
        definition={'Label':item['label'],'ProgramArguments':[node,str(release/'dist'/item['entry'])]+(['backup'] if role=='backup' else []),'WorkingDirectory':str(release),'EnvironmentVariables':{'PATH':str(pathlib.Path(node).parent)+':/usr/bin:/bin:/usr/sbin:/sbin',**item['environment']},'StandardOutPath':str(private/'logs'/(role+'.log')),'StandardErrorPath':str(private/'logs'/(role+'.error.log'))}
        if role=='backup':definition['StartCalendarInterval']={'Hour':2,'Minute':25}
        else:definition.update({'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'ProcessType':'Interactive'})
        file.write_bytes(plistlib.dumps(definition));file.chmod(0o600);subprocess.run(['launchctl','bootstrap',domain,str(file)],check=True,capture_output=True)
    def cli(command,*args,selected=release):
        return json.loads(subprocess.check_output([node,str(selected/'dist/operations/runtime-upgrade-cli.js'),command,*map(str,args)],cwd=selected,text=True))
    if action=='--maintenance':
        if r['phase'] not in ['prepared','maintenance','upgraded','active']:raise SystemExit('Release must be prepared or recoverable')
        prior=json.loads((runtime/'installed.json').read_text());old_release=pathlib.Path(prior['release'])
        if old_release.parent!=runtime/'releases' or old_release.is_symlink():raise SystemExit('Invalid installed release')
        live=cli('inspect');supported=manifest['schemaRevision']
        if supported<live['schemaRevision']:raise SystemExit('Database downgrade forbidden')
        # Persist maintenance before stopping any writer. Candidate gateway is
        # started first so cached clients immediately receive a 503, not a write.
        recovering=r.get('writersStarted') or r['phase'] in ['active','upgraded'] or r.get('before',{}).get('schemaRevision',live['schemaRevision'])!=live['schemaRevision']
        r.update(priorInstalled=prior,before=live,startedAt=time.time())
        if r['phase']=='prepared':r=deployment_transition(r,'maintenance',live['schemaRevision'],supported)
        atomic_json(marker,{'phase':'maintenance','release':release_id});save()
        gateway=next(i for i in plan['agents'] if i['role']=='gateway');stop(gateway);start(gateway)
        for item in plan['agents']:
            if item['role']!='gateway':stop(item)
        # Determine compatibility from actual SQL shape, never installed.json alone.
        installed_revision=max(int(p.stem) for p in (old_release/'migrations').glob('*.sql'))
        strategy=backup_strategy(live['schemaRevision'],supported,installed_revision)
        backup_dir=private/'backups'/('pre-config-'+release_id+'-'+str(time.time_ns()))
        result=json.loads(subprocess.check_output([node,str(old_release/'dist/operations/cli.js'),'backup',str(backup_dir)],cwd=old_release,text=True)) if strategy=='installed' else cli('backup-runtime',backup_dir)
        r['backupProgram']={'release':str(old_release if strategy=='installed' else release),'strategy':strategy,'schemaRevision':live['schemaRevision']}
        if not result.get('ok'):raise SystemExit('Consistent backup failed; maintenance remains enabled')
        r['backup']={'directory':str(backup_dir),'manifestHash':hashlib.sha256((backup_dir/'manifest.json').read_bytes()).hexdigest(),'at':time.time()}
        if recovering:
            r['incrementalBackup']=r['backup'];r=deployment_transition(r,'recover',live['schemaRevision'],supported)
        r['phase']='maintenance';r['writersStarted']=False;atomic_json(marker,{'phase':'maintenance','release':release_id,'backup':r['backup']});save()
    elif action=='--activate':
        if r['phase'] not in ['maintenance','upgraded'] or not marker.is_file():raise SystemExit('Activation requires maintenance and consistent backup')
        if json.loads(marker.read_text()).get('release')!=release_id:raise SystemExit('Maintenance belongs to a different release')
        live=cli('inspect')
        if r.get('writersStarted') or live['schemaRevision']!=r.get('before',{}).get('schemaRevision') and r['phase']=='maintenance':raise SystemExit('Interrupted activation requires --maintenance to drain writers and back up the actual schema')
        if r['phase']=='maintenance':
            if not r.get('backup') or hashlib.sha256((pathlib.Path(r['backup']['directory'])/'manifest.json').read_bytes()).hexdigest()!=r['backup']['manifestHash']:raise SystemExit('Consistent backup receipt invalid')
            r['upgradeIntent']={'fromRevision':live['schemaRevision'],'toRevision':manifest['schemaRevision'],'compatibleRelease':str(release)};save()
            upgraded=cli('upgrade',r['backup']['directory']);r['upgrade']=upgraded
            r=deployment_transition(r,'upgrade',r['before']['schemaRevision'],manifest['schemaRevision']);save()
        # Persist before the first writer can create a new increment.
        r['writersStarted']=True;r['databaseRelease']=str(release);save()
        for item in plan['agents']:
            if item['role']!='gateway':start(item)
        deadline=time.monotonic()+45
        while True:
            try:
                ready=[json.load(urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health/ready',timeout=2)) for port in plan['apiPorts']]
                if all(x.get('status')=='ready' for x in ready):break
            except Exception:pass
            if time.monotonic()>deadline:raise SystemExit('V4 API not ready; maintenance remains enabled')
            time.sleep(.3)
        for item in plan['agents']:
            if item['role']=='backup':continue
            state=loaded(item)
            if state.returncode or 'state = running' not in state.stdout or 'pid = ' not in state.stdout:raise SystemExit('Agent not running; maintenance remains enabled')
        current=cli('inspect')
        r=deployment_transition(r,'activate',current['schemaRevision'],manifest['schemaRevision']);r['after']=current;r['activatedAt']=time.time();save()
        atomic_json(runtime/'installed.json',{'release':str(release),'source':str(pathlib.Path(__file__).resolve().parent.parent),'version':plan['version'],'schemaRevision':manifest['schemaRevision'],'at':time.time()})
        marker.unlink()
    else:raise SystemExit('Unknown stage')
    print(json.dumps({'phase':r['phase'],'release':str(release),'receipt':str(receipt_file),'https':plan['origin']},ensure_ascii=False))


def read_env(file):
    values={}
    for line in file.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key,value=line.split('=',1);values[key]=value.strip().strip('\"\'')
    return values


def main():
    plan=make_plan()
    if sys.argv[1:]==['--plan']:
        print(json.dumps(plan,ensure_ascii=False));return
    if len(sys.argv)==3 and sys.argv[1] in ['--maintenance','--activate']:
        stage_control(plan,sys.argv[1],sys.argv[2]);return
    prepare=sys.argv[1:]==['--prepare']
    if not prepare:raise SystemExit('Usage: install-runtime.py --plan|--prepare|--maintenance RELEASE_ID|--activate RELEASE_ID')
    source=pathlib.Path(__file__).resolve().parent.parent
    runtime=pathlib.Path(plan['runtime']);private=runtime/'private';node=shutil.which('node')
    if not node or not (source/'dist/index.js').is_file() or not (source/'web-dist/index.html').is_file():raise SystemExit('Build and verify V4 before installing')
    for port in [*plan['apiPorts'],39613]:
        probe=subprocess.run(['lsof','-tiTCP:'+str(port),'-sTCP:LISTEN'],capture_output=True,text=True)
        for pid in probe.stdout.split():
            command=subprocess.check_output(['ps','-p',pid,'-o','command='],text=True)
            if str(runtime) not in command:raise SystemExit('V4 port occupied by another service: '+str(port))
    env_file=runtime/'.env'
    if env_file.exists():
        if env_file.is_symlink() or env_file.stat().st_mode&0o077:raise SystemExit('Runtime environment must be private regular file')
        values=read_env(env_file)
    else:
        values={key:value for key,value in read_env(source/'.env').items() if key.startswith('RECRUIT_V4_')}
        old=pathlib.Path.home()/'Library/Application Support/RecruitWorkbenchV3/.env'
        previous=read_env(old) if old.is_file() else {}
        for key in ['APP_ID','APP_SECRET','TENANT','ADMINS']:
            name='RECRUIT_V4_FEISHU_'+key
            if not values.get(name):values[name]=previous.get('RECRUIT_V3_FEISHU_'+key,'')
        tls=pathlib.Path.home()/'Library/Application Support/RecruitWorkbenchSQLLab/lab-private'
        values.update({'RECRUIT_V4_ORIGIN':plan['origin'],'RECRUIT_V4_SCHEMA':'recruit_v4','RECRUIT_V4_STORAGE':str(private/'files'),'RECRUIT_V4_CAMPUS_KEY_FILE':str(private/'campus-keys.json'),'RECRUIT_V4_TLS_CERT':str(tls/'tls.crt'),'RECRUIT_V4_TLS_KEY':str(tls/'tls.key'),'RECRUIT_V4_ENV':'production','RECRUIT_V4_ASSET_ROOT':str(private/'web-assets')})
    url=urllib.parse.urlparse(values.get('RECRUIT_V4_DATABASE_URL',''))
    if url.scheme not in ('postgres','postgresql') or url.query or url.fragment or (url.hostname,url.port,url.path,values.get('RECRUIT_V4_SCHEMA'))!=('127.0.0.1',55434,'/recruit_v4','recruit_v4'):raise SystemExit('Installer requires the dedicated V4 production schema')
    if values.get('RECRUIT_V4_ORIGIN')!=plan['origin']:raise SystemExit('Runtime origin differs from the reviewed V4 plan')
    if not all(values.get('RECRUIT_V4_FEISHU_'+key) for key in ['APP_ID','APP_SECRET','TENANT','ADMINS']):raise SystemExit('Missing Feishu identity configuration')
    if len(values.get('RECRUIT_V4_SECRET',''))<40:raise SystemExit('Missing V4 application secret')
    for key in ['RECRUIT_V4_TLS_CERT','RECRUIT_V4_TLS_KEY']:
        if not pathlib.Path(values.get(key,'')).is_file():raise SystemExit('Missing TLS material')
    runtime.mkdir(mode=0o700,parents=True,exist_ok=True);private.mkdir(mode=0o700,exist_ok=True)
    for folder in ['files','logs','backups','web-assets']:(private/folder).mkdir(mode=0o700,exist_ok=True)
    if not env_file.exists():
        with os.fdopen(os.open(env_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as file:file.write('\n'.join(key+'='+value for key,value in values.items())+'\n')
    shutil.copytree(source/'web-dist/assets',private/'web-assets',dirs_exist_ok=True)
    digest=hashlib.sha256()
    for directory in ['dist','migrations','web-dist']:
        for file in sorted((source/directory).rglob('*')):
            if file.is_file():digest.update(str(file.relative_to(source)).encode());digest.update(file.read_bytes())
    for name in ['package.json','package-lock.json']:digest.update((source/name).read_bytes())
    release=runtime/'releases'/digest.hexdigest()[:16]
    if release.is_symlink():raise SystemExit('Refusing a symlink release')
    if (release/'release-manifest.json').exists() and release_proof(release)!=json.loads((release/'release-manifest.json').read_text())['files']:raise SystemExit('Existing release bytes changed')
    release.mkdir(parents=True,exist_ok=True)
    for directory in ['dist','migrations','web-dist']:shutil.copytree(source/directory,release/directory,dirs_exist_ok=True)
    for name in ['package.json','package-lock.json']:shutil.copyfile(source/name,release/name)
    if not (release/'node_modules').exists():subprocess.run(['npm','ci','--omit=dev','--prefer-offline','--fetch-retries=0','--fetch-timeout=15000'],cwd=release,check=True,stdout=subprocess.DEVNULL)
    for name,target in [('.env',env_file),('private',private)]:
        if not (release/name).exists():(release/name).symlink_to(target)
    if prepare:
        revision=max(int(f.stem) for f in (source/'migrations').glob('*.sql'))
        atomic_json(release/'release-manifest.json',{'schemaRevision':revision,'files':release_proof(release)})
        deployments=private/'deployments';deployments.mkdir(mode=0o700,exist_ok=True)
        receipt_file=deployments/(release.name+'.json')
        if not receipt_file.exists():atomic_json(receipt_file,deployment_transition({},'prepare',0,revision))
        print(json.dumps({'prepared':True,'runtime':str(runtime),'release':str(release),'https':plan['origin'],'agentsStarted':False},ensure_ascii=False));return

if __name__=='__main__':main()

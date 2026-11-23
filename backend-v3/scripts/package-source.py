"""Build and inspect an allowlisted source archive; never include runtime data."""
import hashlib,json,pathlib,re,sys,zipfile
project=pathlib.Path(__file__).resolve().parents[2]
destination=pathlib.Path(sys.argv[1]).resolve()
allowed=[project/p for p in ('README.md','package.json','package-lock.json','.env.example','.gitignore')]
backend=project/'backend-v3'
allowed += [backend/p for p in ('package.json','package-lock.json','tsconfig.json','.env.example','.gitignore','compose.v3.yaml') if (backend/p).is_file()]
for directory in ('src','test','scripts','migrations'):
    allowed += [p for p in (backend/directory).rglob('*') if p.is_file() and p.suffix in ('.ts','.sql','.py') and '__pycache__' not in p.parts]
allowed += [p for p in (project/'web').rglob('*') if p.is_file() and 'node_modules' not in p.parts and p.suffix in ('.ts','.tsx','.css','.html','.json')]
allowed += [project/'design-qa.md'] if (project/'design-qa.md').is_file() else []
allowed += [p for p in (project/'docs').rglob('*') if p.is_file() and p.suffix in ('.md','.json')]
allowed += [p for p in (project/'qa').glob('v3-*') if p.is_file() and p.suffix in ('.md','.json')]
secrets=[]
for config in (backend/'.env',pathlib.Path.home()/'Library/Application Support/RecruitWorkbenchV3/.env',pathlib.Path.home()/'Library/Application Support/RecruitWorkbenchSQLLab/lab-private/feishu.env'):
    if config.exists():
        for line in config.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                key,value=line.split('=',1)
                if any(term in key.upper() for term in ('SECRET','PASSWORD','DATABASE_URL')) and len(value.strip())>=12:
                    secrets.append(value.strip().strip('"\'').encode())
files={}
for file in sorted(set(allowed)):
    if file.is_symlink(): raise SystemExit('Refusing symlink: '+file.name)
    data=file.read_bytes();relative=file.relative_to(project).as_posix()
    if any(secret in data for secret in secrets) or re.search(rb'-----BEGIN (?:RSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}', data):
        raise SystemExit('Private material detected in '+relative)
    files[relative]=data
manifest={name:hashlib.sha256(data).hexdigest() for name,data in files.items()}
destination.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for name,data in files.items():archive.writestr('recruit-backend-v3/'+name,data)
    archive.writestr('recruit-backend-v3/SOURCE-MANIFEST.json',json.dumps(manifest,indent=2))
with zipfile.ZipFile(destination) as archive:
    if archive.testzip() is not None:raise SystemExit('Corrupt archive')
    for name,want in manifest.items():
        if hashlib.sha256(archive.read('recruit-backend-v3/'+name)).hexdigest()!=want:raise SystemExit('Archive hash mismatch')
    for name in archive.namelist():
        parts=pathlib.PurePosixPath(name).parts
        if any(p in ('.env','private','node_modules','dist','test-results','reference-ui-v2') for p in parts):raise SystemExit('Disallowed archive entry')
print(json.dumps({'archive':str(destination),'files':len(files)+1,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'allowlistAndSecretCheck':'passed'},ensure_ascii=False))

"""Failure injection against installer control flow; only temporary files and fake OS processes."""
import importlib.util,json,pathlib,sys,tempfile,types
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('installer',pathlib.Path('scripts/install-runtime.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def scenario(fault):
 with tempfile.TemporaryDirectory(prefix='recruit-installer-test-') as tmp:
  home=pathlib.Path(tmp).resolve();plan=m.make_plan(home);root=pathlib.Path(plan['runtime']);private=root/'private';(private/'deployments').mkdir(parents=True);(private/'backups').mkdir();(home/'Library/LaunchAgents').mkdir(parents=True)
  old=root/'releases'/'1111111111111111';release=root/'releases'/'eeeeeeeeeeeeeeee'
  for folder,rev in [(old,11),(release,14)]:
   for d in ['dist','migrations','web-dist']:(folder/d).mkdir(parents=True)
   (folder/'migrations'/f'{rev:03d}.sql').write_text('-- synthetic')
   for name in ['package.json','package-lock.json']:(folder/name).write_text('{}')
  m.atomic_json(release/'release-manifest.json',{'schemaRevision':14,'files':m.release_proof(release)})
  receipt=private/'deployments'/(release.name+'.json');m.atomic_json(receipt,{'phase':'prepared'});m.atomic_json(root/'installed.json',{'release':str(old)})
  state={'revision':11,'increment':0,'ready':False,'crash':fault=='after_commit','clock':0,'pid':100};loaded={};backups=[];events=[];atomic=m.atomic_json
  def run(args,**kwargs):
   if args[:2]==['launchctl','print']:
    label=args[2].split('/')[-1];return types.SimpleNamespace(returncode=0 if label in loaded else 1,stdout='state = running\n pid = '+str(loaded[label]) if label in loaded else '',stderr='')
   if args[:2]==['launchctl','bootstrap']:
    import plistlib
    label=plistlib.loads(pathlib.Path(args[3]).read_bytes())['Label'];state['pid']+=1;loaded[label]=state['pid'];events.append(('start',label))
    if 'worker-' in label:state['increment']+=1
   elif args[:2]==['launchctl','bootout']:loaded.pop(args[2].split('/')[-1],None);events.append(('stop',args[2]))
   elif args[:2]==['kill','-0']:return types.SimpleNamespace(returncode=0 if int(args[2]) in loaded.values() else 1,stdout='')
   return types.SimpleNamespace(returncode=0,stdout='',stderr='')
  def output(args,**kwargs):
   command=args[2]
   if command=='inspect':return json.dumps({'schemaRevision':state['revision']})
   if command in ['backup','backup-runtime']:
    assert not any('gateway' not in label for label in loaded),'writers not drained'
    selected=pathlib.Path(kwargs['cwd']);assert not (state['revision']==14 and selected==old),'old backup used on upgraded database'
    dest=pathlib.Path(args[3]);dest.mkdir(parents=True);(dest/'manifest.json').write_text(json.dumps({'revision':state['revision'],'increment':state['increment']}));backups.append((state['revision'],state['increment'],selected));return '{"ok":true}'
   if command=='upgrade':
    assert not any('gateway' not in label for label in loaded);state['revision']=14;return '{"schemaRevision":14}'
   raise AssertionError(args)
  def save(file,value):
   if file==receipt and value.get('phase')=='upgraded' and state['crash']:state['crash']=False;raise OSError('synthetic crash after SQL commit before receipt')
   atomic(file,value)
  def clock():state['clock']+=100;return state['clock']
  ready=lambda _: {'status':'ready' if state['ready'] else 'starting'}
  with patch.object(pathlib.Path,'home',return_value=home),patch.object(m.shutil,'which',return_value='/synthetic/node'),patch.object(m.subprocess,'run',side_effect=run),patch.object(m.subprocess,'check_output',side_effect=output),patch.object(m.urllib.request,'urlopen',return_value=None),patch.object(m.json,'load',side_effect=ready),patch.object(m.time,'monotonic',side_effect=clock),patch.object(m.time,'sleep'),patch.object(m,'atomic_json',side_effect=save):
   m.stage_control(plan,'--maintenance',release.name)
   try:m.stage_control(plan,'--activate',release.name);raise AssertionError('injected activation succeeded')
   except (SystemExit,OSError):pass
   assert state['revision']==14 and json.loads((root/'installed.json').read_text())['release']==str(old)
   assert json.loads(receipt.read_text())['phase']==('maintenance' if fault=='after_commit' else 'upgraded')
   if fault=='after_commit':
    try:m.stage_control(plan,'--activate',release.name);raise AssertionError('unreconciled SQL commit accepted')
    except SystemExit:pass
   increment=state['increment'];m.stage_control(plan,'--maintenance',release.name)
   assert backups[-1][:2]==(14,increment) and backups[-1][2]==release
   state['ready']=True;m.stage_control(plan,'--activate',release.name)
   assert json.loads(receipt.read_text())['phase']=='active' and not (private/'maintenance.json').exists()
   assert json.loads((root/'installed.json').read_text())['release']==str(release)
for fault in ['readiness','after_commit']:scenario(fault)
print('readiness and post-commit interruption recovery passed; no real service touched')

"""Pure V4 runtime layout. Does not write files or stop/start services."""
import json, pathlib, shutil

def deployment_transition(receipt,action,live_revision,candidate_revision):
    r=dict(receipt)
    if candidate_revision<live_revision:raise ValueError('database downgrade forbidden')
    phase=r.get('phase')
    if action=='prepare':
        if phase not in (None,'prepared'):raise ValueError('prepare phase invalid')
        r.update(phase='prepared',supportedRevision=candidate_revision,newWrites=False)
    elif action=='maintenance':
        if phase not in ('prepared','maintenance','upgraded','active'):raise ValueError('maintenance requires prepared release')
        r['phase']='maintenance'
    elif action=='upgrade':
        if phase!='maintenance' or not r.get('backup'):raise ValueError('consistent backup required before upgrade')
        r.update(phase='upgraded',schemaRevision=candidate_revision)
    elif action=='activate':
        if phase!='upgraded' or live_revision!=candidate_revision:raise ValueError('activate requires upgraded compatible database')
        r.update(phase='active',newWrites=True)
    elif action=='recover':
        if phase not in ('active','upgraded','maintenance') or not r.get('incrementalBackup'):raise ValueError('incremental backup required before forward recovery')
        r.update(phase='maintenance',recovery='forward_compatible_only',writersStarted=False)
    else:raise ValueError('unknown deployment action')
    return r

def backup_strategy(live_revision,candidate_revision,installed_revision):
    if live_revision>candidate_revision:raise ValueError('database downgrade forbidden')
    return 'installed' if live_revision<=11 and live_revision==installed_revision else 'candidate_runtime'

def make_plan(home=None):
    runtime=(pathlib.Path(home) if home else pathlib.Path.home())/'Library/Application Support/RecruitWorkbenchV4'
    definitions=[('api-a','index.js',39611),('api-b','index.js',39612),('worker-a','worker-main.js',None),('worker-b','worker-main.js',None),('sourcing-worker','sourcing-discovery/worker-main.js',None),('gateway','gateway.js',None),('backup','operations/cli.js',None)]
    return {'version':'4.0.0','runtime':str(runtime),'origin':'https://hzpc3929demacbook-pro.local:39613','apiPorts':[39611,39612],'database':{'host':'127.0.0.1','port':55434,'name':'recruit_v4','schema':'recruit_v4'},'preservedEntries':[39413,39513,18080], 'agents':[{'role':role,'entry':entry,'port':port,'label':'com.hzpc.recruit.v4.'+role,'environment':{'RECRUIT_V4_INSTANCE':'v4-'+role,**({'SOURCING_DEEPSEEK_CONFIG_FILE':str(runtime/'private/sourcing-deepseek.json')} if role in ['api-a','api-b','sourcing-worker'] else {}),**({'RECRUIT_V4_PORT':str(port)} if port else {})}} for role,entry,port in definitions]}

if __name__=='__main__':
    print(json.dumps(make_plan(),ensure_ascii=False))

// Explicit live-provider smoke check in an isolated, disposable schema only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {loadConfig} from '../dist/config.js';
import {Database} from '../dist/db.js';
import {Identity} from '../dist/identity/service.js';
import {FeishuProvider} from '../dist/identity/provider.js';
import {TaskService} from '../dist/tasks/service.js';
import {Worker} from '../dist/tasks/worker.js';
import {FileStore} from '../dist/files/storage.js';
import {BusinessConfigService} from '../dist/business-config/service.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'recognition-smoke-'));
const config=loadConfig({...process.env,RECRUIT_V4_SCHEMA:'recruit_test_recognition'+randomBytes(5).toString('hex'),RECRUIT_V4_STORAGE:path.join(dir,'files'),RECRUIT_V4_ENV:'test'});
if(!config.recognitionConfigFile)throw Error('recognition_config_required');
const db=new Database(config),store=new FileStore(config.storageRoot);
try{
 await db.migrate();
 const identity=new Identity(db,config,new FeishuProvider(config));await new BusinessConfigService(identity).seed();
 const actor=(await db.query("INSERT INTO users(tenant,app_id,open_id,name,status,roles) VALUES('synthetic','synthetic','fixture','Synthetic verifier','active',ARRAY['admin']) RETURNING *")).rows[0];
 const file=path.join(dir,'fixture.pdf');
 execFileSync(config.recognitionPython||'python3',['-c',"import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((60,70),'Resume\\nName: Example Tester\\nEmail: fixture@example.invalid\\nEducation: Bachelor of Science, Example University\\nSkills: Python\\nWork experience: 5 years\\nDesired position: Backend engineer',fontsize=14); d.save(sys.argv[1])",file],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 const task=await new TaskService(identity,store).upload(actor,{name:'fixture.pdf',data:await readFile(file),newCandidatesOnly:true});
 const worker=new Worker(identity,store,'recognition-live-smoke');await worker.once();
 const done=(await db.query('SELECT state,error_code,result FROM tasks WHERE id=$1',[task.id])).rows[0];assert.equal(done.state,'succeeded',JSON.stringify(done));assert.ok(done.result.candidateId);
 const parsed=(await db.query('SELECT * FROM parse_results WHERE id=$1',[done.result.parseResultId])).rows[0];
 assert.equal(parsed.parser_version,'deepseek-vision-1.0.0');assert.equal(parsed.profile.name,'Example Tester');assert.equal(parsed.profile.email,'fixture@example.invalid');assert.equal(parsed.profile.experienceYears,5);assert.equal(parsed.recognition.document_type,'resume');assert.ok(parsed.profile.skills.includes('Python'));assert.equal((await db.query('SELECT count(*)::int n FROM applications')).rows[0].n,0);
 const audit=(await db.query("SELECT detail FROM audit_events WHERE kind='resume.parse'")).rows[0].detail;
 console.log(JSON.stringify({ok:true,parser:parsed.parser_version,model:audit.model,tokens:audit.tokens,elapsedMs:audit.elapsedMs,pdfOcr:true,persisted:true,externalMessages:0}));
}finally{await db.query('DROP SCHEMA "'+config.schema+'" CASCADE');await db.close();await rm(dir,{recursive:true,force:true});}

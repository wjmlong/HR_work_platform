import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {configFixture,fieldDefinition,publishDefinition} from './business-config-fixture.js';
import {actor} from './helpers.js';
import {ConfiguredEntities} from '../src/business-config/entities.js';
import {CampusService} from '../src/campus/service.js';
import {RecruitingService} from '../src/recruiting/service.js';
import {InterviewService} from '../src/interviews/service.js';
import {readFieldValues} from '../src/business-config/fields.js';
async function definition(f:any,kind:string,extra:any[]=[]){const current=await f.configs.effective(f.admin,kind),doc=await f.configs.version(f.admin,current.ref);await publishDefinition(f,{...doc,fields:[...doc.fields,...extra]});return f.configs.effective(f.admin,kind);}
const meta=(d:any)=>({definitionVersion:d.ref.version,definitionRevision:d.aclRevision});
test('configured_entities_remain_separate: identical field IDs in distinct entities have isolated facts and do not advance clocks',async t=>{
 const f=await configFixture(t),c=new ConfiguredEntities(f.identity),ld=await definition(f,'lead',[fieldDefinition()]),cd=await definition(f,'campus',[fieldDefinition()]);
 const lead=await c.write(f.admin,'lead',null,{name:'Synthetic lead',org:'Lab',direction:'Research',line:'high',source:'顶会论文',...meta(ld),customFields:{'custom.portfolio':'线索值'}});
 const campus=await c.write(f.admin,'campus',null,{school:'Synthetic campus',...meta(cd),customFields:{'custom.portfolio':'校招值'}});
 const lv=await readFieldValues(f.identity,f.admin,{kind:'lead',id:lead.id}),cv=await readFieldValues(f.identity,f.admin,{kind:'campus',id:campus.id});assert.notDeepEqual(lv,cv);
 const updated=await c.write(f.admin,'lead',lead.id,{version:lead.version,note:'仅修改资料',...meta(ld),customFields:{'custom.portfolio':'线索值2'}});
 assert.equal(updated.last_contacted_at,lead.last_contacted_at);assert.equal(updated.state,'uncontacted');
});
test('campus_custom_export_cannot_reveal_credentials: ordinary definitions reject secrets and general metadata never exposes ciphertext or plaintext',async t=>{
 const f=await configFixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'configured-campus-'));t.after(()=>rm(dir,{recursive:true,force:true}));f.config.campusKeyFile=path.join(dir,'key.json');
 const c=new ConfiguredEntities(f.identity),d=await definition(f,'campus'),doc=await f.configs.version(f.admin,d.ref);
 for(const field of [fieldDefinition({fieldId:'custom.password',label:'登录密码'}),fieldDefinition({fieldId:'custom.key',label:'访问令牌'})])await assert.rejects(f.configs.saveDraft(f.admin,{key:'fields.campus',baseVersion:d.ref.version,document:{...doc,fields:[...doc.fields,field]}}),/credential_field_forbidden/);
 await f.configs.saveDraft(f.admin,{key:'fields.campus',baseVersion:d.ref.version,document:{...doc,fields:[...doc.fields,fieldDefinition({fieldId:'custom.credentialExpiry',label:'账号到期日',type:'date'})]}});
 const row=await c.write(f.admin,'campus',null,{school:'Synthetic secure campus',...meta(d),credentials:{account:{action:'replace',value:'synthetic-account'},password:{action:'replace',value:'synthetic-password'}}});
 assert.ok(!JSON.stringify(row).includes('synthetic-password'));assert.ok(!JSON.stringify(row).includes('cipher'));
 const recruiter=await actor(f.db,['recruiter']),s=new CampusService(f.identity);await assert.rejects(s.query(recruiter,{query:'synthetic-account',accountSearch:true}),/forbidden/);
 const result=await s.query(recruiter,{query:'synthetic-password'});assert.equal(result.total,0);
});
test('interview/evaluation definitions stay distinct; submitted text is versioned and private drafts cannot be read through custom fields',async t=>{
 const f=await configFixture(t),r=new RecruitingService(f.identity),i=new InterviewService(f.identity),c=new ConfiguredEntities(f.identity),j=await r.createJob(f.admin,{name:'Synthetic configured interview',level:'P5'}),p=await r.createCandidate(f.admin,{name:'Synthetic candidate'}),ap=await r.apply(f.admin,{candidateId:p.id,jobId:j.id});
 const id=await definition(f,'interview',[fieldDefinition()]),ed=await definition(f,'evaluation',[fieldDefinition()]);
 const meeting=await c.write(f.admin,'interview',null,{applicationId:ap.id,round:1,startsAt:'2030-01-01T09:00:00Z',durationMinutes:30,form:'online',interviewerIds:[f.admin.id],...meta(id),customFields:{'custom.portfolio':'排期扩展'}});
 const draft=await c.evaluate(f.admin,meeting.id,{version:0,status:'draft',data:{summary:'私有草稿'},...meta(ed),customFields:{'custom.portfolio':'评估扩展'}});
 const other=await actor(f.db);await assert.rejects(readFieldValues(f.identity,other,{kind:'evaluation',id:draft.id}),/private_evaluation_draft/);
 const submitted=await c.evaluate(f.admin,meeting.id,{version:draft.version,status:'submitted',data:{summary:'人工评估结论',evidenceNotes:'已核对项目事实',conclusion:'hold'},...meta(ed),customFields:{'custom.portfolio':'已核对'}});
 const v=await c.evaluationVersion(f.admin,submitted.id,submitted.version);assert.equal(v.customFields['custom.portfolio'],'已核对');
 assert.equal((await r.application(f.admin,ap.id)).status,'screening');assert.equal((await i.list(f.admin))[0].status,'pending');
});

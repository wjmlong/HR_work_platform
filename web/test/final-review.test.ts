import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

test('review: lost committed response retries the logical operation; successful completion, payload and session changes start new intents',async t=>{
 const source=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const {api,setCsrf}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const keys:string[]=[],committed=new Map<string,any>();let lose=true;
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=(async(_url:any,options:any)=>{const key=options.headers['idempotency-key'];keys.push(key);if(!committed.has(key))committed.set(key,{id:committed.size+1});if(lose){lose=false;throw new TypeError('response lost after commit');}return new Response(JSON.stringify({data:committed.get(key)}),{status:200,headers:{'content-type':'application/json'}});}) as any;
 setCsrf('session-A');const command={method:'POST',body:{name:'Synthetic job'}};
 await assert.rejects(api('/jobs',command),/response lost/);
 assert.deepEqual(await api('/jobs',command),{id:1});assert.equal(keys[0],keys[1]);assert.equal(committed.size,1);
 await api('/jobs',command);assert.notEqual(keys[2],keys[1]);
 lose=true;await assert.rejects(api('/jobs',command));await api('/jobs',{method:'POST',body:{name:'Deliberate new payload'}});assert.notEqual(keys[3],keys[4]);
 setCsrf('session-B');await api('/jobs',command);assert.notEqual(keys[3],keys[5]);
});
test('review: a truncated successful versioned response retries its existing key and upload bytes define the operation',async t=>{
 const source=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const {api,setCsrf}=await import('data:text/javascript;base64,'+Buffer.from(code+'\n// isolated test').toString('base64'));
 const keys:string[]=[];let lose=true;const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=(async(_url:any,options:any)=>{keys.push(options.headers['idempotency-key']);if(lose){lose=false;return {ok:true,json:async()=>{throw Error('truncated response');}};}return new Response(JSON.stringify({data:{version:2}}),{status:200});}) as any;
 setCsrf('versioned-session');const command={method:'PATCH',body:{version:1,name:'Synthetic'}};await assert.rejects(api('/jobs/j',command),/truncated/);assert.deepEqual(await api('/jobs/j',command),{version:2});assert.equal(keys[0],keys[1]);
 const form=()=>{const f=new FormData();f.set('file',new File(['Synthetic resume'],'synthetic.txt'));return f;};lose=true;await assert.rejects(api('/uploads',{method:'POST',body:form()}));await api('/uploads',{method:'POST',body:form()});assert.equal(keys[2],keys[3]);
});
test('review: material citation variants remain readable and use the saved match/template plus exact resume and evaluation versions',async()=>{
 const {resolveBriefCitation}=await import('../src/lib/citations.ts');
 const calls:string[]=[],material={inputs:{matchSnapshotId:'match-old',jobVersion:2,resumeVersionId:'resume-old'},data:{professionalComparison:{skills:[{requirement:'Python',status:'unknown',evidence:[]}],experience:{status:'not_matched'},education:{status:'matched'}},evaluations:[]}};
 const load=async(path:string)=>{calls.push(path);if(path==='/resumes/resume-old/raw')return {resumeVersionId:'resume-old',raw:'姓名：Synthetic\n期望薪资：30k',profile:{expectedSalary:'30k'}};if(path==='/evaluations/e/versions/2')return {version:2,data:{summary:'Saved summary',evidenceNotes:'Saved evidence',conclusion:'hold'}};throw Error('mutable target must not be read');};
 const match=await resolveBriefCitation(material,{matchSnapshotId:'match-old',path:'/api/v4/applications/a/matches'},load);assert.equal(match.kind,'match');assert.ok(match.text.includes('Python'));assert.ok(match.text.includes('字段未识别'));assert.ok(match.text.includes('match-old'));assert.equal(calls.length,0);
 const none=await resolveBriefCitation(material,{path:'/api/v4/applications/a/evaluations'},load);assert.equal(none.kind,'evaluation_absence');assert.ok(none.text.includes('生成时'));assert.equal(calls.length,0);
 const rule=await resolveBriefCitation(material,{kind:'rule_template',rule:'salary-conversation-v1',jobVersion:2,templateText:'Saved rule text',path:'/api/v4/jobs/j/public-jd'},load);assert.equal(rule.kind,'rule');assert.ok(rule.text.includes('Saved rule text'));assert.equal(calls.length,0);
 const raw=await resolveBriefCitation(material,{resumeVersionId:'resume-old',path:'/api/v4/resumes/resume-old/raw'},load);assert.equal(raw.kind,'resume');assert.ok(raw.text.includes('期望薪资：30k'));
 const e=await resolveBriefCitation(material,{evaluationId:'e',version:2,path:'/api/v4/evaluations/e/versions/2'},load);assert.equal(e.kind,'evaluation');assert.ok(e.text.includes('Saved evidence'));assert.ok(e.text.includes('待定'));
 assert.deepEqual(calls,['/resumes/resume-old/raw','/evaluations/e/versions/2']);
 await assert.rejects(resolveBriefCitation(material,{matchSnapshotId:'different'},load),/引用/);
});
test('configured material citations use the saved permitted fact span when original context is restricted',async()=>{const {resolveSavedFact}=await import('../src/lib/citations.ts');let calls=0;const fact={text:'Python',citation:{resumeVersionId:'r-old',evidenceId:'e',start:90,end:96,line:4}},material={inputs:{resumeVersionId:'r-old',sourceAccess:{fullResume:false}},data:{facts:[fact]}};const value=await resolveSavedFact(material,fact,async()=>{calls++;throw Error('must not load whole original');});assert.equal(value.raw,'Python');assert.equal(value.citation.start,0);assert.equal(value.citation.end,6);assert.equal(value.citation.line,4);assert.equal(value.limited,true);assert.equal(calls,0);await assert.rejects(resolveSavedFact(material,{...fact,text:'forged'},async()=>null),/引用/);});

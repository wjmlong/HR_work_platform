import fs from 'node:fs/promises';import path from 'node:path';import {analyze} from './analyze.mjs';import {fixtures} from './fixtures.mjs';
const [config,out]=process.argv.slice(2);if(!config||!out)throw Error('usage: node run.mjs PRIVATE_MODEL_CONFIG OUTPUT_DIRECTORY');
await fixtures(out);const results=[];
for(const name of ['resume.txt','resume.png','two-column-scan.pdf']){
 try{const r=await analyze(path.join(out,name),config);await fs.writeFile(path.join(out,name+'.result.json'),JSON.stringify(r,null,2),{mode:0o600});
 const facts=r.result.facts,has=(field,re,status)=>facts.some(f=>f.field===field&&re.test(f.value)&&(!status||f.status===status));
 const checks={name:has('name',/林测试/),education:has('education',/本科/),python:has('skill',/python/i,'explicit'),sql:has('skill',/sql/i,'explicit'),javaNotPositive:!has('skill',/java/i,'explicit'),javaNegated:has('skill',/java/i,'negated'),kubernetesUncertain:has('skill',/kubernetes/i,'uncertain'),yearsNotSummed:has('experienceYears',/^3(?:年)?$/),compensation:has('expectedCompensation',/30.*35/)};
 const entry={name,pass:Object.values(checks).every(Boolean),checks,...r.metrics};results.push(entry);console.log(JSON.stringify(entry));
 }catch(e){results.push({name,pass:false,error:e.message});console.log(JSON.stringify({name,error:e.message}));}
 await fs.writeFile(path.join(out,'acceptance.json'),JSON.stringify({localOnly:true,productionModified:false,results},null,2),{mode:0o600});
}

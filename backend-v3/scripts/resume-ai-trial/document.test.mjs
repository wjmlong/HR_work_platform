import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareIsolated} from './analyze.mjs';
test('DOCX extracts body without following external template and rejects XML entities',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'resume-docx-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'external.docx'),bad=path.join(dir,'entity.docx');
 execFileSync(process.env.RECRUIT_TRIAL_PYTHON||'python3',['-c',`import zipfile,sys
body='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文简历 测试甲 本科</w:t></w:r></w:p></w:body></w:document>'
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('word/document.xml',body)
 z.writestr('word/_rels/settings.xml.rels','<Relationships><Relationship TargetMode="External" Target="https://invalid.example/template.dotm"/></Relationships>')
with zipfile.ZipFile(sys.argv[2],'w') as z:
 z.writestr('word/document.xml','<!DOCTYPE test [<!ENTITY bad SYSTEM "file:///etc/passwd">]>'+body)
`,file,bad]);
 const r=await prepareIsolated(file,10000);assert.match(r.pages[0].text,/中文简历 测试甲 本科/);await assert.rejects(prepareIsolated(bad,10000),/invalid_docx/);
});

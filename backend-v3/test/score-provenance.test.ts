import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProfile} from '../src/parsing/profile.js';
import {pinnedParsed} from '../src/business-config/bindings.js';
import {compareConfiguredProfile,defaultMatchTemplate} from '../src/business-config/match-template.js';
const dictionary={ref:{configId:'10000000-0000-4000-8000-000000000001',version:3},aliases:{'融资':'融资','宽带薪酬':'薪酬设计','薪酬设计':'薪酬设计'}};
const raw='负责融资项目及宽带薪酬设计。\n学历：本科\n5年工作经验';
const correction={field:'skills',value:['培训'],actorId:'fixture',reason:'恢复旧版备份中的结构化字段；原操作人未提供',at:'2026-10-19T00:00:00Z'};
function row(corrections:any[]){const p=parseProfile(raw);return {profile:{...p.profile,skills:['培训']},evidence:p.evidence,parser_version:p.parserVersion,human_corrections:corrections,parse_created_at:'2026-10-19T00:00:00Z'};}
test('verified legacy skill provenance uses literal resume evidence instead of imported tags',()=>{
 const parsed=pinnedParsed(row([{...correction,source:'legacy_import'}]),raw,dictionary);
 const score=compareConfiguredProfile(parsed,raw,{skills:['融资'],education:'bachelor',experienceYears:3},defaultMatchTemplate(),dictionary);
 assert.equal(score.skills[0].status,'matched');assert.equal(score.skillPoints,60);
 assert.ok(score.skills[0].evidence.some(e=>e.text==='融资'));assert.equal(score.skills[0].assertions.length,0);
});
test('an unverified old-looking reason and later human skill corrections remain authoritative',()=>{
 for(const corrections of [[correction],[{...correction,source:'legacy_import'},{...correction,value:['培训'],reason:'面试官核对只确认培训',at:'2026-11-11T00:00:00Z'}]]){
  const parsed=pinnedParsed(row(corrections),raw,dictionary);
  const score=compareConfiguredProfile(parsed,raw,{skills:['融资']},defaultMatchTemplate(),dictionary);
  assert.equal(score.skillPoints,0);assert.equal(score.skills[0].assertions.length,1);
 }
});

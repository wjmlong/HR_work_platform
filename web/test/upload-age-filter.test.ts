import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ageMatches,candidateAge,candidateAgeText,AGE_START} from '../src/lib/candidate-age.ts';

test('resume age is shown as recorded, never marked as an estimate',()=>{
  assert.deepEqual(candidateAge({age:31,experienceYears:6,education:'master'}),{value:31,estimated:false});
  assert.deepEqual(candidateAgeText({age:31,experienceYears:6,education:'master'}),{text:'31 岁',estimated:false});
  assert.deepEqual(candidateAge({age:'44'}),{value:44,estimated:false});
});

test('missing age falls back to start age by education plus experience years and is labelled as an estimate',()=>{
  for(const [education,start] of Object.entries(AGE_START))
    assert.deepEqual(candidateAge({age:null,experienceYears:4,education}),{value:start+4,estimated:true});
  assert.deepEqual(candidateAge({age:null,experienceYears:6,education:'master'}),{value:31,estimated:true});
  assert.equal(candidateAgeText({age:null,experienceYears:6,education:'master'}).text,'31（预计）');
});

test('unknown education uses the bachelor start age instead of inventing a range',()=>{
  assert.deepEqual(candidateAge({experienceYears:5,education:'unknown'}),{value:27,estimated:true});
  assert.deepEqual(candidateAge({experienceYears:5}),{value:27,estimated:true});
});

test('implausible or absent inputs produce no age rather than a fabricated one',()=>{
  assert.deepEqual(candidateAge({age:0,experienceYears:null,education:'bachelor'}),{value:null,estimated:false});
  assert.deepEqual(candidateAge({age:121,experienceYears:undefined,education:'master'}),{value:null,estimated:false});
  assert.deepEqual(candidateAge({age:-3,experienceYears:-1}),{value:null,estimated:false});
  assert.deepEqual(candidateAge(null),{value:null,estimated:false});
  assert.equal(candidateAgeText({}).text,'—');
});

test('age buckets cover both boundaries and exclude rows that cannot be estimated',()=>{
  const bucket=(age:number|null,experienceYears:number|null=null)=>ageMatches({age,experienceYears},'le30');
  assert.equal(bucket(30),true);
  assert.equal(bucket(31),false);
  assert.equal(ageMatches({age:31},'31to40'),true);
  assert.equal(ageMatches({age:40},'31to40'),true);
  assert.equal(ageMatches({age:41},'31to40'),false);
  assert.equal(ageMatches({age:41},'41to50'),true);
  assert.equal(ageMatches({age:50},'41to50'),true);
  assert.equal(ageMatches({age:51},'gt50'),true);
  assert.equal(ageMatches({age:50},'gt50'),false);
  assert.equal(ageMatches({age:null},'le30'),false);
  assert.equal(ageMatches({age:null},'none'),true);
  assert.equal(ageMatches({age:52},'none'),false);
  assert.equal(ageMatches({age:52},''),true);
  assert.equal(ageMatches({age:null},''),true);
});

test('the upload page renders the age column, its filter and the page-level estimate note',()=>{
  const source=readFileSync(new URL('../src/features/Upload.tsx',import.meta.url),'utf8');
  assert.match(source,/aria-label="按年龄筛选"/);
  assert.match(source,/30 岁及以下/);
  assert.match(source,/无法测算/);
  assert.match(source,/ageMatches\(a\.profile,ageFilter\)/);
  assert.match(source,/colSpan=\{8\}/);
  assert.match(source,/起算年龄 \+ 工作年限推算/);
});

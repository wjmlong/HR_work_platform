import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isMyEvaluation,pendingEvaluations} from '../src/lib/interview-mine.ts';

const me='u-me',other='u-other';
const rows=[
  {id:'primary',status:'pending',primary_interviewer_id:me,interviewer_ids:[me,other]},
  {id:'participant',status:'pending',primary_interviewer_id:other,interviewer_ids:[other,me]},
  {id:'stranger',status:'pending',primary_interviewer_id:other,interviewer_ids:[other]},
  {id:'cancelled',status:'cancelled',primary_interviewer_id:me,interviewer_ids:[me]},
  {id:'done',status:'passed',primary_interviewer_id:me,interviewer_ids:[me]},
];

test('primary interviewer and participating interviewers both count as mine',()=>{
  assert.equal(isMyEvaluation(rows[0],me),true);
  assert.equal(isMyEvaluation(rows[1],me),true);
  assert.equal(isMyEvaluation(rows[2],me),false);
  assert.deepEqual(pendingEvaluations(rows,me).map(r=>r.id),['primary','participant','done']);
});

test('cancelled, recycled and anonymous rows never appear as pending evaluation',()=>{
  assert.deepEqual(pendingEvaluations(rows,me,true).map(r=>r.id),[]);
  assert.equal(isMyEvaluation(rows[3],me),false);
  assert.equal(isMyEvaluation(rows[0],''),false);
  assert.equal(isMyEvaluation({primary_interviewer_id:me},me),true);
  assert.equal(isMyEvaluation({interviewer_ids:null},me),false);
});

test('the schedule page keeps one evaluation entry: 待我评估 tabs, sidebar merge and shared route highlight',()=>{
  const read=(p:string)=>readFileSync(new URL(p,import.meta.url),'utf8');
  const page=read('../src/features/Interviews.tsx');
  assert.match(page,/待我评估/);
  assert.match(page,/全部面试/);
  assert.match(page,/pendingEvaluations\(/);
  assert.match(page,/initialMine/);
  const app=read('../src/App.tsx');
  assert.match(app,/case "evaluations":\s*\n\s*return <Interviews key="schedule-mine" initialMine \/>/);
  assert.doesNotMatch(app,/case "evaluations":\s*\n\s*return <Interviews key="evaluation" evaluate \/>/);
  const shell=read('../src/components/WorkspaceShell.tsx');
  assert.doesNotMatch(shell,/'evaluations',/);
  assert.match(shell,/active === 'evaluations' \? 'interviews'/);
});

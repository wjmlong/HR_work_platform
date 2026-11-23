import test from 'node:test';
import assert from 'node:assert/strict';
import {peopleLanding,initialPage} from '../src/lib/prd.ts';
test('new talent landing never swallows existing job, stage, mode or saved-view links',()=>{
 assert.equal(initialPage('#inbox'),'inbox');assert.equal(peopleLanding('#people'),'archive');
 for(const link of ['#people?job=job1','#people?job=job1&stage=screening','#people?mode=people','#people?mode=applications','#people?view_resume=saved'])assert.equal(peopleLanding(link),'legacy');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmationCard} from '../src/feishu-feedback/card.js';
test('card sends only schedule details and submits input with the chosen decision',()=>{
 const card:any=confirmationCard({id:'01234567-1111-2222-3333-444444444444',round:2,startsAt:'2030-01-01T09:00:00Z',durationMinutes:45,token:'signed'},'招聘测试岗位');
 assert.equal(card.schema,'2.0');assert.equal(card.config.enable_forward,false);
 const form=card.body.elements.find((x:any)=>x.tag==='form');assert.ok(form);
 const buttons=form.elements.filter((x:any)=>x.tag==='button');assert.equal(buttons.length,2);
 assert.deepEqual(buttons.map((x:any)=>x.behaviors[0].value.decision),['accepted','declined']);
 assert.ok(buttons.every((x:any)=>x.action_type==='form_submit'));
 assert.match(JSON.stringify(card),/2030/);assert.match(JSON.stringify(card),/17:00/);
 assert.doesNotMatch(JSON.stringify(card),/candidate|salary|resume|meeting_url|https:/);
});

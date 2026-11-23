import test from 'node:test';
import assert from 'node:assert/strict';
import {moneyDraft,changeMoneyPeriod} from '../src/lib/money.ts';
test('money form draft preserves exact typed amounts and leaves component assumptions unknown',()=>{
 const value=moneyDraft({min:'9007199254740993.20',raw:'原始说明'});
 assert.equal(value.min,'9007199254740993.20');assert.equal(value.currency,'CNY');assert.equal(value.period,'annual');assert.equal(value.includesBonus,'unknown');assert.equal(value.includesEquity,'unknown');
 assert.equal(moneyDraft({min:'0'}).min,'0');
});
test('changing the money period clears amounts for explicit re-entry instead of silently reinterpreting annual as monthly',()=>{
 const previous=moneyDraft({min:'300000',max:'400000',raw:'年包30-40万'}),changed=changeMoneyPeriod(previous,'monthly');
 assert.equal(changed.min,null);assert.equal(changed.max,null);assert.equal(changed.period,'monthly');assert.equal(changed.raw,previous.raw);
 assert.deepEqual(changeMoneyPeriod(previous,'annual'),previous);
});

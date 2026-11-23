import test from 'node:test';
import assert from 'node:assert/strict';
import {csvDocument} from '../src/lib/api.ts';
test('CSV exports neutralize spreadsheet formulas and preserve quotes, commas and multiline facts',()=>{
  const csv=csvDocument([['姓名','备注','分数'],['=HYPERLINK("https://invalid")','  @SUM(1,2)',75],['普通人员','含,逗号与"引号"\n第二行',null]]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes(`"'=HYPERLINK(""https://invalid"")"`));
  assert.ok(csv.includes(`"'  @SUM(1,2)"`));
  assert.ok(csv.includes('"含,逗号与""引号""\n第二行"'));
  assert.ok(csv.includes('"75"'));
});

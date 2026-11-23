import test from 'node:test';
import assert from 'node:assert/strict';
import {departmentLabel,memberLabel} from '../src/lib/member-label';
test('same-name employees are distinguished by departments and missing metadata has a readable fallback',()=>{
 assert.equal(memberLabel({name:'张三',departments:['技术中心 / 研发部']}),'张三 · 技术中心 / 研发部');
 assert.notEqual(memberLabel({name:'张三',departments:['研发部']}),memberLabel({name:'张三',departments:['人力资源部']}));
 assert.equal(memberLabel({name:'张三'}),'张三 · 部门未同步');
 assert.equal(departmentLabel({departments:['研发部','项目部']}),'研发部、项目部');
});

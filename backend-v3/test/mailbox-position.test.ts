import test from 'node:test';
import assert from 'node:assert/strict';
import {mailPosition,bodyIsApplication} from '../src/mailbox/update.js';
test('only exact declared positions map to a job; senior and negated variants stay pending',()=>{
 const jobs=[{id:'product',name:'产品经理'}];
 assert.equal(mailPosition('应聘产品经理','',jobs).jobId,'product');
 assert.equal(mailPosition('应聘高级产品经理','',jobs).jobId,undefined);
 assert.equal(mailPosition('不应聘产品经理，求职运营','',jobs).jobId,undefined);
 assert.equal(mailPosition('个人简历','我以前做过产品经理',jobs).jobId,undefined);
 assert.equal(mailPosition('个人简历','应聘岗位：产品经理',jobs).jobId,'product');
});
test('an inline signature does not suppress a body-only application',()=>{
 assert.equal(bodyIsApplication({body:'姓名：合成人员\n电话：13800138000\n我希望应聘研发岗位',attachments:[{inline:true,importable:false} as any]}),true);
 assert.equal(bodyIsApplication({body:'系统通知，无应聘内容',attachments:[]}),false);
});

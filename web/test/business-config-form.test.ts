import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeFormAfterDefinitionChange,coreToValues,valuesToCore} from '../src/lib/business-config.ts';
test('form_survives_configuration_changed: renamed values stay keyed by identity and removed dirty values remain in page memory for review',()=>{
 const old:any={ref:{version:1},fields:[{fieldId:'core.job.name',coreKey:'name',active:true},{fieldId:'custom.note',active:true}]},next:any={ref:{version:2},fields:[{fieldId:'core.job.name',coreKey:'name',label:'职位名',active:true}]};
 const result=mergeFormAfterDefinitionChange(old,next,{'core.job.name':'编辑中的岗位','custom.note':'未提交内容'});
 assert.deepEqual(result.values,{'core.job.name':'编辑中的岗位','custom.note':'未提交内容'});assert.deepEqual(result.removedFields,['custom.note']);assert.equal(result.requiresReview,true);
 assert.deepEqual(coreToValues(old,{name:'岗位'}),{'core.job.name':'岗位'});assert.deepEqual(valuesToCore(old,{'core.job.name':'新岗位','custom.note':'自定义'}),{name:'新岗位'});
});

import test from 'node:test';import assert from 'node:assert/strict';
import {fieldActions,configurationDiff,editorChanged,editorRejected,editorPreviewed,moveEntry,appendOrder,editorDraftError} from '../src/lib/config-editor.ts';
test('editor_marks_system_fields_and_deactivation: published identities/types stay fixed while unused draft fields can be removed',()=>{
 assert.deepEqual(fieldActions({system:true},true),{canRemove:false,canChangeType:false,removeLabel:'系统字段'});
 assert.deepEqual(fieldActions({system:false},true),{canRemove:true,canChangeType:false,removeLabel:'停用字段'});
 assert.deepEqual(fieldActions({system:false},false),{canRemove:true,canChangeType:true,removeLabel:'删除草稿字段'});
 const old:any={kind:'fields',fields:[{fieldId:'same',label:'期望薪资',active:true,order:0}]},next:any={kind:'fields',fields:[{fieldId:'same',label:'原始薪资表述',active:true,order:0},{fieldId:'annual',label:'期望年包',active:true,order:1}]};
 const diff=configurationDiff(old,next);assert.equal(diff.renamed.length,1);assert.equal(diff.added.length,1);assert.deepEqual(moveEntry(next.fields,1,-1).map((x:any)=>x.fieldId),['annual','same']);assert.equal(next.fields[0].fieldId,'same');
});
test('preview_rejects_stale_draft: errors retain local input and never invent a successful publication',()=>{
 const initial:any={document:{kind:'fields',fields:[]},draft:{id:'d',version:1},receipt:{draftVersion:1},publishedVersion:2,error:''};
 const changed=editorChanged(initial,{kind:'fields',fields:[{fieldId:'new'}]});assert.equal(changed.receipt,null);assert.equal(changed.dirty,true);
 const stale=editorRejected(changed,{status:409,code:'version_conflict'});assert.deepEqual(stale.document,changed.document);assert.equal(stale.publishedVersion,2);assert.equal(stale.receipt,null);assert.equal(stale.dirty,true);
 assert.throws(()=>editorPreviewed({...changed,draft:{id:'d',version:2}},{draftId:'d',draftVersion:1}),/预览版本/);
 const invalid=editorRejected(changed,{status:422,code:'field_required:custom.note'});assert.equal(invalid.fieldId,'custom.note');
});

test('new entries append after sparse published order values',()=>{assert.equal(appendOrder([{order:0},{order:80},{order:81}]),82);assert.equal(appendOrder([]),0);});

test('draft validation locates the field instead of discarding input on a generic 422',()=>{assert.deepEqual(editorDraftError({kind:'fields',fields:[{fieldId:'a',label:'',constraints:{}}]}),{fieldId:'a',message:'请填写字段名称'});assert.equal(editorDraftError({kind:'fields',fields:[{fieldId:'b',label:'金额',constraints:{min:20,max:10}}]}).fieldId,'b');});

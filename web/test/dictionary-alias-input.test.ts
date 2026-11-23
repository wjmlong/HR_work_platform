import test from 'node:test';
import assert from 'node:assert/strict';
import DictionaryEditor from '../src/features/business-config/DictionaryEditor.tsx';
function textarea(node:any):any {if(!node||typeof node!=='object')return; if(node.type==='textarea')return node;const children=[node.props?.children].flat(Infinity);for(const child of children){const found=textarea(child);if(found)return found;}}
test('dictionary editor separates Chinese enumeration commas and preserves technical tokens',()=>{
 let changed:any;const tree=DictionaryEditor({options:[{id:'salary',label:'薪酬',aliases:[],active:true,order:0}],onChange:value=>changed=value});
 textarea(tree).props.onChange({target:{value:'宽带薪酬、薪酬带宽，range; C/C++；Node.js\nR&D'}});
 assert.deepEqual(changed[0].aliases,['宽带薪酬','薪酬带宽','range','C/C++','Node.js','R&D']);
});

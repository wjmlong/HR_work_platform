import test from 'node:test';
import assert from 'node:assert/strict';
import {Directory} from '../src/identity/directory.js';
import type {Identity} from '../src/identity/service.js';

test('service timer refreshes without login or page requests and stops at shutdown',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const directory=new Directory({config:{schema:'recruit_test_timer',storageRoot:'/unused',feishu:{tenant:'test',appId:'app'}}} as Identity);
 let calls=0;directory.refresh=async()=>{calls++;};
 const timer=directory.start();assert.equal(calls,1);
 t.mock.timers.tick(599999);assert.equal(calls,1);
 t.mock.timers.tick(1);assert.equal(calls,2);
 t.mock.timers.tick(600000);assert.equal(calls,3);
 await timer.close();t.mock.timers.tick(600000);assert.equal(calls,3);
});

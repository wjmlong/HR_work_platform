import test from 'node:test';import assert from 'node:assert/strict';
import {speakerBubbles} from '../src/lib/interview-speakers.ts';
const segment={id:'s',speaker:'unknown',text:'请介绍。负责接口。'};
const turns=[{segmentId:'s',parts:[{speaker:'interviewer',text:'请介绍。'},{speaker:'candidate',text:'负责接口。'}]}];
test('display separates guessed roles and preserves every character',()=>{const parts=speakerBubbles(segment,turns);assert.deepEqual(parts.map(p=>p.side),['right','left']);assert.equal(parts.map(p=>p.text).join(''),segment.text);assert.ok(parts.every(p=>p.inferred));});
test('human corrections override all AI guesses',()=>{const parts=speakerBubbles({...segment,speaker:'interviewer'},turns);assert.equal(parts.length,1);assert.equal(parts[0].side,'right');assert.equal(parts[0].inferred,false);});
test('malformed or absent guesses stay centered without fabricating alternation',()=>{assert.equal(speakerBubbles(segment,[])[0].side,'center');assert.equal(speakerBubbles(segment,[{...turns[0],parts:turns[0].parts.slice(1)}])[0].text,segment.text);});

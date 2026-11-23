import test from 'node:test';
import assert from 'node:assert/strict';
import {attachmentPreviewType} from '../src/mailbox/archive.js';

const pdf=Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082','hex');
const jpeg=Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9','hex');
const gif=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
const webp=Buffer.from('5249464614000000574542505650384c070000002f00000000071000','hex');
test('attachment preview only returns an allowlisted MIME when the extension, declared type and bytes agree',()=>{
 for(const [name,mime,data,want] of [
  ['简历.PDF','application/octet-stream',pdf,'application/pdf'],
  ['简历.pdf','application/pdf',pdf,'application/pdf'],
  ['作品.png','image/png',png,'image/png'],
  ['作品.jpeg','image/jpeg',jpeg,'image/jpeg'],
  ['作品.jpg','application/octet-stream',jpeg,'image/jpeg'],
  ['作品.gif','image/gif',gif,'image/gif'],
  ['作品.webp','image/webp',webp,'image/webp'],
  ['伪装.pdf','application/pdf',Buffer.from('<html><script>alert(1)</script></html>'),null],
  ['伪装.png','image/png',Buffer.from('<svg onload="alert(1)"/>'),null],
  ['矢量.svg','image/svg+xml',Buffer.from('<svg/>'),null],
  ['网页.html','text/html',pdf,null],
  ['错类型.pdf','text/html',pdf,null],
  ['错扩展.png','image/png',pdf,null],
  ['截断.pdf','application/pdf',Buffer.from('%PDF-1.7\n'),null],
  ['截断.png','image/png',png.subarray(0,20),null],
  ['损坏.webp','image/webp',webp.subarray(0,20),null],
  ['文件.docx','application/octet-stream',Buffer.from('PK'),null],
  ['空.pdf','application/pdf',Buffer.alloc(0),null],
 ] as const)assert.equal(attachmentPreviewType({name,contentType:mime},data),want,name);
});

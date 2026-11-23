# -*- coding: utf-8 -*-
import json,pathlib,sys,statistics,collections,re,unicodedata
p=pathlib.Path(sys.argv[1]);b=pathlib.Path(sys.argv[2]);manifest=json.loads((p/'manifest.json').read_text());summary=json.loads((p/'summary.json').read_text());baseline=json.loads((b/'baseline-summary.json').read_text());bybase={r['id']:r for r in baseline['rows']};names={x['id']:x['name'] for x in manifest['files']};labels={'education':'学历','experience':'相关年限','workflow':'自动化必备项','backend':'后端','frontend':'前端','integration':'API集成','delivery':'端到端交付','business':'业务系统','bonus':'加分项'};states={'demonstrated':'有具体证据','mentioned':'仅提及','not_found':'未找到','uncertain':'待核实'}
ok=[r for r in summary['rows'] if r['ok']];failed=[r for r in summary['rows'] if not r['ok']]
norm=lambda s:re.sub(r'\s+','',unicodedata.normalize('NFKC',s))
workflow=collections.Counter();quotes=matched=0;unmatched=[];name_checks=[]
lines=['# 真实简历 × 自动化全栈 JD：本地测试报告','', '本报告用于验证抽取与岗位条件对照，不是候选人排名或录用建议。仅本地运行并调用公司 DeepSeek Flash；不导入、不修改线上数据。','',f"文件数：{summary['total']}；完成：{summary['completed']}；严格校验通过：{len(ok)}；拦截：{len(failed)}。",'','“通过”仅表示返回完整、结构符合约定、引用能逐字对应模型转写；不代表所有事实已经人工证实。','']
if ok:lines += [f"成功样本模型耗时：中位 {statistics.median(r['modelMs'] for r in ok)/1000:.1f}s，最大 {max(r['modelMs'] for r in ok)/1000:.1f}s；本地预处理峰值 RSS 最大 {max(r['preparationMaxRssMiB'] for r in ok):.1f}MiB。",'']
lines+=['## 每份文件处理情况','','文件名仅保存在本地报告，未同步 GitHub。','', '|编号|文件|处理|自动化必备项|前端|后端|API集成|','|---|---|---|---|---|---|---|']
for row in summary['rows']:
 id=row['id'];a={}
 if row['ok']:
  r=json.loads((p/(id+'.result.json')).read_text())['result'];a={x['id']:x for x in r.get('assessment',[])};workflow[a.get('workflow',{}).get('status','missing')]+=1
  native_file=b/(id+'.baseline.json');native=norm(json.loads(native_file.read_text())['raw']) if native_file.exists() else ''
  identified=[f['value'] for f in r['facts'] if f['field']=='name'];name_checks.append({'id':id,'namePresent':bool(identified),'nameInFilename':any(n in names[id] for n in identified)})
  if native:
   for f in r['facts']+r.get('assessment',[]):
    for e in f['evidence']:
     quotes+=1
     if norm(e['quote']) in native:matched+=1
     else:unmatched.append({'id':id,'field':f.get('field',f.get('id')),'page':e['page'],'quote':e['quote']})
 text='通过' if row['ok'] else '拦截：'+row['error'].split('\n')[0]
 lines.append('|'+ '|'.join([id,names[id].replace('|',' '),text]+[states.get(a.get(k,{}).get('status'),'-') for k in ['workflow','frontend','backend','integration']])+'|')
lines+=['','## 证据复核','','自动检查另将模型引用与独立 PDF/DOCX 文本抽取结果比较（仅忽略空白和Unicode兼容形式）。这是辅助检查，非OCR准确率：',f'- 独立文本中可定位引用：{matched}/{quotes}。',f'- 不能自动定位的引用：{len(unmatched)} 条，见 evidence-review.json，需看原页核实。',f'- 姓名输出存在：{sum(x["namePresent"] for x in name_checks)}/{len(name_checks)}；姓名与文件名相符：{sum(x["nameInFilename"] for x in name_checks)}/{len(name_checks)}（文件名不是身份真实性证明）。','','## 旧规则对照','','本地用当前代码、六个自动化工具平铺列表、本科、1–3年模拟该JD；并未修改线上岗位配置。',f'- 原文解析失败：{sum("error" in x for x in baseline["rows"])} 份。',f'- 使用“未识别年限给13分”基线：{sum(x.get("baseline",{}).get("experience") is not None for x in baseline["rows"])} 份。','- 六个工具平铺计分意味着命中任意一项仅得10/60技能分，与JD“工具或自建Workflow任一实战即可”的业务含义不同。','- 旧分数不应与模型的“有具体证据”直接互换；关键词出现也不能证明实战。','','## 逐份岗位证据（仅校验通过的结果）','']
for row in ok:
 id=row['id'];r=json.loads((p/(id+'.result.json')).read_text())['result'];lines += ['### '+id+' '+names[id],'']
 for a in r.get('assessment',[]):
  lines.append('**'+labels[a['id']]+' · '+states[a['status']]+'**：'+a['summary'])
  for e in a['evidence']:lines.append('- 第 '+str(e['page'])+' 页：'+e['quote'].replace('\n',' / '))
  lines.append('')
 if r['reviewNotes']:lines+=['需核对：'+'；'.join(r['reviewNotes']),'']
lines+=['## 发布判断','','本地试验结果不足以作为上线批准。所有被拦截的样本必须有明确重试/人工处理路径，自动评分前还需完成人工事实确认及否定/不确定技能的规则衔接。尚未部署190。']
(p/'真实简历-JD测试报告.md').write_text('\n'.join(lines));(p/'evidence-review.json').write_text(json.dumps({'matched':matched,'total':quotes,'unmatched':unmatched,'names':name_checks,'workflow':dict(workflow)},ensure_ascii=False,indent=2));print(json.dumps({'passed':len(ok),'blocked':len(failed),'evidenceMatched':matched,'evidenceTotal':quotes,'workflow':dict(workflow)},ensure_ascii=False))

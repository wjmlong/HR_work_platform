# -*- coding: utf-8 -*-
import json,pathlib,statistics,csv,sys,os,collections
p=pathlib.Path(sys.argv[1]);s=json.loads((p/'summary.json').read_text());manifest=json.loads((p/'manifest.json').read_text());names={x['id']:x['name'] for x in manifest['files']}
labels={'education':'学历','experience':'经验','workflow':'自动化工作流','backend':'后端','frontend':'前端','integration':'API集成','delivery':'交付/需求澄清','business':'业务系统','bonus':'加分项'}
status={'demonstrated':'有项目证据','mentioned':'仅声明','not_found':'未发现证据','uncertain':'待核实'}
rows=s['rows'];ok=[r for r in rows if r['ok']];checks=0;broken=[];coverage=collections.Counter();details=[];flat=[]
for row in ok:
 r=json.loads((p/(row['id']+'.result.json')).read_text())['result'];pages={x['page']:x['text'] for x in r['pages']}
 for obj in r['facts']+r['assessment']:
  for e in obj['evidence']:
   checks+=1
   if e['quote'] not in pages[e['page']]:broken.append(row['id'])
 a={x['id']:x for x in r['assessment']};coverage[a['workflow']['status']]+=1
 flat.append([row['id'],names[row['id']]]+[status[a[k]['status']] for k in labels])
 details += ['\n## '+row['id']+' · '+names[row['id']], '\n| JD维度 | 证据状态 | 分析 |','|---|---|---|']
 for k in labels:details.append('|'+labels[k]+'|'+status[a[k]['status']]+'|'+a[k]['summary'].replace('|','/').replace('\n',' ')+'|')
 details+=['\n待核实事项：']+['- '+n for n in r['reviewNotes']]
 details+=['\n原文引用和抽取事实：[逐项原始结果]('+row['id']+'.result.json)。']
metrics={'files':s['total'],'completed':s['completed'],'passed':len(ok),'failed':len(rows)-len(ok),'citationChecks':checks,'invalidCitations':len(broken),'medianModelSeconds':round(statistics.median(x['modelMs'] for x in ok)/1000,2),'maxModelSeconds':round(max(x['modelMs'] for x in ok)/1000,2),'maxPreparationMiB':max(x['preparationMaxRssMiB'] for x in ok),'ocrPages':sum(x['imagePages'] for x in ok),'tokens':sum(x['usage']['total_tokens'] for x in ok),'workflowEvidenceDistribution':dict(coverage)}
(p/'audit.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2));os.chmod(p/'audit.json',0o600)
with (p/'逐份JD证据对照.csv').open('w',encoding='utf-8-sig',newline='') as f:csv.writer(f).writerows([['编号','文件']+list(labels.values())]+flat)
text=['# 真实简历 × 全栈自动化岗位：本地测试报告','\n日期：2026-10-27。保密：包含招聘资料，仅本地保存。','\n## 验收范围','\n34份用户提供的简历，使用指定JD，通过公司NewAPI的deepseek-flash进行事实抽取及九项岗位证据对照。未写入线上数据库，未变更190服务，未生成录用决定或候选人排名。','\n## 实测结果','\n```json',json.dumps(metrics,ensure_ascii=False,indent=2),'```','\n34份全部完成只代表链路、结构和引用校验通过，不代表每一个模型结论均已人工确认。引用校验检查文字来自实际解析/OCR文本，不能证明模型对这段文字的解释一定正确。','\n## 修复与复核','\n- PDF中文字体映射：编号16旧读取器丢失中文；PDFium恢复姓名、学历及正文，已对照页面。','- DOCX：编号34包含外部模板关系，改为只读取包内正文，不访问外部模板；解析成功。','- 引用：模型只返回片段编号，由本地程序回填原文，避免模型改写引文。','- 经验：日期区间不能作为工作年数；缺失时待核实，不发放默认经验分。','- 日期：明确提供2026-10-27上下文，修复模型将已有经历称为未来日期的问题。','- Workflow：按工具任选一项或自建引擎的业务含义对照；仅有Agent/LangGraph编排且引擎能力不明确时，待人工核实。','- 扫描件编号26三页已逐页看图复核姓名、教育、项目和证书；未做全文逐字准确率标注。','- 编号08文件名与正文姓名不同，正文优先，避免把文件名当姓名。','\n## 旧评分的局限','\n对照运行的是本地按JD构造的六工具默认规则，并非线上实际岗位配置。旧规则将六工具分开计分，不能完整表达“任选其一/自建引擎”；未识别经验时还会给默认分。本次语义测试输出证据与待核实事项，未把模型判断直接接入旧分数。','\n## 190资源与上线边界','\n本地最多2个文件并发。云端模型承担OCR/语义，本地执行有界文档读取与逐页渲染；上述内存为单文件预处理进程测量（含Python峰值的保守相加），不是服务总内存。16核32GB具备进行低并发试运行的条件，但本次没有在Linux上压测，不能据此承诺吞吐。上线前仍需接上传任务、版本与审核界面、数据库协调的全局并发限制、系统级CPU/内存限制和Linux复测。','\n## 每份简历的JD对照（供人工复核）']+details
(p/'真实简历-JD测试报告.md').write_text('\n'.join(text));os.chmod(p/'真实简历-JD测试报告.md',0o600);os.chmod(p/'逐份JD证据对照.csv',0o600)
print(json.dumps(metrics,ensure_ascii=False))

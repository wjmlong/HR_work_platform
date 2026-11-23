// 岗位技能组「自进化」旁路服务。
// 设计原则：只读分析 + 产出建议草稿；不改评分函数、不自动发布、不写业务数据。
// 三项能力：①动态判定项 ②结果回流校准 ③技能词典自扩充。
import {z,uuid} from '../http/validation.js';
import {fail,found} from '../http/errors.js';
import {requireRole,type Actor,type Identity} from '../identity/service.js';
import type {Sql} from '../db.js';
import {BusinessConfigService} from './service.js';
import {validateDocument} from './schema.js';
import {validateMatchTemplate} from './match-template.js';
import {resolveJobMatching,loadDictionarySnapshot,queueMatches} from './bindings.js';
import type {DefinitionRef} from './types.js';

const read=(a:Actor)=>requireRole(a,'admin','manager','recruiter','interviewer','viewer');
const write=(a:Actor)=>requireRole(a,'admin');

// 固化泛词表：这些词在各岗位 JD 中均为通用模块/职能词，出现频率高但区分度低，
// 不作为任何岗位的「新判定项」推出。依据公开招聘 JD 与系统内跨岗位分布梳理（2026-11-20）。
const GENERIC_SKILLS=new Set([
  // HR 通用模块与角色词（协同模块，非岗位专属能力）
  '招聘','招聘管理','社会招聘','校园招聘','绩效','绩效管理','绩效管理等','培训','培训管理','员工培训','HRBP','BP','人力资源','人事','HR','员工关系','薪酬','薪酬管理','五险一金','劳动关系','组织发展','人力资源规划','人力资源战略','企业文化','文化建设',
  // 泛职能/通用能力词（任何岗位都可能出现，无区分度）
  '沟通','沟通协调','团队协作','团队管理','管理能力','项目管理','数据分析','分析能力','学习能力','抗压能力','责任心','执行力','领导力','解决能力','问题解决','办公软件','Office','Excel','PPT','Word','英语','日语','计算机','互联网','AI','人工智能','机器学习','深度学习',
  // 泛行业/动词词
  '管理','运营','销售','市场','研发','生产','质量','质量管理','服务','客户','业务','战略','流程','制度','咨询','供应商','成本','效率','优化','改进','设计','开发','维护','支持'
]);
// 统一小写口径，确保与 toLocaleLowerCase() 过滤一致。
for(const k of [...GENERIC_SKILLS])GENERIC_SKILLS.delete(k),GENERIC_SKILLS.add(k.toLocaleLowerCase());

type Suggestion={
  kind:'dynamic_criteria'|'calibration'|'dictionary_expansion';
  jobId:string|null;
  jobName:string;
  summary:string;
  items:{action:string;target:string;reason:string;evidence:string;confidence:'high'|'medium'|'low'}[];
  generatedAt:string;
  basis:{snapshots:number;applications:number;skills:number};
};

export class EvolutionService {
  constructor(readonly identity:Identity){}
  get db(){return this.identity.db;}
  private async jobName(c:Sql,jobId:string){return (await c.query('SELECT name FROM jobs WHERE id=$1',[jobId])).rows[0]?.name||jobId;}

  // 汇总所有快照的技能命中明细（只读）。
  private async snapshotSkills(c:Sql,jobId?:string){
    // 直接按 application 关联 job，读评分快照明细。
    const simple=`SELECT s.application_id,s.data,a.status,a.job_id
      FROM match_snapshots s
      LEFT JOIN applications a ON a.id=s.application_id
      WHERE ($1::uuid IS NULL OR a.job_id=$1)
      ORDER BY s.created_at DESC`;
    const rows=(await c.query(simple,[jobId||null])).rows as any[];
    const out:{jobId:string;status:string;skills:{label:string;skill:string;status:string;value:number}[];score:number|null}[]=[];
    for(const r of rows){
      const d=r.data||{},groups=Array.isArray(d.groups)?d.groups:[];
      const skills:any[]=[];
      for(const g of groups)for(const it of (Array.isArray(g.items)?g.items:[]))
        if(it&&it.skill)skills.push({label:it.label||it.skill,skill:it.skill,status:it.status||'unknown',value:Number(it.value)||0});
      out.push({jobId:r.job_id,status:r.status||'unknown',skills,score:d.score&&Number.isFinite(d.score.value)?d.score.value:null});
    }
    return out;
  }

  // ①动态判定项：按真实证据统计每个判定项的可判/待核比例，产出调整建议。
  async suggestDynamicCriteria(a:Actor,jobId:string):Promise<Suggestion>{
    read(a);
    return this.db.tx(async c=>{
      const snaps=(await this.snapshotSkills(c,jobId)).filter(s=>s.jobId===jobId);
      const stat=new Map<string,{label:string;matched:number;unmatched:number;unknown:number}>();
      for(const s of snaps)for(const k of s.skills){
        const row=stat.get(k.skill)||{label:k.label,matched:0,unmatched:0,unknown:0};
        if(k.status==='matched')row.matched++;else if(k.status==='unknown')row.unknown++;else row.unmatched++;
        stat.set(k.skill,row);
      }
      const items:Suggestion['items']=[];
      for(const [skill,v] of stat){
        const total=v.matched+v.unmatched+v.unknown;
        const unknownRate=total?v.unknown/total:0;
        if(total>=2&&unknownRate>=0.5)items.push({action:'标记待核',target:v.label,reason:`${total} 份样本中 ${v.unknown} 份无法判定（待核率 ${Math.round(unknownRate*100)}%）`,evidence:'match_snapshots.groups[].items[].status=unknown',confidence:total>=5?'high':'medium'});
        else if(v.matched>=2)items.push({action:'保留判定项',target:v.label,reason:`命中 ${v.matched}/${total}，证据稳定`,evidence:'match_snapshots 原文命中',confidence:'high'});
      }
      // 推出新判定项：该岗位候选人简历里高频出现、但当前模板尚未覆盖的技能。
      // 依据为「真实解析技能 + 流转结果」，不是两个词同时出现的共现统计。
      const binding=await resolveJobMatching(this.identity,c,jobId);
      const dict=await loadDictionarySnapshot(this.identity,binding.dictionaryRef,c);
      const labelOf=(id:string)=>String(dict.labels?.[id]||id);
      const covered=new Set<string>();
      for(const s of snaps)for(const k of s.skills)covered.add(labelOf(k.skill).toLocaleLowerCase());
      // 只从「进入后续环节」或「高匹配分」的候选人里推新项，避免淘汰样本的噪声技能污染建议。
      const src=(await c.query(`SELECT p.profile,a.status,
        (SELECT (m.data->'score'->>'value')::numeric FROM match_snapshots m WHERE m.application_id=a.id ORDER BY m.created_at DESC LIMIT 1) AS score
        FROM applications a JOIN resume_versions r ON r.candidate_id=a.candidate_id JOIN parse_results p ON p.id=r.parse_result_id
        WHERE a.job_id=$1 AND a.deleted_at IS NULL AND p.profile IS NOT NULL`,[jobId])).rows as any[];
      const good=new Set(['interviewing','collecting','background_check','offered','hired','资料收集中','背调中','已发 offer','已入职']);
      const strong=src.filter(r=>good.has(r.status)||(r.score!==null&&Number(r.score)>=75));
      const freq=new Map<string,number>();
      for(const r of strong){const skills=Array.isArray(r.profile?.skills)?r.profile.skills:[];const names=new Set<string>();
        for(const x of skills as any[]){const raw=String(x&&x.label?x.label:x||'').trim();if(!raw)continue;
          // 把词典 option id 归一化为可读 label，避免推出 option_xxx 这种内部标识。
          const name=raw.startsWith('option_')?String(dict.labels?.[raw]||raw):raw;
          names.add(name);
        }
        for(const raw of names){
          const key=raw.toLocaleLowerCase();
          if(covered.has(key)||GENERIC_SKILLS.has(key)||key.startsWith('option_'))continue;
          freq.set(raw,(freq.get(raw)||0)+1);
        }
      }
      const inferred=[...freq.entries()].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]).slice(0,5);
      for(const [name,n] of inferred)
        items.push({action:'推出新判定项',target:name,reason:`${n} 份进入后续环节或高匹配的简历中出现，当前模板未覆盖`,evidence:'parse_results.profile.skills × applications.status/score',confidence:n>=5?'high':n>=3?'medium':'low'});
      if(!inferred.length)
        items.push({action:strong.length<2?'样本不足，暂不推出':'暂无新判定项',target:'新判定项',reason:strong.length<2?`该岗位仅 ${strong.length} 份进入后续环节或高匹配的简历解析，未达 2 份的推出门槛`:`${strong.length} 份强样本中未发现出现 2 次以上、且模板未覆盖的技能`,evidence:'统计门槛保护',confidence:'low'});
      return {kind:'dynamic_criteria',jobId,jobName:await this.jobName(c,jobId),summary:`基于 ${snaps.length} 份评分快照、${stat.size} 个已覆盖判定项、${src.length} 份简历解析生成建议（含 ${items.filter(x=>x.action==='推出新判定项').length} 项新判定项；已过滤通用词表 ${GENERIC_SKILLS.size} 项）`,items,generatedAt:new Date().toISOString(),basis:{snapshots:snaps.length,applications:src.length,skills:stat.size}};
    });
  }

  // ②结果回流校准：命中某判定项与申请推进的相关性 → 权重调整建议。
  async suggestCalibration(a:Actor,jobId:string):Promise<Suggestion>{
    read(a);
    return this.db.tx(async c=>{
      const snaps=(await this.snapshotSkills(c,jobId)).filter(s=>s.jobId===jobId);
      const good=new Set(['interviewing','collecting','background_check','offered','hired','资料收集中','背调中','已发 offer','已入职']);
      const stat=new Map<string,{label:string;hitAdvance:number;hitTotal:number}>();
      for(const s of snaps)for(const k of s.skills){
        if(k.status!=='matched')continue;
        const v=stat.get(k.skill)||{label:k.label,hitAdvance:0,hitTotal:0};
        v.hitTotal++;if(good.has(s.status))v.hitAdvance++;stat.set(k.skill,v);
      }
      const items:Suggestion['items']=[];
      for(const [skill,v] of stat){
        const rate=v.hitTotal?v.hitAdvance/v.hitTotal:0;
        if(v.hitTotal>=3&&rate<=0.2)items.push({action:'建议降权',target:v.label,reason:`命中 ${v.hitTotal} 次但仅 ${v.hitAdvance} 次进入后续环节（推进率 ${Math.round(rate*100)}%）`,evidence:'match_snapshots × applications.status',confidence:v.hitTotal>=5?'high':'medium'});
        else if(v.hitTotal>=3&&rate>=0.6)items.push({action:'建议加权',target:v.label,reason:`命中 ${v.hitTotal} 次，${v.hitAdvance} 次进入后续环节（推进率 ${Math.round(rate*100)}%）`,evidence:'match_snapshots × applications.status',confidence:v.hitTotal>=5?'high':'medium'});
      }
      if(!items.length)items.push({action:'样本不足，暂不校准',target:'全部判定项',reason:`仅 ${snaps.length} 份快照，未达每项 3 份的统计门槛`,evidence:'统计门槛保护',confidence:'low'});
      return {kind:'calibration',jobId,jobName:await this.jobName(c,jobId),summary:`基于 ${snaps.length} 份快照与申请流转结果生成权重校准建议（需人工确认后采纳）`,items,generatedAt:new Date().toISOString(),basis:{snapshots:snaps.length,applications:snaps.length,skills:stat.size}};
    });
  }

  // ③技能词典自扩充：统计简历解析技能中未登记到词典的词。
  async suggestDictionaryExpansion(a:Actor):Promise<Suggestion>{
    read(a);
    return this.db.tx(async c=>{
      const dict=(await c.query("SELECT v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.skills'")).rows[0]?.document;
      const known=new Set<string>((dict?.options||[]).map((o:any)=>String(o.label||o.id).toLocaleLowerCase()));
      const rows=(await c.query("SELECT p.profile FROM resume_versions r JOIN parse_results p ON p.id=r.parse_result_id WHERE p.profile IS NOT NULL ORDER BY r.created_at DESC LIMIT 500")).rows as any[];
      const freq=new Map<string,number>();
      for(const r of rows){
        const d=r.data||{},profile=d.profile||{},skills=Array.isArray(profile.skills)?profile.skills:[];
        for(const s of skills){const name=String(s&&s.label?s.label:s||'').trim();if(name&&!known.has(name.toLocaleLowerCase()))freq.set(name,(freq.get(name)||0)+1);}
      }
      const items:Suggestion['items']=[...freq.entries()].filter(([,n])=>n>=2).sort((x,y)=>y[1]-x[1]).slice(0,20).map(([name,n])=>({action:'候选词条',target:name,reason:`${n} 份简历解析出现，尚未登记到技能词典`,evidence:'resume_versions.profile.skills',confidence:n>=5?'high':n>=3?'medium':'low'}));
      if(!items.length)items.push({action:'暂无候选词条',target:'技能词典',reason:'未发现出现 2 次以上的未登记技能',evidence:'resume_versions 扫描',confidence:'low'});
      return {kind:'dictionary_expansion',jobId:null,jobName:'全部岗位',summary:`扫描 ${rows.length} 份简历，发现 ${items.length} 个候选词条（需人工确认后采纳）`,items,generatedAt:new Date().toISOString(),basis:{snapshots:0,applications:rows.length,skills:known.size}};
    });
  }

  // 把「词典扩充建议」转成标准 dictionary 草稿（不发布）。
  async adoptDictionary(a:Actor,names:string[]):Promise<{draftId:string;configId:string;baseVersion:number}>{
    write(a);
    const clean=[...new Set(names.map(n=>String(n).trim()).filter(Boolean))];
    if(!clean.length)fail(422,'evolution_empty_selection');
    return this.db.tx(async c=>{
      const cfg=found((await c.query("SELECT * FROM business_configs WHERE key='dictionary.skills' FOR UPDATE")).rows[0]);
      const cur=found((await c.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2',[cfg.id,cfg.published_version])).rows[0]).document;
      const opts=[...(cur.options||[])];
      for(const name of clean){
        const id='option_'+this.identity.hash(name).slice(0,12);
        if(opts.some((o:any)=>o.id===id||String(o.label).toLocaleLowerCase()===name.toLocaleLowerCase()))continue;
        opts.push({id,label:name,aliases:[name],active:false,order:opts.length,category:'自进化候选'});
      }
      const document={...cur,options:opts};
      validateDocument(document);
      const draft=await new BusinessConfigService(this.identity).saveDraft(a,{key:'dictionary.skills',baseVersion:cfg.published_version,document});
      await this.identity.audit(c,a.id,'evolution.adopt_dictionary',cfg.id,{count:clean.length,draftId:draft.id});
      return {draftId:draft.id,configId:cfg.id,baseVersion:cfg.published_version};
    });
  }

  // 直接添加技能组：即时发布到岗位当前绑定模板的新版本（不可变旧版本可回退）。
  // 单项或批量由 groups 数组长度决定；每项 {label,mode,skills[],weight,required,note}。
  async addGroups(a:Actor,input:{jobId:string;groups:{label:string;mode:'all'|'any';skills:string[];weight:number;required?:boolean;note?:string}[]}):Promise<{version:number;groups:number;requeued:number;previousVersion:number;createdSkills:string[];dictionaryVersion:number|null}>{
    write(a);
    const jobId=input.jobId, groups=input.groups||[];
    if(!jobId)fail(422,'evolution_job_required');
    if(!groups.length||groups.length>20)fail(422,'evolution_groups_range');
    return this.db.tx(async c=>{
      await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[jobId]);
      const binding=await resolveJobMatching(this.identity,c,jobId);
      const cfg=found((await c.query('SELECT * FROM business_configs WHERE id=$1 FOR UPDATE',[binding.templateRef.configId])).rows[0]);
      if(cfg.published_version!==binding.templateRef.version)fail(409,'version_conflict');
      const cur=found((await c.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2',[cfg.id,cfg.published_version])).rows[0]).document;
      if(cur.kind!=='match'||cur.mode!=='prd_compat'&&cur.mode!=='custom')fail(422,'configuration_kind_immutable');
      if(cur.mode==='prd_compat')fail(422,'prd_default_immutable');
      let dict=await loadDictionarySnapshot(this.identity,binding.dictionaryRef,c);
      const byLabel=new Map<string,string>();
      const reindex=()=>{byLabel.clear();for(const [id,label] of Object.entries(dict.labels||{}))byLabel.set(String(label).toLocaleLowerCase(),id);for(const id of Object.keys(dict.aliases||{}))byLabel.set(id.toLocaleLowerCase(),dict.aliases![id]);};
      reindex();
      // 一步到位：词典未登记的技能先新建词条并发布（默认启用，便于命中），再建组。
      const allNames=[...new Set(groups.flatMap(g=>g.skills.map(x=>String(x).trim()).filter(Boolean)))];
      const missing=allNames.filter(n=>!byLabel.has(n.toLocaleLowerCase()));
      let dictionaryVersion:number|null=null;
      const created:string[]=[];
      if(missing.length){
        const dcfg=found((await c.query("SELECT * FROM business_configs WHERE id=$1 FOR UPDATE",[binding.dictionaryRef.configId])).rows[0]);
        if(dcfg.published_version!==binding.dictionaryRef.version)fail(409,'version_conflict');
        const dcur=found((await c.query('SELECT document FROM business_config_versions WHERE config_id=$1 AND version=$2',[dcfg.id,dcfg.published_version])).rows[0]).document;
        const opts=[...(dcur.options||[])],used=new Set(opts.map((o:any)=>o.id));
        for(const name of missing){
          let id='option_evo_'+this.identity.hash(name).slice(0,12);
          while(used.has(id))id+='x';
          opts.push({id,label:name,aliases:[name.toLocaleLowerCase()],active:true,order:opts.length,category:'自进化新增'});
          used.add(id); byLabel.set(name.toLocaleLowerCase(),id); created.push(name);
        }
        const ddoc=validateDocument({...dcur,options:opts});
        const maxD=(await c.query('SELECT coalesce(max(version),0)::int v FROM business_config_versions WHERE config_id=$1',[dcfg.id])).rows[0].v;
        const dv=Math.max(dcfg.published_version,maxD)+1;
        dictionaryVersion=dv;
        await c.query('INSERT INTO business_config_versions(config_id,version,document,actor_id) VALUES($1,$2,$3,$4)',[dcfg.id,dv,ddoc,a.id]);
        await c.query('UPDATE business_configs SET published_version=$2,version=version+1,updated_at=now() WHERE id=$1',[dcfg.id,dv]);
        await c.query("UPDATE business_template_bindings SET dictionary_ref=$2,version=version+1,actor_id=$3,updated_at=now() WHERE object_kind='job' AND object_id=$1 AND purpose='matching'",[jobId,{ref:{configId:dcfg.id,version:dv}},a.id]);
        dict=await loadDictionarySnapshot(this.identity,{configId:dcfg.id,version:dv},c);reindex();
      }
      const stamp=Date.now().toString(36);
      const added=groups.map((g,gi)=>{
        const skills=[...new Set(g.skills.map(x=>String(x).trim()).filter(Boolean))];
        if(!skills.length)fail(422,'evolution_group_empty');
        const items=skills.map((name,si)=>{
          const resolved=byLabel.get(name.toLocaleLowerCase());
          if(!resolved)fail(422,'match_skill_unregistered:'+name);
          return {id:'skill_evo_'+stamp+'_'+gi+'_'+si,type:'skill' as const,skill:resolved,required:false,note:''};
        });
        return {id:'group_evo_'+stamp+'_'+gi,label:g.label,mode:g.mode,required:!!g.required,note:g.note||'',weight:g.weight,items};
      });
      const document={...cur,groups:[...(cur.groups||[]),...added]};
      const valid=validateMatchTemplate(document);
      const maxT=(await c.query('SELECT coalesce(max(version),0)::int v FROM business_config_versions WHERE config_id=$1',[cfg.id])).rows[0].v;
      const version=Math.max(cfg.published_version,maxT)+1;
      await c.query('INSERT INTO business_config_versions(config_id,version,document,actor_id) VALUES($1,$2,$3,$4)',[cfg.id,version,valid,a.id]);
      await c.query('UPDATE business_configs SET published_version=$2,version=version+1,updated_at=now() WHERE id=$1',[cfg.id,version]);
      // 绑定指向新模板版本
      await c.query("UPDATE business_template_bindings SET config_id=$2,template_version=$3,version=version+1,actor_id=$4,updated_at=now() WHERE object_kind='job' AND object_id=$1 AND purpose='matching'",[jobId,cfg.id,version,a.id]);
      // 入队重算该岗位当前申请
      const apps=(await c.query('SELECT id FROM applications WHERE job_id=$1 AND is_current AND deleted_at IS NULL',[jobId])).rows.map((r:any)=>r.id);
      const tasks=apps.length?await queueMatches(this.identity,c,apps,a.id,{reason:'evolution_add_groups'}):[];
      await this.identity.audit(c,a.id,'evolution.add_groups',jobId,{previousVersion:cfg.published_version,version,groups:added.map(x=>({id:x.id,label:x.label,skills:x.items.length,mode:x.mode,weight:x.weight})),requeued:tasks.length,createdSkills:created,dictionaryVersion});
      return {version,groups:added.length,requeued:tasks.length,previousVersion:cfg.published_version,createdSkills:created,dictionaryVersion};
    });
  }
}

export const groupInput=z.object({label:z.string().trim().min(1).max(100),mode:z.enum(['all','any']),skills:z.array(z.string().trim().min(1).max(100)).min(1).max(50),weight:z.number().finite().min(0).max(100),required:z.boolean().optional(),note:z.string().max(500).optional()}).strict();
export const evolutionRequest=z.object({jobId:uuid.optional(),names:z.array(z.string().max(100)).max(50).optional(),groups:z.array(groupInput).max(20).optional()}).strict();

import {fieldHistory,exportFieldHistory} from './history.js';
import {TemplateSelections,selectionPurpose,selectionPreviewRequest} from './selections.js';
import {BindingService,bindingPreviewRequest} from './bindings.js';
import type {FastifyInstance} from 'fastify';
import {Identity} from '../identity/service.js';
import {parse,z,uuid} from '../http/validation.js';
import {fail} from '../http/errors.js';
import {BusinessConfigService} from './service.js';
import {readFieldValues} from './fields.js';
import {entityKind} from './schema.js';
import {SalaryMigrationService} from './salary-migration.js';
import {EvolutionService,evolutionRequest} from './evolution.js';
export function businessConfigRoutes(app:FastifyInstance,identity:Identity){
 const s=new BusinessConfigService(identity),bindings=new BindingService(identity);
 const object=(p:unknown)=>parse(z.object({kind:entityKind,id:uuid}).strict(),p);
 app.get('/api/v4/business-config/objects/:kind/:id/history',req=>fieldHistory(identity,req.actor,object(req.params)));
 app.post('/api/v4/business-config/objects/:kind/:id/history/export',async(req,reply)=>{parse(z.object({}).strict(),req.body);return reply.type('text/csv; charset=utf-8').send(await exportFieldHistory(identity,req.actor,object(req.params)));});
 app.get('/api/v4/business-config/bindings/job/:id',req=>bindings.resolveBinding(req.actor,{kind:'job',id:parse(z.object({id:uuid}),req.params).id},'matching'));
 app.post('/api/v4/business-config/bindings/preview',req=>{const b=parse(bindingPreviewRequest,req.body);return bindings.preview(req.actor,b.object,b.purpose,b.target,b.dictionaryRef);});
 app.post('/api/v4/business-config/bindings/adopt',req=>bindings.adopt(req.actor,req.body));
 app.get('/api/v4/business-config/objects/:kind/:id',req=>readFieldValues(identity,req.actor,parse(z.object({kind:entityKind,id:uuid}),req.params)));
 const selections=new TemplateSelections(identity);
 app.get('/api/v4/business-config/templates/job/:id/:purpose',req=>{const p=parse(z.object({id:uuid,purpose:selectionPurpose}),req.params);return selections.binding(req.actor,p.id,p.purpose);});
 app.post('/api/v4/business-config/templates/preview',req=>{const b=parse(selectionPreviewRequest,req.body);return selections.preview(req.actor,b.jobId,b.purpose,b.target);});
 app.post('/api/v4/business-config/templates/adopt',req=>selections.adopt(req.actor,req.body));
 const salary=new SalaryMigrationService(identity);
 app.post('/api/v4/business-config/salary/preview',req=>salary.previewSalaryMigration(req.actor,req.body));
 app.post('/api/v4/business-config/salary/apply',req=>salary.applySalaryMigration(req.actor,req.body));
 // 技能组自进化：只读分析产出建议；采纳仅生成草稿，走既有 preview/publish 人工确认。
 const evolution=new EvolutionService(identity);
 app.post('/api/v4/business-config/evolution/dynamic-criteria',req=>{const b=parse(evolutionRequest,req.body);if(!b.jobId)fail(422,'evolution_job_required');return evolution.suggestDynamicCriteria(req.actor,b.jobId);});
 app.post('/api/v4/business-config/evolution/calibration',req=>{const b=parse(evolutionRequest,req.body);if(!b.jobId)fail(422,'evolution_job_required');return evolution.suggestCalibration(req.actor,b.jobId);});
 app.post('/api/v4/business-config/evolution/dictionary-expansion',req=>{parse(evolutionRequest,req.body);return evolution.suggestDictionaryExpansion(req.actor);});
 app.post('/api/v4/business-config/evolution/adopt-dictionary',req=>{const b=parse(evolutionRequest,req.body);if(!b.names?.length)fail(422,'evolution_empty_selection');return evolution.adoptDictionary(req.actor,b.names);});
 // 直接添加技能组（单项或批量）：即时发布到岗位当前模板新版本并回写绑定、入队重算。
 app.post('/api/v4/business-config/evolution/add-groups',req=>{const b=parse(evolutionRequest,req.body);if(!b.jobId||!b.groups?.length)fail(422,'evolution_groups_required');return evolution.addGroups(req.actor,{jobId:b.jobId,groups:b.groups});});
 app.get('/api/v4/business-config/catalog',req=>s.catalog(req.actor));
 app.get('/api/v4/business-config/effective/:kind',req=>s.effective(req.actor,parse(z.object({kind:entityKind}),req.params).kind));
 app.get('/api/v4/business-config/:id/versions/:version',req=>{const p=parse(z.object({id:uuid,version:z.coerce.number().int().positive()}),req.params);return s.version(req.actor,{configId:p.id,version:p.version});});
 app.get('/api/v4/business-config/drafts',req=>s.drafts(req.actor));
 app.post('/api/v4/business-config/drafts',req=>s.saveDraft(req.actor,req.body));
 app.patch('/api/v4/business-config/drafts/:id',req=>s.saveDraft(req.actor,{...(req.body as object),draftId:parse(z.object({id:uuid}),req.params).id}));
 app.post('/api/v4/business-config/drafts/:id/preview',req=>s.preview(req.actor,parse(z.object({id:uuid}),req.params).id));
 app.post('/api/v4/business-config/drafts/:id/publish',req=>s.publish(req.actor,{...(req.body as object),draftId:parse(z.object({id:uuid}),req.params).id}));
}

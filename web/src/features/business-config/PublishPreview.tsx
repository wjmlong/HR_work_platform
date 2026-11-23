import {TemplateSummary} from './TemplateEditor';
import {configurationDiff} from '../../lib/config-editor';
export default function PublishPreview({before,document,receipt,busy,onPublish,onCancel}:{before:any;document:any;receipt:any;busy:boolean;onPublish:()=>void;onCancel:()=>void}){
 const diff=configurationDiff(before,document),analysis=receipt.analysis;
 return <section className="publish-preview" aria-label="配置发布预览"><h3>发布前核对</h3><p>将基于版本 {receipt.baseVersion} 发布新版本。{["fields","dictionary"].includes(document.kind)?"受影响记录":"核对范围内现有业务记录"}：{receipt.affected}。原文与历史版本保留，既有岗位模板不会自动升级。</p><div className="config-change-grid">{[['added','新增'],['stopped','停用'],['renamed','改名'],['changed','其他配置变化']].map(([key,name])=><div key={key}><strong>{name} · {(diff as any)[key].length}</strong><p>{(diff as any)[key].map((f:any)=>f.label).join('、')||'无'}</p></div>)}</div>
 {analysis&&<><p>将失效的保存视图：{analysis.invalidatedViews??'待核对'}；固定模板引用：{analysis.templateBindings??0}（不自动替换）。</p>{analysis.required?.map((f:any)=><p key={f.fieldId}>{f.label}：{f.missing===null?'当前权限下不展示缺失计数':f.missing+' 条待补充'}{f.samples?.length?'；抽样记录 '+f.samples.length+' 条':''}</p>)}</>}
 {!['fields','dictionary'].includes(document.kind)&&<TemplateSummary document={document}/>}<p className="notice warning">权限收紧立即影响新的读取和写入；新增必填项在下次编辑时核对。旧表单须核对新配置，发布不自动重算匹配或改写事实。</p><div className="toolbar"><button type="button" onClick={onCancel} disabled={busy}>返回修改</button><button type="button" className="primary" disabled={busy} onClick={onPublish}>{busy?'正在发布…':'确认发布配置'}</button></div></section>;
}

import {edu,type Row} from '../lib/state';
export function NameCell({profile}:{profile:Row}) {
 const contact=String(profile.phone||profile.email||'');
 const masked=contact.replace(/^(\d{3})\d{4}(\d{4})$/,'$1****$2');
 return <><span>{profile.name}</span>{contact?<small className="collection-ellipsis" title={masked}>{masked}</small>:<span title="无联系方式" aria-label="无联系方式"> ·</span>}</>;
}
export function MatchCell({person,inbox}:{person:Row;inbox:boolean}) {
 const match=person.inboxMatch, intent=String(match?.intent||''), quote=String(match?.evidence?.[0]?.quote||'');
 const basis=intent&&intent.trim()===quote.trim()?`意向与简历一致：${intent}`:quote||intent;
 return <><div className="collection-match"><span className="collection-ellipsis" title={inbox?match?.jobName:person.profile.intent}>{inbox?match?.jobName||'岗位待确认':person.profile.intent||'岗位待确认'}</span>{inbox&&match?.jobName&&<span className="collection-chip">{match.label}</span>}</div>{inbox&&basis&&<small className="collection-ellipsis" title={basis}>依据：{basis.length>28?basis.slice(0,28)+'…':basis}</small>}</>;
}
export function ResumeCell({profile}:{profile:Row}) {
 const skills:string[]=profile.skills||[];
 const education=edu(profile.education)+' · '+(profile.school||'院校未注明');
 return <><div className="collection-ellipsis" title={education}>{education}</div>{skills.length>0&&<div className="collection-skills">{skills.slice(0,3).map((s,i)=><span className="collection-chip" title={s} key={i}>{s}</span>)}{skills.length>3&&<span className="collection-chip" title={skills.join('、')}>+{skills.length-3}</span>}</div>}</>;
}

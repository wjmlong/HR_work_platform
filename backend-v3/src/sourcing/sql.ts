import { filterNames, queryInput } from "./schema.js";
import {searchTermPlan} from './terms.js';
export const directionValues = "regexp_split_to_array(l.direction, '[[:space:]]*[/、,，;；|][[:space:]]*')";
const normalizedTokens = (expression: string) => "ARRAY(SELECT btrim(token) FROM unnest("+expression+") token WHERE btrim(token)<>'')";
export const virtualFacets: Record<string, Record<string, string>> = {
  contactAvailability: {
    present: "btrim(l.contact)<>''",
    missing: "btrim(l.contact)=''",
  },
  followupAge: {
    overdue:
      "((l.state='uncontacted' AND l.created_at<now()-interval '7 days') OR (l.state='contacted' AND l.last_contacted_at<now()-interval '14 days'))",
    recent7: "l.last_followup_at>=now()-interval '7 days'",
    older14: "l.last_followup_at<now()-interval '14 days'",
    never: "l.last_followup_at IS NULL",
  },
};
export function leadWhere(
  q: ReturnType<typeof queryInput.parse>,
  except?: string,
  readable?:Set<string>,
) {
  const values: unknown[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return "$" + values.length;
  };
  const clauses = [q.deleted ? "l.deleted_at IS NOT NULL" : "l.deleted_at IS NULL"];
  if (q.line && q.line !== "all") clauses.push("l.line=" + param(q.line));
  for (const name of filterNames) {
    if (name === except || !q.filters[name]?.length) continue;
    if (virtualFacets[name]) {
      clauses.push(
        "(" +
          q.filters[name]!.map((v) => virtualFacets[name][v] || "false").join(
            " OR ",
          ) +
          ")",
      );
      continue;
    }
    const p = param(q.filters[name]);
    clauses.push(
      name === "skills" || name === "direction"
        ? normalizedTokens(name === "skills" ? "l.skills" : directionValues) + "&&" + p + "::text[]"
        : "l." +
            name +
            (name === "owner_id" ? "::text" : "") +
            "=ANY(" +
            p +
            "::text[])",
    );
  }
  const columns=['name','org','school','major','skills','direction','contact','source','note','raw'].filter(k=>!readable||readable.has(k)).map(k=>k==='skills'?"array_to_string(l.skills,' / ')":'l.'+k);
  columns.push("CASE l.state WHEN 'uncontacted' THEN '未联系' WHEN 'contacted' THEN '已联系未回' WHEN 'replied' THEN '已回复' WHEN 'resume_received' THEN '已拿到简历' WHEN 'uploaded' THEN '已上传系统' WHEN 'declined' THEN '明确拒绝' END","CASE l.line WHEN 'high' THEN '高端线' WHEN 'focus' THEN '集中线' WHEN 'social' THEN '社媒线' END");
  const combined="lower(concat_ws(E'\\n',"+columns.join(',')+'))';
  const terms = q.query.trim().split(/\s+/).filter(Boolean);
  const termsSql = terms.map((word) => {
    const w = word.toLowerCase(),
      escaped = w.replace(/[.*+?^\u0024{}()|[\]\\]/g, "\\$&"),
      plan=searchTermPlan(w),ascii = plan.ascii;
    const exact = ascii
      ? combined +
        "~" +
        param(
          (/^[a-z0-9_]/i.test(w) ? "(^|[^a-z0-9_])" : "") +
            escaped +
            (/[a-z0-9_]$/i.test(w) ? "($|[^a-z0-9_])" : ""),
        )
      : "strpos(" + combined + "," + param(w) + ")>0";
    if(!plan.broaden)return '('+exact+')';
    const grams=new Map(plan.grams.map(gram=>[gram,'strpos('+combined+','+param(gram)+')>0']));
    const coverage=plan.coverage.map(items=>'(CASE WHEN '+items.map(gram=>grams.get(gram)).join(' OR ')+' THEN 1 ELSE 0 END)').join('+');
    if(w.length<=4)return '('+exact+' OR '+[...grams.values()].join(' OR ')+')';
    return (
      "(" + exact + " OR (" + coverage + ")::numeric/" + w.length + ">=0.4)"
    );
  });
  if (termsSql.length)
    clauses.push(
      "(" + termsSql.join(q.matchMode === "any" ? " OR " : " AND ") + ")",
    );
  return { sql: clauses.join(" AND "), values };
}

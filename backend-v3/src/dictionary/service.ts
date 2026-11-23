import type { Database, Sql } from "../db.js";
import { catalog,v4AliasPolicy } from "./data.js";
import { fail } from "../http/errors.js";
import type {DefinitionRef,DictionaryDocument} from '../business-config/types.js';
import {validateDocument} from '../business-config/schema.js';
export class Dictionary {
  constructor(readonly db: Database) {}
  async seed() {
    await this.db.tx(async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('dictionary',0))");
      const markers=new Set((await c.query('SELECT version FROM schema_migrations WHERE version IN (1001,1002)')).rows.map(r=>r.version));
      const initiallyEmpty=Number((await c.query('SELECT count(*) FROM skills')).rows[0].count)===0;
      if(!markers.has(1001)){
        if(initiallyEmpty)for(const [name,category,aliases] of catalog){
          await c.query('INSERT INTO skills(name,category) VALUES($1,$2) ON CONFLICT DO NOTHING',[name,category]);
          for(const alias of [name,...aliases])await c.query('INSERT INTO skill_aliases(alias,skill) VALUES($1,$2) ON CONFLICT DO NOTHING',[alias.toLowerCase(),name]);
        }
        await c.query('INSERT INTO schema_migrations(version) VALUES(1001)');
      }
      if(!markers.has(1002)){
        let changed=false;
        for(const [name,category,aliases] of catalog){
          const inserted=await c.query('INSERT INTO skills(name,category) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING name',[name,category]);
          if(!inserted.rowCount)continue;
          changed=true;
          for(const alias of [name,...aliases])await c.query('INSERT INTO skill_aliases(alias,skill) VALUES($1,$2) ON CONFLICT DO NOTHING',[alias.toLowerCase(),name]);
        }
        for(const [alias,skill] of v4AliasPolicy){
          const result=await c.query('INSERT INTO skill_aliases(alias,skill) VALUES($1,$2) ON CONFLICT(alias) DO UPDATE SET skill=EXCLUDED.skill WHERE skill_aliases.skill<>EXCLUDED.skill RETURNING alias',[alias.toLowerCase(),skill]);
          if(result.rowCount)changed=true;
        }
        if(changed&&!initiallyEmpty)await c.query('UPDATE dictionary_versions SET version=version+1 WHERE id=1');
        await c.query('INSERT INTO schema_migrations(version) VALUES(1002)');
      }
    });
  }
  async normalize(values: string[], sql: Sql = this.db.sql,ref?:DefinitionRef) {
    if (!values.length) return [];
    const snapshot=(await sql.query("SELECT v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=coalesce($1::int,c.published_version) WHERE c.key='dictionary.skills' AND ($2::uuid IS NULL OR c.id=$2)",[ref?.version??null,ref?.configId??null])).rows[0];
    if(ref&&!snapshot)fail(422,'dictionary_reference_invalid');
    if(snapshot){
      const map=new Map<string,string>();
      for(const option of (snapshot.document as DictionaryDocument).options.filter(o=>o.active))for(const alias of [option.id,option.label,...option.aliases])map.set(alias.trim().toLowerCase(),option.id);
      return [...new Set(values.map(v=>map.get(v.trim().toLowerCase())||v.trim()).filter(Boolean))];
    }
    const r = await sql.query(
      "SELECT alias,skill FROM skill_aliases WHERE alias=ANY($1::text[])",
      [values.map((v) => v.trim().toLowerCase())],
    );
    const map = new Map<string, string>(r.rows.map((x) => [x.alias, x.skill]));
    return [
      ...new Set(
        values
          .map((v) => map.get(v.trim().toLowerCase()) || v.trim())
          .filter(Boolean),
      ),
    ];
  }
  async list() {
    const snapshot=(await this.db.query("SELECT v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.skills'")).rows[0];
    if(snapshot)return (snapshot.document as DictionaryDocument).options.map(o=>({name:o.id,label:o.label,category:o.category||'custom',aliases:o.aliases,active:o.active}));
    return (
      await this.db.query(
        "SELECT s.*,coalesce(array_agg(a.alias) FILTER(WHERE a.alias IS NOT NULL),'{}') aliases FROM skills s LEFT JOIN skill_aliases a ON a.skill=s.name GROUP BY s.name ORDER BY s.category,s.name",
      )
    ).rows;
  }
  async update(name: string, aliases: string[], category: string) {
    return this.db.tx(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('dictionary',0))",
      );
      await c.query(
        "INSERT INTO skills(name,category) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET category=$2",
        [name, category],
      );
      for (const alias of [name, ...aliases]) {
        const r = await c.query(
          "SELECT skill FROM skill_aliases WHERE alias=$1",
          [alias.toLowerCase()],
        );
        if (r.rows[0] && r.rows[0].skill !== name) fail(409, "alias_conflict");
      }
      await c.query("DELETE FROM skill_aliases WHERE skill=$1", [name]);
      for (const a of [
        ...new Set([name, ...aliases].map((x) => x.toLowerCase())),
      ])
        await c.query("INSERT INTO skill_aliases(alias,skill) VALUES($1,$2)", [
          a,
          name,
        ]);
      const v = (
        await c.query(
          "UPDATE dictionary_versions SET version=version+1 WHERE id=1 RETURNING version",
        )
      ).rows[0];
      // Legacy internal maintenance remains callable for migration tooling. User
      // writes use the preview/publication API, and neither path auto-recomputes.
      const current=(await c.query("SELECT c.id,c.published_version,v.document FROM business_configs c JOIN business_config_versions v ON v.config_id=c.id AND v.version=c.published_version WHERE c.key='dictionary.skills' FOR UPDATE OF c")).rows[0];
      if(current){
        const previous=(current.document as DictionaryDocument).options,old=previous.find(o=>o.id===name);
        const option={...(old||{id:name,label:name,active:true,order:previous.length}),aliases:[...new Set([name,...aliases].map(a=>a.trim().toLowerCase()))],category};
        const document=validateDocument({...current.document,options:old?previous.map(o=>o.id===name?option:o):[...previous,option]});
        await c.query('INSERT INTO business_config_versions(config_id,version,document) VALUES($1,$2,$3)',[current.id,current.published_version+1,document]);
        await c.query('UPDATE business_configs SET published_version=published_version+1,version=version+1,updated_at=now() WHERE id=$1',[current.id]);
      }
      return v;
    });
  }
}

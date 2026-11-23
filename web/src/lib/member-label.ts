export const departmentLabel=(member:{departments?:string[]})=>member.departments?.filter(Boolean).join('、')||'部门未同步';
export const memberLabel=(member:{name:string;departments?:string[]})=>member.name+' · '+departmentLabel(member);

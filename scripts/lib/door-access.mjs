import {unquote,pretty} from './dm.mjs';
export function createDoorResolver(db,mapChanges={}){
  const values=new Map(),helpers=new Map();
  for(const [,text]of db.files||[]){
    for(const m of text.matchAll(/^\s*#define\s+(ACCESS_\w+)\s+"([^"]+)"/gm))values.set(m[2],m[1]);
    for(const m of text.matchAll(/^(\/obj\/effect\/mapping_helpers\/airlock\/access\/[\w/]+)\/get_access\(\)([\s\S]*?)(?=^\/|$(?![\s\S]))/gm))helpers.set(m[1],[...new Set(m[2].match(/\bACCESS_(?!FLAG_)\w+/g)||[])]);
  }
  const canonical=value=>unquote(db.literal(value));
  const tokens=value=>[...new Set([...(String(value||'').match(/\bACCESS_(?!FLAG_)\w+/g)||[]),...[...String(value||'').matchAll(/"([^"]+)"/g)].flatMap(m=>values.has(m[1])?[values.get(m[1])]:[])].map(canonical))];
  const helper=path=>{const result=[];while(path){result.push(...(helpers.get(path)||[]));path=path.slice(0,path.lastIndexOf('/'));}return [...new Set(result.map(canonical))];};
  const roles=[];
  for(const [path]of db.types)if(/^\/datum\/id_trim\/job\/[^/]+$/.test(path)){
    const v=db.resolve(path),job=db.resolve(v.job||''),name=unquote(db.literal(v.assignment||job.title||''))||pretty(path);
    if(!name||name.includes('JOB_'))continue;
    const changes=mapChanges[name]||{},minimal=new Set([...tokens(v.minimal_access),...tokens(v.minimal_wildcard_access),...tokens(v.access),...tokens(JSON.stringify(changes.additional_minimal_access||[]))]);
    const expanded=new Set([...minimal,...tokens(v.extra_access),...tokens(v.extra_wildcard_access),...tokens(JSON.stringify(changes.additional_access||[]))]);
    roles.push({name,minimal,expanded,captain:path==='/datum/id_trim/job/captain'});
  }
  const match=(role,set,all,any)=>{
    const has=access=>set.has(access)||(role.captain&&!/SYNDICATE|BLOODCULT|CENTCOM|AWAY|WIZARD|PIRATE/i.test(access));
    return all.every(has)&&(!any.length||any.some(has));
  };
  const resolveDoor=(atoms,door)=>{
    const v={...db.resolve(door.path),...door.vars};
    if(/\/poddoor(?:\/|$)/.test(door.path))return {kind:'remote',roles:[],expandedRoles:[]};
    const all=tokens(v.req_access),any=tokens(v.req_one_access);let unresolved=false;
    for(const atom of atoms)if(atom.path.startsWith('/obj/effect/mapping_helpers/airlock/access/')){const access=helper(atom.path);if(!access.length)unresolved=true;(atom.path.includes('/access/any/')?any:all).push(...access);}
    for(const property of ['req_access_txt','req_one_access_txt'])if(v[property]&&v[property]!=='null'){
      const parsed=unquote(v[property]).split(/[;, ]+/).filter(Boolean).map(x=>values.get(x)).filter(Boolean);if(!parsed.length)unresolved=true;(property==='req_access_txt'?all:any).push(...parsed);
    }
    if(unresolved)return{kind:'unknown',roles:[],expandedRoles:[]};
    if(!all.length&&!any.length)return{kind:'public',roles:[],expandedRoles:[]};
    const normal=[...new Set(roles.filter(r=>match(r,r.minimal,all,any)).map(r=>r.name))].sort();
    const extra=[...new Set(roles.filter(r=>!normal.includes(r.name)&&match(r,r.expanded,all,any)).map(r=>r.name))].sort();
    return{kind:'restricted',roles:normal,expandedRoles:extra,all:[...new Set(all)],any:[...new Set(any)]};
  };
  resolveDoor.roles=[...new Set(roles.map(role=>role.name))].sort();
  return resolveDoor;
}

import Fuse from 'fuse.js';

export function indexDoorTiles(map,levels){
  const definitions=new Map(map.definitions.flatMap((definition,index)=>{
    const access=definition.atoms.filter(atom=>atom.doorAccess).map(atom=>atom.doorAccess);
    return access.length?[[index,access]]:[];
  })),tiles=[];
  for(const [z,level]of levels)for(let index=0;index<level.grid.length;index++){
    const access=definitions.get(level.grid[index]);if(access)tiles.push({x:index%map.width+1,y:map.height-Math.floor(index/map.width),z,access});
  }
  return tiles;
}
export function doorMarkersForRoles(tiles,roles){
  if(!roles.length)return[];
  return tiles.flatMap(tile=>{
    const decisions=roles.map(role=>{
      const access=tile.access.map(rule=>rule.kind==='public'?'normal':rule.kind==='remote'?'denied':rule.kind==='restricted'?(rule.roles||[]).includes(role)?'normal':(rule.expandedRoles||[]).includes(role)?'expanded':'denied':'unknown');
      return access.includes('denied')?'denied':access.includes('unknown')?'unknown':access.includes('expanded')?'expanded':'normal';
    });
    const status=decisions.every(value=>value==='normal')?'allowed':decisions.some(value=>value==='normal'||value==='expanded')?'partial':decisions.includes('unknown')?null:'denied';
    return status?[{...tile,status}]:[];
  });
}
export function roleSuggestions(roles,query,selected=[]){
  const available=roles.filter(role=>!selected.includes(role));
  return query.trim()?new Fuse(available,{threshold:.45,ignoreLocation:true}).search(query.trim()).slice(0,8).map(result=>result.item):available.slice(0,8);
}
export function groupDoorAccess(doors){
  const groups=new Map();for(const door of doors){const access=door.doorAccess,key=JSON.stringify([access.kind,[...(access.roles||[])].sort(),[...(access.expandedRoles||[])].sort()]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(door);}
  return [...groups.values()].map(group=>{const names=[...new Set(group.map(door=>door.name))];return {...group[0],controlKeys:group.flatMap(door=>door.controlKeys||[]),name:names.length>1?names.slice(0,-1).join(', ')+' & '+names.at(-1):names[0]};});
}

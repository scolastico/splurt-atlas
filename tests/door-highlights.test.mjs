import test from 'node:test';import assert from 'node:assert/strict';
import {indexDoorTiles,doorMarkersForRoles,roleSuggestions,groupDoorAccess} from '../src/door-highlights.js';
test('door highlights use starting roles, public access and remote restrictions, preserving each deck',()=>{
 const definition=access=>({atoms:access.map(doorAccess=>({doorAccess}))});
 const map={width:3,height:2,definitions:[definition([]),definition([{kind:'public'}]),definition([{kind:'restricted',roles:['Engineer'],expandedRoles:['Assistant']}]),definition([{kind:'unknown'}]),definition([{kind:'remote'}])]};
 const tiles=indexDoorTiles(map,new Map([[1,{grid:[1,2,3,0,4,0]}],[2,{grid:[0,0,0,2,0,0]}]]));
 assert.deepEqual(doorMarkersForRoles(tiles,[]),[]);
 const assistant=doorMarkersForRoles(tiles,['Assistant']);assert.deepEqual(assistant.map(({x,y,z,status})=>[x,y,z,status]),[[1,2,1,'allowed'],[2,2,1,'partial'],[2,1,1,'denied'],[1,1,2,'partial']]);
 assert.equal(doorMarkersForRoles(tiles,['Engineer']).filter(marker=>marker.status==='allowed').length,3);
 const combined=doorMarkersForRoles(tiles,['Engineer','Assistant']);assert.equal(combined.filter(marker=>marker.status==='allowed').length,1);assert.equal(combined.filter(marker=>marker.status==='partial').length,2);
});
test('role suggestions tolerate typos and exclude tags already selected',()=>{
 const roles=['Assistant','Station Engineer','Security Officer'];assert.ok(roleSuggestions(roles,'enginer').includes('Station Engineer'));assert.ok(roleSuggestions(roles,'securty').includes('Security Officer'));assert.deepEqual(roleSuggestions(roles,'enginer',['Station Engineer']),[]);
});
test('friendly inspector combines doors only when normal and expanded access match',()=>{
 const door=(name,doorAccess)=>({name,doorAccess}),publicAccess={kind:'public',roles:[],expandedRoles:[]};const result=groupDoorAccess([door('Bar',publicAccess),door('emergency shutter',publicAccess),door('Engineering',{kind:'restricted',roles:['Engineer'],expandedRoles:[]})]);assert.equal(result.length,2);assert.equal(result[0].name,'Bar & emergency shutter');assert.equal(result[1].name,'Engineering');
});

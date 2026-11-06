import test from 'node:test';import assert from 'node:assert/strict';import {createObjectVisual} from '../scripts/lib/object-visual.mjs';
import {objectOffsets} from '../scripts/lib/object-offsets.mjs';
test('offset object highlights follow the opaque sprite bounds in the neighboring tile',async()=>{
 const db={resolve:()=>({icon:"'button.dmi'",icon_state:'"button"',pixel_x:'-24',pixel_y:'6'})},sprites={sprite:async()=>({width:32,height:32,bounds:{x:10,y:5,width:12,height:8}})};
 const visual=createObjectVisual(db,sprites);assert.deepEqual(await visual({path:'/obj/machinery/button/door',vars:{}}),{x:-14,y:-1,width:12,height:8});assert.equal(await visual({path:'/turf/open/floor',vars:{}}),undefined);
});
test('map-load wall offsets apply to base APCs and showers and resolve mapped constants consistently',async()=>{
 const db={literal:value=>({'APC_PIXEL_OFFSET':'25','-OFFSET':'-32'}[value]||value)};
 assert.equal(objectOffsets('/obj/machinery/power/apc',{dir:'8',pixel_y:'6'},db).pixel_x,'-25');
 assert.equal(objectOffsets('/obj/machinery/power/apc',{dir:'8',pixel_y:'6'},db).pixel_y,'6');
 assert.equal(objectOffsets('/obj/machinery/power/apc/auto_name',{dir:'1'},db).pixel_y,'25');
 assert.equal(objectOffsets('/obj/machinery/shower',{dir:'4',pixel_shift:'16'},db).pixel_x,'-16');
 assert.equal(objectOffsets('/obj/machinery/shower',{dir:'4',pixel_shift:'16'},db).pixel_y,'0');
 assert.equal(objectOffsets('/obj/machinery/wall_healer',{pixel_x:'-OFFSET'},db).pixel_x,'-32');
 assert.equal(objectOffsets('/obj/machinery/keycard_auth',{pixel_x:'null',pixel_y:'28'},db).pixel_x,'0');
 const sprites={sprite:async()=>({width:32,height:32,bounds:{x:0,y:0,width:32,height:32}})};
 assert.equal((await createObjectVisual({...db,resolve:()=>({icon:"'apc.dmi'",dir:'8'})},sprites)({path:'/obj/machinery/power/apc',vars:{}})).x,-25);
});

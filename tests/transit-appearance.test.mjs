import test from 'node:test';import assert from 'node:assert/strict';import {transitOverlays} from '../scripts/lib/transit-appearance.mjs';
test('transit diagonals reproduce shifted game overlays in adjacent cardinal tiles',()=>{
 const db={resolve:()=>({}),files:[['tube.dm',`/obj/structure/transit_tube/diagonal/init_tube_dirs()
    switch(dir)
        if(NORTH)
            tube_dirs = list(NORTHEAST, SOUTHWEST)
        if(WEST)
            tube_dirs = list(NORTHWEST, SOUTHEAST)
`]]};
 const atom=dir=>({path:'/obj/structure/transit_tube/diagonal/crossing',vars:{dir:String(dir)}});
 const north=transitOverlays(atom(1),db);assert.deepEqual(north.map(a=>[a.vars.icon_state,a.vars.dir,a.vars.pixel_w,a.vars.pixel_z]),[['"decorative_diag"','6','0','32'],['"decorative_diag"','9','32','0']]);
 const west=transitOverlays(atom(8),db);assert.deepEqual(west.map(a=>[a.vars.dir,a.vars.pixel_w,a.vars.pixel_z]),[['10','0','32'],['5','-32','0']]);assert.deepEqual(transitOverlays({path:'/obj/structure/cable',vars:{}},db),[]);
});

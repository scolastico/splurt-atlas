import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
import {loadTypes} from '../scripts/lib/dm.mjs';
test('declarative macros create real decal states and directional offsets without leaking into adjacent types',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'atlas-types-'));
 try{
  writeFileSync(path.join(root,'tgstation.dme'),'#include "types.dm"');
  writeFileSync(path.join(root,'types.dm'),`#define OFFSET 27
/obj/decal
    icon_state = "circle"
    color = "#9fed58"
#define MARKINGS(path)\\
##path/filled/line { icon_state = "trimline_fill"; }\\
##path/filled/mid_joiner { icon_state = "trimline_mid_fill"; }
MARKINGS(/obj/decal)
/obj/alarm
    icon_state = "alarm"
#define WALL_HELPER(path, offset) ##path/directional/south { dir = SOUTH; pixel_y = -offset; } ##path/directional/east { dir = EAST; pixel_x = offset; }
WALL_HELPER(/obj/alarm, 27)
WALL_HELPER(/obj/constant, OFFSET)
/obj/decal/filled/line
    alpha = 110
/obj/decal/filled/line/Initialize(mapload)
    icon_state = "must not run"
#undef MARKINGS
MARKINGS(/obj/ignored)
#define LAYERS(path) ##path/layer4 { piping_layer = 4; }
#define PARTIAL(path, Color) LAYERS(path/hidden) ##path { pipe_color = Color; } ##path/visible { hide = FALSE; }
#define FAMILY(Type, Color) PARTIAL(/obj/pipe/##Type, Color)
FAMILY(supply, "#0000ff")
WALL_HELPER(/obj/sink, (-16))
/obj/frame
    pixel_shift = 32
WALL_HELPER(/obj/fish, /obj/frame::pixel_shift)
`);
  const db=loadTypes(root);
  assert.equal(db.resolve('/obj/decal').icon_state,'"circle"');assert.equal(db.resolve('/obj/decal/filled/line').icon_state,'"trimline_fill"');assert.equal(db.resolve('/obj/decal/filled/line').color,'"#9fed58"');assert.equal(db.resolve('/obj/decal/filled/line').alpha,'110');
  assert.equal(db.resolve('/obj/decal/filled/mid_joiner').icon_state,'"trimline_mid_fill"');
  assert.equal(db.resolve('/obj/alarm/directional/south').pixel_y,'-27');assert.equal(db.resolve('/obj/alarm/directional/south').dir,'2');assert.equal(db.resolve('/obj/alarm/directional/east').pixel_x,'27');assert.equal(db.resolve('/obj/constant/directional/east').pixel_x,'27');assert.equal(db.types.has('/obj/ignored/filled/line'),false);
  assert.equal(db.resolve('/obj/pipe/supply/visible').hide,'FALSE');assert.equal(db.resolve('/obj/pipe/supply/hidden/layer4').piping_layer,'4');assert.equal(db.resolve('/obj/pipe/supply/visible').pipe_color,'"#0000ff"');
  assert.equal(db.resolve('/obj/constant/directional/south').pixel_y,'-27','Named wall offsets must resolve when negated');
  assert.equal(db.resolve('/obj/sink/directional/south').pixel_y,'16');assert.equal(db.resolve('/obj/sink/directional/east').pixel_x,'-16');
  assert.equal(db.resolve('/obj/fish/directional/south').pixel_y,'-32');assert.equal(db.resolve('/obj/fish/directional/east').pixel_x,'32');
 }finally{if(path.dirname(path.resolve(root))!==path.resolve(tmpdir())||!path.basename(root).startsWith('atlas-types-'))throw new Error('Unsafe test path');rmSync(root,{recursive:true,force:true});}
});

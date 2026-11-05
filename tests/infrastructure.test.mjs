import test from 'node:test';
import assert from 'node:assert/strict';
import {bits,buildInfrastructure} from '../scripts/lib/infrastructure.mjs';
const db={resolve:path=>path.includes('/cable')?{cable_layer:'(1<<1)',icon:"'wire.dmi'"}:{initialize_directions:'(NORTH|SOUTH|EAST|WEST)',piping_layer:'3',dir:'2'},hasIconState:()=>true};
function build(spec){const cells=spec.map(([x,y,z,path,vars={}])=>({x,y,z,appearance:[{path,vars}]}));const at=(x,y,z)=>cells.filter(c=>c.x===x&&c.y===y&&c.z===z).flatMap(c=>c.appearance);return {cells,data:buildInfrastructure(cells,at,db,[1,2])};}
test('connection bitfields retain parenthesized cardinal and cable-layer combinations',()=>{assert.equal(bits('(NORTH|SOUTH|EAST|WEST)'),15);assert.equal(bits('(1<<0)|(1<<2)'),5);});
test('power networks respect layer overlap, cuts, disconnected islands and shaped sprites',()=>{
 const {cells,data}=build([[1,1,1,'/obj/structure/cable'],[2,1,1,'/obj/structure/cable'],[3,1,1,'/obj/structure/cable',{banned_links:'WEST'}],[2,2,1,'/obj/structure/cable',{cable_layer:'1'}]]);
 assert.equal(data.powerNetworks,3);assert.equal(data.nodes[0].network,data.nodes[1].network);assert.notEqual(data.nodes[1].network,data.nodes[2].network);assert.equal(cells[0].appearance[0].vars.icon_state,'"l2-4"');
});
test('multi-Z cable hubs connect matching coordinates across decks',()=>{const {data}=build([[1,1,1,'/obj/structure/cable/multilayer/multiz'],[1,1,2,'/obj/structure/cable/multilayer/multiz']]);assert.equal(data.powerNetworks,1);});
test('smart pipes use actual neighbor ports instead of a four-way cross',()=>{const {cells,data}=build([[1,1,1,'/obj/machinery/atmospherics/pipe/smart'],[2,1,1,'/obj/machinery/atmospherics/pipe/smart'],[3,1,1,'/obj/machinery/atmospherics/pipe/smart']]);assert.equal(data.nodes[1].links,12);assert.equal(cells[1].appearance[0].vars.icon_state,'"12_3"');});
test('ladders expose only mapped vertical destinations',()=>{const {data}=build([[4,4,1,'/obj/structure/ladder'],[4,4,2,'/obj/structure/ladder']]);assert.deepEqual(data.transitions[0].targets.map(t=>t.z),[2]);assert.deepEqual(data.transitions[1].targets.map(t=>t.z),[1]);});

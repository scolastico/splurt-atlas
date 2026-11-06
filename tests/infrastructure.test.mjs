import test from 'node:test';
import assert from 'node:assert/strict';
import { bits, buildInfrastructure } from '../scripts/lib/infrastructure.mjs';
const db = {
  resolve: (path) =>
    path.includes('/cable')
      ? { cable_layer: '(1<<1)', icon: "'wire.dmi'" }
      : { initialize_directions: '(NORTH|SOUTH|EAST|WEST)', piping_layer: '3', dir: '2' },
  hasIconState: () => true,
};
function build(spec) {
  const cells = spec.map(([x, y, z, path, vars = {}]) => ({ x, y, z, appearance: [{ path, vars }] }));
  const at = (x, y, z) =>
    cells.filter((c) => c.x === x && c.y === y && c.z === z).flatMap((c) => c.appearance);
  return { cells, data: buildInfrastructure(cells, at, db, [1, 2]) };
}
test('connection bitfields retain parenthesized cardinal and cable-layer combinations', () => {
  assert.equal(bits('(NORTH|SOUTH|EAST|WEST)'), 15);
  assert.equal(bits('(1<<0)|(1<<2)'), 5);
});
test('power networks respect layer overlap, cuts, disconnected islands and shaped sprites', () => {
  const { cells, data } = build([
    [1, 1, 1, '/obj/structure/cable'],
    [2, 1, 1, '/obj/structure/cable'],
    [3, 1, 1, '/obj/structure/cable', { banned_links: 'WEST' }],
    [2, 2, 1, '/obj/structure/cable', { cable_layer: '1' }],
  ]);
  assert.equal(data.powerNetworks, 3);
  assert.equal(data.nodes[0].network, data.nodes[1].network);
  assert.notEqual(data.nodes[1].network, data.nodes[2].network);
  assert.equal(cells[0].appearance[0].vars.icon_state, '"l2-4"');
});
test('multi-Z cable hubs connect matching coordinates across decks', () => {
  const { data } = build([
    [1, 1, 1, '/obj/structure/cable/multilayer/multiz'],
    [1, 1, 2, '/obj/structure/cable/multilayer/multiz'],
  ]);
  assert.equal(data.powerNetworks, 1);
});
test('smart pipes use actual neighbor ports instead of a four-way cross', () => {
  const { cells, data } = build([
    [1, 1, 1, '/obj/machinery/atmospherics/pipe/smart'],
    [2, 1, 1, '/obj/machinery/atmospherics/pipe/smart'],
    [3, 1, 1, '/obj/machinery/atmospherics/pipe/smart'],
  ]);
  assert.equal(data.nodes[1].links, 12);
  assert.equal(cells[1].appearance[0].vars.icon_state, '"12_3"');
});
test('fluid ducts select cardinal sprites and respect duct colors and layer bitmasks', () => {
  const fixture = {
    ...db,
    literal: (value) => (value === 'DEFAULT' ? '(1<<2)' : value),
    resolve: () => ({
      icon: "'duct.dmi'",
      icon_state: '"nduct"',
      duct_layer: 'DEFAULT',
      duct_color: '"#EEEEEE"',
    }),
  };
  const cells = [
      [0, 0, {}],
      [0, 1, {}],
      [0, -1, {}],
      [1, 0, { duct_layer: '(1<<3)' }],
      [0, 2, { duct_color: '"#ff0000"' }],
      [1, 2, { duct_color: '"#0000ff"' }],
      [-1, 2, { duct_color: '"#ff0000"' }],
    ].map(([x, y, vars]) => ({ x, y, z: 1, appearance: [{ path: '/obj/machinery/duct', vars }] })),
    at = (x, y, z) => cells.find((cell) => cell.x === x && cell.y === y && cell.z === z)?.appearance || [];
  const data = buildInfrastructure(cells, at, fixture, [1]);
  assert.equal(data.nodes[0].links, 3);
  assert.equal(cells[0].appearance[0].vars.icon_state, '"nduct_n_s"');
  assert.equal(data.nodes[3].links, 0, 'Different fluid layers stay separate');
  assert.equal(data.nodes[4].links, 10, 'Red connects south to omni and west to red, never east to blue');
  assert.equal(cells[4].appearance[0].vars.icon_state, '"nduct_s_w"');
  assert.equal(cells[4].appearance[0].vars.color, '"#ff0000"');
});
test('horizontal bridges connect through their horizontal ports and retain the raised bridge overlay', () => {
  const { cells, data } = build([
    [1, 1, 1, '/obj/machinery/atmospherics/pipe/smart'],
    [2, 1, 1, '/obj/machinery/atmospherics/pipe/bridge_pipe', { dir: '4' }],
    [3, 1, 1, '/obj/machinery/atmospherics/pipe/smart'],
  ]);
  assert.equal(data.nodes[1].ports, 12);
  assert.equal(data.nodes[1].links, 12);
  assert.equal(cells[1].appearance[0].vars.icon_state, '"12_3"');
  assert.equal(cells[1].appearance[1].vars.icon_state, '"bridge_center"');
});
test('layer adaptors render only the connected layer branches on each side', () => {
  const pipe = '/obj/machinery/atmospherics/pipe/',
    fixture = {
      ...db,
      resolve: () => ({
        initialize_directions: '15',
        piping_layer: '3',
        pipe_color: '"#eeeeee"',
        hide: 'FALSE',
      }),
      files: [
        [
          'adapter.dm',
          `${pipe}layer_manifold/set_init_directions()
    switch(dir)
        if(EAST, WEST)
            initialize_directions = EAST|WEST
`,
        ],
      ],
    };
  const cells = [
      [1, 'smart', { piping_layer: '2', pipe_color: '"#ff0000"' }],
      [2, 'layer_manifold', { dir: '8', pipe_flags: 'PIPING_ALL_LAYER' }],
      [3, 'smart', { piping_layer: '4', pipe_color: '"#0000ff"' }],
    ].map(([x, type, vars]) => ({ x, y: 1, z: 1, appearance: [{ path: pipe + type, vars }] })),
    at = (x, y, z) => cells.find((cell) => cell.x === x && cell.y === y && cell.z === z)?.appearance || [];
  const data = buildInfrastructure(cells, at, fixture, [1]);
  assert.equal(data.nodes[1].links, 12);
  const states = cells[1].appearance.map((atom) => atom.vars.icon_state);
  assert.ok(states.includes('"manifoldlayer_center"'));
  assert.ok(states.includes('"intact_8_2"'));
  assert.ok(states.includes('"intact_4_4"'));
  assert.equal(states.length, 3);
});
test('ladders expose only mapped vertical destinations', () => {
  const { data } = build([
    [4, 4, 1, '/obj/structure/ladder'],
    [4, 4, 2, '/obj/structure/ladder'],
  ]);
  assert.deepEqual(
    data.transitions[0].targets.map((t) => t.z),
    [2],
  );
  assert.deepEqual(
    data.transitions[1].targets.map((t) => t.z),
    [1],
  );
});
test('atmos respects pipe color, layers and rotated filter ports instead of joining every neighbor', () => {
  const prefix = '/obj/machinery/atmospherics',
    pipe = prefix + '/pipe/smart',
    filter = prefix + '/components/trinary/filter';
  const fixture = {
    ...db,
    files: [
      [
        'filter.dm',
        `${prefix}/components/trinary/set_init_directions()
    switch(dir)
        if(NORTH)
            initialize_directions = EAST|NORTH|SOUTH
`,
      ],
    ],
    resolve: () => ({
      icon: "'pipe.dmi'",
      piping_layer: '3',
      hide: 'FALSE',
      initialize_directions: '15',
      pipe_color: '"#eeeeee"',
    }),
  };
  const cells = [
    [0, 0, filter, { dir: '1' }],
    [1, 0, pipe, { pipe_color: '"#ff0000"' }],
    [1, 1, pipe, { pipe_color: '"#ff0000"' }],
    [1, -1, pipe, { pipe_color: '"#00ff00"' }],
    [2, 0, pipe, { pipe_color: '"#00ff00"' }],
    [0, 1, pipe, { pipe_color: '"#00ff00"' }],
    [0, -1, pipe, { pipe_color: '"#00ff00"' }],
  ].map(([x, y, path, vars]) => ({ x, y, z: 1, appearance: [{ path, vars }] }));
  const at = (x, y, z) =>
    cells.find((cell) => cell.x === x && cell.y === y && cell.z === z)?.appearance || [];
  const data = buildInfrastructure(cells, at, fixture, [1]),
    red = data.nodes.find((node) => node.x === 1 && node.y === 0),
    machine = data.nodes[0];
  assert.equal(red.links, 9, 'The red pipe joins north and the omni filter west, never green south/east');
  assert.equal(machine.ports, 7);
  assert.equal(machine.links, 7);
  assert.equal(machine.exposed, true);
  assert.ok(cells[0].appearance.some((atom) => atom.vars.icon_state === '"intact_4_3"'));
});

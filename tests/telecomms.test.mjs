import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTelecomms, telecommsSettings } from '../scripts/lib/telecomms.mjs';
import { selectedTelecomms, validTelecomHighlights, frequencyLabel } from '../src/model/telecomms.ts';
import { viewFragment } from '../src/model/view-state.ts';
import { encodeMap, decodeMap } from '../scripts/lib/map-format.mjs';

const base = '/obj/machinery/telecomms',
  hub = base + '/hub',
  server = base + '/server/common';
function database() {
  const constants = {
    TRUE: '1',
    FALSE: '0',
    NONE: '0',
    MIN_FREQ: '1441',
    MAX_FREQ: '1489',
    FREQ_COMMON: '1459',
    FREQ_ENGINEERING: '1357',
    RADIO_CHANNEL_COMMON: '"Common"',
    RADIO_CHANNEL_ENGINEERING: '"Engineering"',
  };
  const types = new Map([
    [
      base,
      {
        vars: {
          id: '"NULL"',
          network: '"NULL"',
          freq_listening: 'list()',
          autolinkers: 'list()',
          toggled: 'TRUE',
          long_range_link: 'FALSE',
        },
      },
    ],
    [
      hub,
      {
        vars: { id: '"Hub"', network: '"tcommsat"', long_range_link: 'TRUE', autolinkers: 'list("common")' },
      },
    ],
    [server, { vars: { id: '"Common Server"', network: '"tcommsat"', autolinkers: 'list("common")' } }],
  ]);
  const resolve = (path) => ({
    ...(path !== base && path.startsWith(base + '/') ? resolve(path.slice(0, path.lastIndexOf('/'))) : {}),
    ...(types.get(path)?.vars || {}),
  });
  const text = `#define FREQ_COMMON 1459\n#define FREQ_ENGINEERING 1357\n${server}/Initialize(mapload)\n\t. = ..()\n\tfor(var/i = MIN_FREQ, i <= MAX_FREQ, i += 2)\n\t\tfreq_listening |= i\n`;
  return { types, resolve, files: [['fixture.dm', text]], literal: (value) => constants[value] ?? value };
}
const atom = (path, vars = {}) => ({ path, vars });
function collect(spec, config = {}) {
  const db = database(),
    dictionary = new Map(spec.map((entry, i) => [String(i), [atom('/area/test'), atom(entry[3], entry[4])]]));
  const cells = spec.map(([x, y, z], i) => ({ x, y, z, key: String(i) }));
  return collectTelecomms(cells, dictionary, db, [1, 2, 3], config);
}

test('telecomms resolve inherited settings, mapped overrides and runtime public frequency additions', () => {
  const db = database();
  const settings = telecommsSettings(
    atom(server, { freq_listening: 'list(FREQ_ENGINEERING)', network: '"Override"' }),
    db,
  );
  assert.equal(settings.network, 'Override');
  assert.equal(settings.frequencyMode, 'filtered');
  assert.equal(settings.frequencies.length, 26);
  assert.deepEqual(
    settings.frequencies.find((f) => f.value === 1459),
    { value: 1459, name: 'Common' },
  );
  assert.equal(frequencyLabel(settings.frequencies[0]), '135.7 (Engineering)');
  assert.equal(telecommsSettings(atom(hub), db).frequencyMode, 'all');
  const unknown = telecommsSettings(atom(hub, { freq_listening: 'list(FREQ_COMMON, dynamic())' }), db);
  assert.equal(unknown.frequencyMode, 'unknown');
  assert.deepEqual(unknown.unresolved, ['frequencies']);
});

test('automatic links use shared tags and connected decks rather than matching network names', () => {
  const machines = collect([
    [1, 1, 1, hub],
    [200, 200, 3, server, { network: '"other network"' }],
    [1, 1, 1, server, { autolinkers: 'list("different")' }],
  ]);
  assert.deepEqual(machines[0].links, [1]);
  assert.deepEqual(machines[1].links, [0]);
  assert.deepEqual(machines[2].links, []);
  assert.equal(
    machines[0].atomIndex,
    0,
    'atom indexes exclude area declarations, matching inspector definitions',
  );
});

test('disconnected decks honor the source distance and bilateral long-range exceptions', () => {
  const spec = [
    [1, 1, 1, hub],
    [200, 200, 2, server],
    [21, 21, 2, server],
    [200, 200, 3, server, { long_range_link: 'TRUE' }],
  ];
  const machines = collect(spec, { height_autosetup: false });
  assert.deepEqual(machines[0].links, [2, 3]);
  const stacked = collect(spec, { height_autosetup: false, traits: [{}, { Down: true }, {}] });
  assert.ok(stacked[0].links.includes(1));
});

test('telecomms metadata, links and selected highlights survive map encoding and URL sharing', () => {
  const machines = collect([
    [1, 1, 1, hub],
    [2, 2, 1, server],
  ]);
  const map = { id: 'fixture', width: 10, height: 10, levels: [1], definitions: [], telecomms: machines };
  const decoded = decodeMap(encodeMap(map));
  assert.deepEqual(decoded.telecomms, machines);
  const tile = { x: 1, y: 1, z: 1 };
  assert.deepEqual(selectedTelecomms(map, tile), [machines[0]]);
  assert.deepEqual([...validTelecomHighlights(map, tile, null, [0, 1, 999])], [1]);
  const params = new URLSearchParams(
    viewFragment({
      map,
      x: 16,
      y: 304,
      z: 1,
      zoom: 1,
      selected: tile,
      telecomHighlights: new Set([1]),
    }).slice(1),
  );
  assert.equal(params.get('c'), '1');
  assert.equal(frequencyLabel({ value: 1459 }), '145.9');
});

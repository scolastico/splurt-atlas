import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';

export function dmiMetadata(png) {
  let description = '';
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'zTXt') {
      const end = data.indexOf(0);
      if (data.toString('utf8', 0, end) === 'Description') description = inflateSync(data.subarray(end + 2)).toString('utf8');
    } else if (type === 'tEXt' && data.toString('utf8').startsWith('Description\0')) description = data.subarray(12).toString('utf8');
    offset += size + 12;
  }
  const width = +(description.match(/\bwidth\s*=\s*(\d+)/)?.[1] || 32);
  const height = +(description.match(/\bheight\s*=\s*(\d+)/)?.[1] || 32);
  const states = new Map(); let offset = 0;
  for (const m of description.matchAll(/state\s*=\s*"(.*?)"([\s\S]*?)(?=\nstate\s*=|# END|$)/g)) {
    const dirs = +(m[2].match(/dirs\s*=\s*(\d+)/)?.[1] || 1);
    const frames = +(m[2].match(/frames\s*=\s*(\d+)/)?.[1] || 1);
    states.set(m[1], { offset, dirs, frames }); offset += dirs * frames;
  }
  return { width, height, states };
}

export function createSpriteReader(root) {
  const files = new Map(), sprites = new Map();
  const metadata = new Map();
  function hasState(icon, state) {
    try {
      if (!metadata.has(icon)) metadata.set(icon, dmiMetadata(readFileSync(`${root}/${icon}`)));
      return metadata.get(icon).states.has(state);
    } catch { return false; }
  }
  const icons = new Set();
  const report = { requested: 0, missingIcon: 0, missingState: 0, samples: [] };
  async function sprite(icon, state, dir = 2, tint = '', alpha = 255) {
    const key = JSON.stringify([icon, state, dir, tint, alpha]);
    if (sprites.has(key)) return sprites.get(key);
    const job = (async () => {
      report.requested++;
      icons.add(icon);
      try {
        if (!files.has(icon)) {
          const buffer = readFileSync(`${root}/${icon}`), meta = dmiMetadata(buffer);
          const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          files.set(icon, { ...meta, data, info });
          if (files.size > 48) files.delete(files.keys().next().value);
        }
        const file = files.get(icon);
        let chosen = file.states.get(state);
        if (!chosen) {
          report.missingState++;
          if (report.samples.length < 80) report.samples.push({ icon, state });
          chosen = file.states.get(`${state}-0`) || file.states.get('') || file.states.values().next().value;
        }
        const directions = [2, 1, 4, 8, 6, 10, 5, 9];
        const frame = (chosen?.offset || 0) + Math.max(0, directions.slice(0, chosen?.dirs || 1).indexOf(+dir));
        const cols = Math.floor(file.info.width / file.width);
        const left = frame % cols * file.width, top = Math.floor(frame / cols) * file.height;
        if (top + file.height > file.info.height) throw new Error('Frame outside icon');
        let image = sharp(file.data, { raw: file.info }).extract({ left, top, width: file.width, height: file.height });
        let { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
        const color = /^#[\da-f]{6}$/i.test(tint) ? [1, 3, 5].map(n => parseInt(tint.slice(n, n + 2), 16) / 255) : [1, 1, 1];
        for (let p = 0; p < data.length; p += 4) {
          for (let c = 0; c < 3; c++) data[p + c] *= color[c];
          data[p + 3] *= alpha / 255;
        }
        return { input: await sharp(data, { raw: info }).png().toBuffer(), width: info.width, height: info.height };
      } catch {
        report.missingIcon++; return null;
      }
    })();
    sprites.set(key, job); return job;
  }
  return { sprite, report, icons, hasState };
}

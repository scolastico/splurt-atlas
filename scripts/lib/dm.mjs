import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { splitTop } from './dmm.mjs';
import { expandTypeMacros } from './type-macros.mjs';

export const unquote = value => {
  const raw = String(value ?? '');
  const quoted = raw.match(/^"((?:\\.|[^"\\])*)"|^'((?:\\.|[^'\\])*)'/);
  return (quoted ? quoted[1] ?? quoted[2] : raw).replace(/\\(?:improper|proper)\s*/g, '').replace(/\\n/g, ' ');
};
export const pretty = value => value.split('/').at(-1).replaceAll('_', ' ');
export function stripComments(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, token => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
}

export function loadTypes(root) {
  const types = new Map(), seen = new Set(), files = [], constants = new Map([['NORTH','1'],['SOUTH','2'],['EAST','4'],['WEST','8'],['NORTHEAST','5'],['SOUTHEAST','6'],['NORTHWEST','9'],['SOUTHWEST','10']]);
  function include(file) {
    file = path.resolve(root, file.replaceAll('\\', '/'));
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const text = stripComments(readFileSync(file, 'utf8'));
    if (/\.dm$/i.test(file)) files.push([file, text]);
    for (const m of text.matchAll(/^\s*#include\s+"([^"]+\.(?:dm|dme))"/gm)) include(m[1]);
  }
  include('tgstation.dme');
  for (const [, text] of files) for (const m of text.matchAll(/^\s*#define\s+(\w+)\s+([^\n]+)/gm)) constants.set(m[1], m[2].trim());
  function literal(value, seen = new Set()) {
    if(seen.size>32)return value;
    if (value?.startsWith('MAP_SWITCH(') && value.endsWith(')')) return literal(splitTop(value.slice(11, -1))[0] || '', seen);
    if (constants.has(value) && !seen.has(value)) { seen.add(value); return literal(constants.get(value), seen); }
    if(value?.startsWith('(')&&value.endsWith(')')){let depth=0,outer=true;for(let i=0;i<value.length-1;i++){if(value[i]==='(')depth++;if(value[i]===')')depth--;if(depth===0){outer=false;break;}}if(outer)return literal(value.slice(1,-1).trim(),seen);}
    // Directional helpers negate constants, parenthesized offsets and static
    // type properties. Resolve declarations only; never execute expressions.
    const signed=value?.match(/^([+-])\s*(.+)$/);
    if(signed){const number=literal(signed[2],seen);if(/^[-+]?\d+(?:\.\d+)?$/.test(number))return String((signed[1]==='-'?-1:1)*Number(number));}
    const property=value?.match(/^(\/[\w/]+)::(\w+)$/);
    if(property&&!seen.has(value)){seen.add(value);const source=sourceFor(property[1],property[2]);if(source)return literal(source.value,seen);}
    if(/^"(?:\\.|[^"\\])*"(?:\s*\+\s*"(?:\\.|[^"\\])*")+$/.test(value||''))return JSON.stringify(splitTop(value,'+').map(unquote).join(''));
    return value;
  }
  const typeMacros=new Map();
  for (const [file, source] of files) {
    const text=expandTypeMacros(source,typeMacros);
    let current = null, pending = '', balance = 0, prop = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw;
      if (pending) {
        pending += '\n' + line;
        balance += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        if (balance <= 0) { current.vars[prop] = pending.trim();(current.sources||={})[prop]=path.relative(root,file).replaceAll('\\','/');pending = ''; }
        continue;
      }
      if (line.startsWith('/')) {
        const m = line.match(/^(\/[\w/]+)\s*$/);
        if (m) {
          if (!types.has(m[1])) types.set(m[1], { vars: {}, file: path.relative(root, file).replaceAll('\\', '/') });
          current = types.get(m[1]);
        } else current = null; // Procedure bodies are deliberately never interpreted.
      } else if (current) {
        const m = line.match(/^(?:\t| {4})(?:var\/(?:[\w]+\/)*)?([\w]+)\s*=\s*(.+)$/);
        if (m) {
          prop = m[1]; pending = m[2];
          balance = (pending.match(/\(/g) || []).length - (pending.match(/\)/g) || []).length;
          if (balance <= 0) { current.vars[prop] = pending.trim();(current.sources||={})[prop]=path.relative(root,file).replaceAll('\\','/');pending = ''; }
        }
      }
    }
  }
  const cache = new Map();
  function resolve(type, visited = new Set()) {
    if (cache.has(type)) return cache.get(type);
    if (!type || visited.has(type)) return {};
    visited.add(type);
    const own = types.get(type);
    const parent = own?.vars.parent_type?.startsWith('/') ? own.vars.parent_type : type.slice(0, type.lastIndexOf('/'));
    const result = { ...resolve(parent, visited), ...own?.vars };
    for (const key of ['icon', 'icon_state', 'base_icon_state', 'dir', 'color', 'alpha', 'layer', 'plane', 'transform','pixel_x','pixel_y','pixel_z','pixel_w','cable_layer','banned_links','pipe_color','piping_layer','initialize_directions']) if (result[key]) result[key] = literal(result[key]);
    cache.set(type, result); return result;
  }
  // Global static maintenance pools are assigned in Initialize(), not in loot.
  const pools = {};
  for (const [, text] of files) {
    for (const m of text.matchAll(/GLOBAL_LIST_INIT\((\w+),\s*list\(/g)) {
      let end = m.index + m[0].length, depth = 1;
      const start = end;
      while (end < text.length && depth) { if (text[end] === '(') depth++; if (text[end] === ')') depth--; end++; }
      const body = text.slice(start, end - 1);
      pools[m[1]] = { paths: [...new Set(body.match(/\/(?:obj|mob)\/[\w/]+/g) || [])], refs: [...body.matchAll(/GLOB\.(\w+)/g)].map(v => v[1]) };
    }
  }
  function pool(name, seen = new Set()) {
    if (seen.has(name)) return []; seen.add(name);
    return [...new Set([...(pools[name]?.paths || []), ...(pools[name]?.refs || []).flatMap(n => pool(n, seen))])];
  }
  function sourceFor(type,property,seen=new Set()){
    if(!type||seen.has(type))return null;seen.add(type);const own=types.get(type);
    if(own&&Object.hasOwn(own.vars,property))return{type,property,value:own.vars[property],file:own.sources?.[property]||own.file};
    return sourceFor(own?.vars.parent_type?.startsWith('/')?own.vars.parent_type:type.slice(0,type.lastIndexOf('/')),property,seen);
  }
  return { types, resolve, pools, pool, literal, files,sourceFor,root:path.resolve(root),fileCount: files.length };
}

export function classify(type) {
  if (/^\/obj\/machinery\/duct(?:\/|$)/.test(type)) return 'fluid';
  if (/\/atmospherics\//.test(type)) return 'pipes';
  if (/\/cable(?:\/|$)/.test(type)) return 'power';
  if (/\/disposal(?:s|pipe|outlet|construct)?(?:\/|$)/.test(type)) return 'disposal';
  if (/\/transit_tube(?:\/|$)/.test(type)) return 'transit';
  return null;
}

export function aperture(turf) {
  if (/\/space(?:\/|$)|\/openspace(?:\/|$)/.test(turf)) return 255;
  if (/\/floor\/glass(?:\/|$)/.test(turf)) return 190;
  if (/\/catwalk(?:\/|$)/.test(turf)) return 145;
  return 0;
}

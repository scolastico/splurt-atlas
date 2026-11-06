import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// A small side channel for the dev loading page. It never triggers a conversion.
export function exportProgress(root = process.cwd()) {
  const folder = path.join(root, '.cache');
  mkdirSync(folder, { recursive: true });
  const name=process.env.ATLAS_PROGRESS_FILE||'export-progress.json';
  if(!/^[\w.-]+\.json$/.test(name))throw new Error('Invalid progress filename');
  const file = path.join(folder, name), temporary = `${file}.${process.pid}.tmp`;
  let last = 0, finished = false, state = { pid: process.pid, phase: 'preparing', percent: 0, message: 'Starting map export' };
  const save = () => { try { writeFileSync(temporary, JSON.stringify({ ...state, updated: Date.now() })); renameSync(temporary, file); } catch { /* Reporting must not break a conversion. */ } };
  const update = (message, percent = state.percent) => {
    state = { ...state, message, percent: Math.max(state.percent, Math.min(99, percent)) };
    if (Date.now() - last > 250) { last = Date.now(); save(); }
  };
  const finish = () => { finished = true; state = { ...state, phase: 'ready', percent: 100, message: 'Map export complete' }; save(); };
  process.once('exit', code => { if (!finished) { state = { ...state, phase: 'error', message: `Map export stopped (exit ${code}). Check the export terminal, then retry.` }; save(); } });
  save();
  return { update, finish };
}

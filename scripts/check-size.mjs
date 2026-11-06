import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
function size(dir) {
  return readdirSync(dir).reduce((total, name) => {
    const file = path.join(dir, name);
    return total + (statSync(file).isDirectory() ? size(file) : statSync(file).size);
  }, 0);
}
const bytes = size('dist');
console.log(`Static deployment: ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
if (bytes > 950 * 1024 * 1024)
  throw new Error('Export exceeds the project 950 MiB Pages budget. Select fewer maps in atlas.config.json.');

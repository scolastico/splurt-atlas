// The "Offline storage" sidebar section and the first-visit storage dialog.
import { assetCache, getDataBase } from '../data/source.ts';
import { $ } from '../core/dom.ts';
import { state } from '../core/state.ts';
import type { ManifestMap } from '../core/types.ts';

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Starts or resumes saving maps for offline use according to the chosen mode. */
export async function warmStorage(): Promise<void> {
  if (!state.manifest) return;
  if (assetCache.enabled)
    await assetCache.write(
      `${assetCache.scope}:catalog`,
      new Blob([JSON.stringify(state.manifest)], { type: 'application/json' }),
    );
  if (assetCache.enabled && !state.map) {
    $('cache-status').textContent = 'Choose a map to start preparing offline maps.';
    return;
  }
  await assetCache.warm(state.manifest, getDataBase());
}

/** Fills in the download and extracted sizes shown in the sidebar and the dialog. */
export function updateStorageSizes(): void {
  const maps = state.manifest!.maps;
  const current = maps.find((map) => map.id === assetCache.currentMap);
  const describe = (label: string, size: (map: ManifestMap) => number) => {
    const sizes = maps.map(size);
    const range = `${megabytes(Math.min(...sizes))} to ${megabytes(Math.max(...sizes))}`;
    const currentSize = current ? `${megabytes(size(current))} for ${current.name}; ` : '';
    return {
      all: `${label}: ${megabytes(sizes.reduce((a, b) => a + b, 0))}`,
      current: `${label}: ${currentSize}${range} depending on the map`,
    };
  };
  const download = describe('Download size', (map) => map.archive?.bytes || map.bytes || 0);
  const extracted = describe('Extracted size', (map) => map.bytes || 0);
  $('storage-all-size').textContent = `${download.all} · ${extracted.all} for all ${maps.length} maps`;
  $('storage-current-size').textContent = `${download.current} · ${extracted.current}`;
  $('storage-size').textContent =
    `All maps - ${download.all}; ${extracted.all}. Current map only - ${download.current}; ${extracted.current}. ` +
    'ZIPs are deleted after extraction. Allow temporary space for one ZIP and a small browser storage overhead.';
  const link = $<HTMLAnchorElement>('download-map');
  link.hidden = !current?.archive;
  if (current?.archive) {
    link.href = new URL(current.archive.path, getDataBase()).href;
    link.download = `${current.id}.zip`;
    link.textContent = `Download ${current.name} ZIP (${megabytes(current.archive.bytes)})`;
  }
}

/** On the first visit, asks which maps to keep on the device before anything loads. */
export async function chooseStorage(): Promise<void> {
  updateStorageSizes();
  if (assetCache.mode) return;
  const dialog = $<HTMLDialogElement>('storage-dialog');
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  await new Promise<void>((resolve) => {
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-storage-mode]'))
      button.onclick = () => {
        assetCache.setMode(button.dataset.storageMode!);
        $<HTMLSelectElement>('storage-mode').value = assetCache.mode!;
        dialog.close();
        resolve();
      };
    dialog.showModal();
  });
}

export function initStorageSettings(): void {
  const select = $<HTMLSelectElement>('storage-mode');
  select.value = assetCache.mode || 'all';
  $('cache-status').textContent = assetCache.enabled ? 'Preparing offline maps…' : 'Offline saving is off.';
  select.onchange = () => {
    assetCache.setMode(select.value);
    void warmStorage();
  };
}

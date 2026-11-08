import type { Atom } from '../core/types.ts';
import { escapeHtml } from '../core/dom.ts';

/** Both inspector modes explain examples without claiming a particular round outcome. */
export function randomPreviewMarkup(atoms: Atom[], markers: boolean): string {
  const sources = atoms.filter((atom) => atom.random);
  if (!sources.length) return '';
  const intro = markers
    ? 'Rainbow question marks identify mapped random spawn locations.'
    : 'Random appearances are previews; the actual outcome is chosen when the round starts.';
  const entries = sources
    .map((atom) => {
      let note: string;
      if (atom.random?.kind === 'vending')
        note =
          atom.description ||
          'A vending machine is guaranteed here, but the displayed model is only one possible outcome.';
      else if (atom.random?.kind === 'gibs')
        note =
          'The normal map view shows representative remains from this spawner. Their appearance and spread are randomized in game.';
      else if (atom.random?.kind === 'spawn')
        note =
          'This is a random spawn point. The exact result, and whether something appears, depend on its source settings.';
      else
        note =
          'The normal map view shows one representative appearance. The actual appearance is randomized in game.';
      return `<li><strong>${escapeHtml(atom.name)}</strong><p>${escapeHtml(note)}</p></li>`;
    })
    .join('');
  return `<section class="random-preview-note"><h4 class="info-heading">Randomized objects</h4><p class="friendly-description">${intro}</p><ul class="friendly-list">${entries}</ul></section>`;
}

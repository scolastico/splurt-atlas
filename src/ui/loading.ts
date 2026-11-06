// The loading overlay shown over the map while a station loads or fails.
import { $ } from '../core/dom.ts';

/** Shows a message with an optional 0–1 progress value, or hides the overlay. */
export function setLoading(message: string, show = true, progress: number | null = null): void {
  $('loading').hidden = !show;
  $('loading-message').textContent = message;
  const bar = $<HTMLProgressElement>('loading-progress');
  if (progress === null) bar.removeAttribute('value');
  else {
    bar.max = 1;
    bar.value = progress;
  }
}

export function showLoadingError(message: string): void {
  $('loading').classList.add('error');
  setLoading(message);
}

export function clearLoadingError(): void {
  $('loading').classList.remove('error');
}

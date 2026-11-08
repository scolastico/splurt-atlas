/** Leave unrelated applications sharing this origin untouched. */
export function clearAtlasPreferences(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith('atlas-')) storage.removeItem(key);
}

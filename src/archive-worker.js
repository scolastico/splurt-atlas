import { extractArchive } from './archive-extract.js';
let acknowledge;
self.onmessage = async (event) => {
  if (event.data.ack) {
    acknowledge?.();
    return;
  }
  try {
    await extractArchive(
      event.data.blob,
      (batch, complete, total) =>
        new Promise((resolve) => {
          acknowledge = resolve;
          self.postMessage({ batch, complete, total });
        }),
      () => false,
      event.data.priorities,
    );
    self.postMessage({ done: true });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

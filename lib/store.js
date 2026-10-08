// Minimal JSON file store. Reads and writes are serialised through one queue
// so two requests can never interleave a read-modify-write on the same file.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createStore(dir) {
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const file = (name) => path.join(dir, name);

  return {
    load: (name) =>
      enqueue(async () => {
        try {
          return JSON.parse(await fs.readFile(file(name), 'utf8'));
        } catch {
          return {};
        }
      }),
    save: (name, data) =>
      enqueue(async () => {
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${file(name)}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmp, file(name));
      }),
  };
}

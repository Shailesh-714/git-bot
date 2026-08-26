// Root package.json is the single source of truth for the version.
// Copies it into extension/package.json (+ lockfile) so the CLI and the
// VS Code extension always release under the same number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function update(file, mutate) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

update(path.join(root, 'extension', 'package.json'), (pkg) => {
  pkg.version = version;
});

const lockPath = path.join(root, 'extension', 'package-lock.json');
if (fs.existsSync(lockPath)) {
  update(lockPath, (lock) => {
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
  });
}

console.log(`extension version synced to ${version}`);

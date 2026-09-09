// 複製 extension/ 為 .test-ext/，並把 matches / host_permissions 加上 http://127.0.0.1/*（僅測試用）。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, '.test-ext');
const LOCAL = 'http://127.0.0.1/*';

function buildTestExt() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(SRC, OUT, { recursive: true });

  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.host_permissions.includes(LOCAL)) manifest.host_permissions.push(LOCAL);
  for (const cs of manifest.content_scripts) {
    if (!cs.matches.includes(LOCAL)) cs.matches.push(LOCAL);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return OUT;
}

module.exports = { buildTestExt, OUT };

if (require.main === module) console.log(buildTestExt());

// 靜態不變量檢查：語法、manifest 權限範圍，以及本專案的安全與錨點規則。
// 用法：node scripts/check-invariants.js（CI 與本機皆可跑，零依賴）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const failures = [];
const notes = [];

function fail(rule, detail) {
  failures.push(rule + ' — ' + detail);
}

function ok(rule, detail) {
  notes.push(rule + '：' + detail);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const extDir = path.join(ROOT, 'extension');
const extFiles = walk(extDir);
const jsFiles = extFiles.filter((f) => f.endsWith('.js'));
const rel = (f) => path.relative(ROOT, f);
const read = (f) => fs.readFileSync(f, 'utf8');

// 1. 語法：擴充元件與腳本的每個 JS 都要能通過 node --check。
const checkTargets = [...jsFiles, ...walk(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js'))];
for (const file of checkTargets) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail('語法檢查', rel(file) + '：' + String(err.stderr || err).split('\n')[0]);
  }
}
ok('語法檢查', checkTargets.length + ' 個 JS 檔通過 node --check');

// 2. manifest：MV3，且權限維持最小範圍。
const manifest = JSON.parse(read(path.join(extDir, 'manifest.json')));
const expectedHosts = ['https://api-free.deepl.com/*', 'https://api.deepl.com/*'];
if (manifest.manifest_version !== 3) fail('manifest', 'manifest_version 應為 3，實際為 ' + manifest.manifest_version);
if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])) {
  fail('manifest', 'permissions 應恰為 ["storage"]，實際為 ' + JSON.stringify(manifest.permissions));
}
if (JSON.stringify([...(manifest.host_permissions || [])].sort()) !== JSON.stringify(expectedHosts)) {
  fail('manifest', 'host_permissions 應恰為兩個 DeepL 網域，實際為 ' + JSON.stringify(manifest.host_permissions));
}
for (const size of ['16', '48', '128']) {
  const icon = path.join(extDir, 'icons', 'icon' + size + '.png');
  if (!fs.existsSync(icon)) fail('圖示', '缺少 ' + rel(icon));
}
ok('manifest', 'MV3、permissions=["storage"]、host 僅兩個 DeepL 網域、三種尺寸圖示齊全');

// 3. 安全不變量：金鑰與網路呼叫的邊界。
const contentFiles = extFiles.filter((f) => f.includes(path.sep + 'content' + path.sep) && f.endsWith('.js'));
const rules = [
  {
    name: '不得使用 storage.sync',
    files: jsFiles,
    pattern: /storage\.sync/,
    why: '金鑰與設定只留本機，不跨裝置同步',
  },
  {
    name: 'content script 不得直接連網',
    files: contentFiles,
    pattern: /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/,
    why: '所有 DeepL 呼叫必須留在 background service worker',
  },
  {
    name: 'content script 不得讀取金鑰值',
    files: contentFiles,
    // 允許 `changes.apiKey` 這種「只判斷金鑰有沒有被改動」的用法（用來觸發重試）；
    // 一旦取值（`changes.apiKey.newValue`）或向 storage 要金鑰（`get({ apiKey })`）就算違規。
    sanitize: (line) => line.replace(/changes\.apiKey(?!\s*\.)/g, ''),
    pattern: /apiKey/,
    why: '金鑰不進入頁面上下文，content script 只能得知它變了、不能得知它是什麼',
  },
  {
    name: '不得以 HTML 字串寫入譯文',
    files: jsFiles,
    pattern: /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    why: '譯文一律以 textContent 寫入，杜絕 XSS',
  },
  {
    name: '選擇器不得使用 Discord hash class',
    files: contentFiles,
    pattern: /__[0-9a-f]{5,6}\b|_[0-9a-f]{6}\b/,
    why: 'hash class 每次 Discord 部署都會變，錨點只能用穩定 id 前綴',
  },
];

for (const rule of rules) {
  for (const file of rule.files) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      const subject = rule.sanitize ? rule.sanitize(line) : line;
      if (rule.pattern.test(subject)) fail(rule.name, rel(file) + ':' + (i + 1) + '（' + rule.why + '）');
    });
  }
}
ok('安全不變量', rules.length + ' 條規則全數通過');

// 4. 不得把真實社群資料留在專案裡。
const publicFiles = [...extFiles, ...walk(path.join(ROOT, 'tests')), ...walk(path.join(ROOT, 'scripts'))]
  .filter((f) => /\.(js|json|html|css|md)$/.test(f));
const forbidden = /discord\.gg\/(?!example\b)[a-z0-9-]+|opensea\.io\/collection\/(?!demo\b)[a-z0-9-]+/i;
for (const file of publicFiles) {
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    if (forbidden.test(line)) fail('真實社群連結', rel(file) + ':' + (i + 1) + '（測試資料一律用 example 網域）');
  });
}
ok('資料衛生', '未發現真實社群邀請連結');

for (const note of notes) console.log('  ✓ ' + note);
if (failures.length) {
  console.error('\n不變量檢查失敗（' + failures.length + ' 項）：');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\n不變量檢查全數通過。');

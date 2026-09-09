// E2E：Playwright 載入未封裝擴充元件，對 Discord 仿真 fixture 與 mock DeepL 跑 PLAN §B.3 全流程。
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { startMockDeepL } = require('../mock-deepl.js');
const { buildTestExt } = require('./build-test-ext.js');

const OUT_DIR = path.join(__dirname, 'out');
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const VIEWPORT = { width: 1280, height: 2000 };

const results = [];
let mock = null;
let fixture = null;
let context = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startStatic(dir) {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, name || 'index.html');
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: 'http://127.0.0.1:' + port, close: () => new Promise((d) => server.close(d)) });
    });
  });
}

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (err) {
    results.push({ name, ok: false });
    console.log('  FAIL  ' + name);
    console.log('        ' + String((err && err.message) || err).split('\n').slice(0, 4).join('\n        '));
  }
}

async function waitUntil(fn, timeout = 6000, interval = 100) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error('waitUntil 逾時（' + timeout + 'ms）');
    await sleep(interval);
  }
}

const api = {
  setMode: (status) => fetch(mock.url + '/__mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).then((r) => r.json()),
  requests: async () => (await (await fetch(mock.url + '/__requests')).json()),
  count: async () => (await api.requests()).count,
};

const doneCount = () => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length;
const allCount = () => document.querySelectorAll('.dt-translation').length;

// popup 的設定要等初始化完成（popup.js 在最後標記 dtReady），否則在慢速環境會操作到尚未就緒的表單。
function popupReady(popup) {
  return popup.waitForFunction(() => document.body.dataset.dtReady === '1', null, { timeout: 15000 });
}

function translationOf(page, id) {
  return page.evaluate((n) => {
    const el = document.querySelector('#chat-messages-1-' + n + ' .contents > [id^="message-content-"]');
    const node = el && el.nextElementSibling;
    return node && node.classList.contains('dt-translation') ? node.textContent : null;
  }, id);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const extPath = buildTestExt();
  mock = await startMockDeepL();
  fixture = await startStatic(FIXTURE_DIR);
  console.log('mock DeepL: ' + mock.url + ' / fixture: ' + fixture.url);

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: VIEWPORT,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = sw.url().split('/')[2];
  console.log('extensionId: ' + extensionId);

  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 660 });
  await popup.goto(popupUrl);
  await popupReady(popup);

  // 3. popup 設定金鑰與目標語言，再注入測試用 apiBase。
  await step('3. popup 儲存金鑰與 ZH-HANT，注入 apiBase', async () => {
    await popup.fill('#apiKey', 'test-key:fx');
    await popup.selectOption('#targetLang', 'ZH-HANT');
    await popup.click('#save');
    await popup.evaluate((base) => chrome.storage.local.set({ apiBase: base }), mock.url);
    const stored = await popup.evaluate(() => chrome.storage.local.get({ apiKey: '', targetLang: '', apiBase: '' }));
    assert.strictEqual(stored.targetLang, 'ZH-HANT');
    assert.strictEqual(stored.apiBase, mock.url);
    assert.ok(stored.apiKey.endsWith(':fx'), '金鑰已寫入 storage.local');
  });

  const page = await context.newPage();
  await page.goto(fixture.url + '/discord-like.html');

  // 4. V3a：20 則英文 → 20 個譯文，mock 只收 ≤1 次 translate。
  await step('4. V3a 20 則英文 → 20 個 .dt-translation 且 translate 請求 ≤ 1', async () => {
    await page.waitForFunction((n) => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length === n, 20, { timeout: 10000 });
    assert.strictEqual(await page.evaluate(doneCount), 20);
    assert.strictEqual(await translationOf(page, 1), '【譯】gm everyone, hope you are having a great week');
    const count = await api.count();
    assert.ok(count <= 1, 'translate 請求數 ' + count + ' 應 ≤ 1');
    assert.strictEqual((await api.requests()).requests[0].n, 20, '單一請求內含 20 則');
  });

  // 5. V3b：中文／emoji／URL／提及不翻；回覆引用列內的 message-content 不翻。
  await step('5. V3b 純中文／emoji／URL／提及無譯文；回覆引用列不翻', async () => {
    assert.strictEqual(await page.evaluate(allCount), 20, '譯文總數仍為 20');
    assert.strictEqual(await translationOf(page, 21), null, '純中文無譯文');
    assert.strictEqual(await translationOf(page, 22), null, '純 emoji 無譯文');
    assert.strictEqual(await translationOf(page, 23), null, '純 URL 無譯文');
    assert.strictEqual(await translationOf(page, 24), null, '純提及無譯文');
    const dup = await page.evaluate(() => document.querySelectorAll('[id="message-content-3"]').length);
    assert.strictEqual(dup, 2, 'fixture 內確有重複 id 的 message-content');
    const inReply = await page.evaluate(() => document.querySelector('[id^="message-reply-context-"]').querySelectorAll('.dt-translation').length);
    assert.strictEqual(inReply, 0, '回覆引用列內無譯文');
  });

  await step('5b. 自訂 emoji 與「已編輯」被剔除、unicode emoji 保留', async () => {
    const t = await translationOf(page, 18);
    assert.strictEqual(t, '【譯】this reveal is wild 🤣 and I am not even mad');
    assert.ok(!t.includes(':pepe:'));
    assert.ok(!t.includes('已編輯'));
  });

  // 6. V3c：後加 3 則 3 秒內翻出；編輯一則 → 譯文更新且請求 +1。
  await step('6. V3c 後加 3 則 → 3 秒內出現譯文', async () => {
    await page.evaluate(() => {
      window.__fixture.addMessage(31, 'first extra message about the upcoming raffle');
      window.__fixture.addMessage(32, 'second extra message about wallet security tips');
      window.__fixture.addMessage(33, 'third extra message about the weekly community call');
    });
    await page.waitForFunction((n) => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length === n, 23, { timeout: 3000 });
    assert.strictEqual(await translationOf(page, 32), '【譯】second extra message about wallet security tips');
  });

  await step('6b. V3c 編輯一則 → 譯文更新且 translate 請求 +1', async () => {
    const before = await api.count();
    await page.evaluate(() => window.__fixture.editMessage(31, 'edited text about the raffle results being announced'));
    await waitUntil(async () => (await translationOf(page, 31)) === '【譯】edited text about the raffle results being announced', 6000);
    assert.strictEqual(await api.count(), before + 1, '編輯後請求數 +1');
  });

  // 7. 切頻道：整個 <ol> 被替換 → 新列表續翻。
  await step('7. 切頻道（replaceList）→ 新列表被翻', async () => {
    await page.evaluate(() => window.__fixture.replaceList([
      'welcome to the second channel of this server',
      'the roadmap thread has moved over here now',
      'please keep alpha talk inside this channel',
      'mods will pin the summary later tonight',
      'ping me if the invite link stops working',
    ]));
    await page.waitForFunction((n) => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length === n, 5, { timeout: 6000 });
    const first = await page.evaluate(() => {
      const el = document.querySelector('#chat-messages-1-900 .contents > [id^="message-content-"]');
      return el.nextElementSibling.textContent;
    });
    assert.strictEqual(first, '【譯】welcome to the second channel of this server');
  });

  // 8. V3d：關開關移除全部譯文；再開由快取回復且請求數不變。
  await step('8. V3d 關開關 → 無譯文；再開 → 由快取回復且請求數不變', async () => {
    await popup.reload();
    await popupReady(popup);
    await popup.click('#enabledSwitch');
    assert.strictEqual(await popup.$eval('#enabled', (n) => n.checked), false);
    await page.waitForFunction(() => document.querySelectorAll('.dt-translation').length === 0, null, { timeout: 6000 });
    const before = await api.count();
    await popup.click('#enabledSwitch');
    assert.strictEqual(await popup.$eval('#enabled', (n) => n.checked), true);
    await page.waitForFunction((n) => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length === n, 5, { timeout: 6000 });
    assert.strictEqual(await api.count(), before, '由快取回復，未新增請求');
  });

  // 9. V3e：測試金鑰／查看用量。
  await step('9. V3e popup 測試金鑰 → 顯示 12,345 / 500,000', async () => {
    await popup.click('#checkUsage');
    await popup.waitForFunction(() => document.getElementById('usageText').textContent.includes('12,345 / 500,000'), null, { timeout: 6000 });
    const text = await popup.$eval('#usageText', (n) => n.textContent);
    assert.strictEqual(text, '本期已用 12,345 / 500,000 字元（2.5%）');
    assert.strictEqual(await popup.$eval('#statusText', (n) => n.textContent), '已儲存 · 正常');
  });

  // 11.（提前）截圖 popup 正常狀態供 V4 評分。
  await step('11. 截圖 popup 至 tests/e2e/out/popup.png', async () => {
    const h = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await popup.setViewportSize({ width: 340, height: h });
    await popup.screenshot({ path: path.join(OUT_DIR, 'popup.png') });
    assert.ok(fs.statSync(path.join(OUT_DIR, 'popup.png')).size > 1000);
  });

  // 10. V3f：403 → 徽章與狀態；456 → 停送。
  await step('10a. V3f mock 403 → popup 狀態含 403、徽章為「!」', async () => {
    await api.setMode(403);
    const before = await api.count();
    await page.evaluate(() => window.__fixture.addMessage(41, 'a brand new english line that was never translated before'));
    await waitUntil(async () => (await api.count()) === before + 1, 8000);
    await popup.reload();
    await popupReady(popup);
    await popup.waitForFunction(() => document.getElementById('statusText').textContent.includes('403'), null, { timeout: 6000 });
    assert.strictEqual(await popup.evaluate(() => chrome.action.getBadgeText({})), '!');
    assert.strictEqual(await translationOf(page, 41), null, '失敗時不留下待翻佔位');
  });

  await step('10b. V3f mock 456 → 狀態含 456 且後續不再送出請求', async () => {
    await api.setMode(456);
    const before = await api.count();
    await page.evaluate(() => window.__fixture.addMessage(42, 'another unique english line used for the quota test'));
    await waitUntil(async () => (await api.count()) === before + 1, 8000);
    await popup.reload();
    await popupReady(popup);
    await popup.waitForFunction(() => document.getElementById('statusText').textContent.includes('456'), null, { timeout: 6000 });
    assert.strictEqual(await popup.evaluate(() => chrome.action.getBadgeText({})), '!');
    const afterQuota = await api.count();
    await page.evaluate(() => window.__fixture.addMessage(43, 'a third unique english line that must never be sent'));
    await sleep(2500);
    assert.strictEqual(await api.count(), afterQuota, '456 後停止送出 DeepL 請求');
  });

  await step('10c. 清除錯誤 → 徽章與狀態回復正常', async () => {
    await api.setMode(200);
    await popup.click('#clearError');
    await popup.waitForFunction(() => document.getElementById('statusText').textContent === '已儲存 · 正常', null, { timeout: 6000 });
    assert.strictEqual(await popup.evaluate(() => chrome.action.getBadgeText({})), '');
  });

  // 12. 回歸：popup 一開啟就打字，不得被稍後回來的 storage 舊值覆蓋，且儲存鍵要啟用。
  //     此競態在 GitHub Actions 的慢速環境重現過（儲存鍵一直是 disabled 導致整輪 E2E 失敗）。
  await step('12. popup 開啟瞬間輸入不被舊設定覆蓋（不等 dtReady 就輸入）', async () => {
    await popup.goto(popupUrl);
    await popup.fill('#apiKey', 'typed-before-ready:fx');
    await popupReady(popup);
    assert.strictEqual(
      await popup.$eval('#apiKey', (n) => n.value),
      'typed-before-ready:fx',
      '載入完成後不得覆蓋使用者已輸入的金鑰',
    );
    assert.strictEqual(await popup.$eval('#save', (n) => n.disabled), false, '輸入後儲存鍵應啟用');
    await popup.fill('#apiKey', 'test-key:fx');
    await popup.click('#save');
  });

  // 10d. 回歸（審查 finding）：硬錯誤後失敗的訊息，清除錯誤即自動重譯，不需捲動或編輯。
  await step('10d. 清除錯誤後，先前失敗的 3 則自動重譯且只多 1 個請求', async () => {
    const before = await api.count();
    await waitUntil(async () => (await translationOf(page, 41)) === '【譯】a brand new english line that was never translated before', 8000);
    await waitUntil(async () => (await translationOf(page, 42)) === '【譯】another unique english line used for the quota test', 4000);
    await waitUntil(async () => (await translationOf(page, 43)) === '【譯】a third unique english line that must never be sent', 4000);
    assert.ok((await api.count()) - before <= 1, '三則合成一批重送');
  });

  // 10e. 回歸（審查 finding）：單則超過 100KB 不送 DeepL、不留佔位。
  await step('10e. 單則 110KB 訊息不送出、不留佔位', async () => {
    const before = await api.count();
    await page.evaluate(() => window.__fixture.addMessage(44, 'x'.repeat(110 * 1024)));
    await sleep(1500);
    assert.strictEqual(await translationOf(page, 44), null, '過大訊息不留節點');
    assert.strictEqual(await api.count(), before, '過大訊息未產生請求');
  });

  // 10f. 回歸（審查 finding）：聊天列表之外的 message-content（搜尋結果、浮層）不掃、不翻。
  await step('10f. 列表之外的 message-content 不翻譯', async () => {
    const before = await api.count();
    await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.id = 'side-panel';
      panel.innerHTML = '<div id="message-content-777" class="messageContent">an english line living outside the chat list</div>';
      document.body.appendChild(panel);
    });
    await sleep(1500);
    const outside = await page.evaluate(() => {
      const el = document.getElementById('message-content-777');
      const next = el && el.nextElementSibling;
      return next && next.classList.contains('dt-translation') ? next.textContent : null;
    });
    assert.strictEqual(outside, null, '列表外節點不得有譯文');
    assert.strictEqual(await api.count(), before, '列表外節點未產生請求');
  });
}

main()
  .catch((err) => {
    results.push({ name: '未預期例外：' + String((err && err.message) || err), ok: false });
    console.log('  FAIL  未預期例外');
    console.log(String((err && err.stack) || err));
  })
  .finally(async () => {
    if (context) await context.close().catch(() => {});
    if (mock) await mock.close().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log('\nE2E 結果：pass ' + pass + ' / fail ' + fail + ' / total ' + results.length);
    process.exit(fail === 0 && pass > 0 ? 0 : 1);
  });

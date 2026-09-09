// lib/shared.js 純函式單元測試（PLAN V2 清單）。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const DT = require(path.join(__dirname, '..', '..', 'extension', 'lib', 'shared.js'));
const { parseHTML } = require('./dom-stub.js');

test('resolveBase：:fx 金鑰走 api-free', () => {
  assert.strictEqual(DT.resolveBase('abc-123:fx', 'auto', ''), 'https://api-free.deepl.com');
  assert.strictEqual(DT.isFreeKey('abc-123:fx'), true);
});

test('resolveBase：無 :fx 後綴走 api', () => {
  assert.strictEqual(DT.resolveBase('abc-123', 'auto', ''), 'https://api.deepl.com');
  assert.strictEqual(DT.isFreeKey('abc-123'), false);
});

test('resolveBase：手動覆寫優先於金鑰判定', () => {
  assert.strictEqual(DT.resolveBase('abc-123:fx', 'pro', ''), 'https://api.deepl.com');
  assert.strictEqual(DT.resolveBase('abc-123', 'free', ''), 'https://api-free.deepl.com');
});

test('resolveBase：apiBase 僅接受本機位址（測試專用）', () => {
  assert.strictEqual(DT.resolveBase('k:fx', 'auto', 'http://127.0.0.1:8123'), 'http://127.0.0.1:8123');
  assert.strictEqual(DT.resolveBase('k:fx', 'auto', 'http://localhost:9/'), 'http://localhost:9');
  assert.strictEqual(DT.resolveBase('k:fx', 'auto', 'https://evil.example.com'), 'https://api-free.deepl.com');
});

test('shouldTranslate 8 案', () => {
  assert.strictEqual(DT.shouldTranslate('gm everyone, wen mint?'), true, '英文句 → 翻');
  assert.strictEqual(DT.shouldTranslate('今天天氣很好'), false, '純中文 → 不翻');
  assert.strictEqual(DT.shouldTranslate('これは日本語の文です'), true, '中日混合含假名 → 翻');
  assert.strictEqual(DT.shouldTranslate('🤣🔥🚀'), false, '純 emoji → 不翻');
  assert.strictEqual(DT.shouldTranslate('https://example.com/collection/demo'), false, '純 URL → 不翻');
  assert.strictEqual(DT.shouldTranslate('@alice @general'), false, '純提及 → 不翻');
  // §A.4 規定：去雜訊後字母數 >= 2 即送出；lol 為 3 字母 → 翻（省額度靠視窗門控與快取，不靠短詞黑名單）。
  assert.strictEqual(DT.shouldTranslate('lol'), true, 'lol → 翻');
  assert.strictEqual(DT.shouldTranslate(''), false, '空字串 → 不翻');
});

test('shouldTranslate：單字母與純數字不送', () => {
  assert.strictEqual(DT.shouldTranslate('a'), false);
  assert.strictEqual(DT.shouldTranslate('2026 !!!'), false);
  assert.strictEqual(DT.shouldTranslate(':pepe: 🤣'), false);
});

test('stripNoise：移除 URL／提及／emoji 碼／標點', () => {
  assert.strictEqual(DT.stripNoise('hey @alice check https://example.com/a :pepe: 🚀!'), 'hey check');
});

test('applyTaiwanTerms：陸用語轉台灣用語，長詞優先', () => {
  assert.strictEqual(
    DT.applyTaiwanTerms('這個軟件的網絡信息視頻質量很好'),
    '這個軟體的網路資訊影片品質很好',
  );
  assert.strictEqual(DT.applyTaiwanTerms('數據庫和服務器'), '資料庫和伺服器');
  assert.strictEqual(DT.applyTaiwanTerms('文件夾裡的默認用戶'), '資料夾裡的預設使用者');
});

test('applyTaiwanTerms：歧義詞（程序／通過／註冊）v1 保守不動', () => {
  assert.strictEqual(DT.applyTaiwanTerms('通過審核的程序已註冊'), '通過審核的程序已註冊');
});

test('applyTaiwanTerms：可傳入自訂表', () => {
  assert.strictEqual(DT.applyTaiwanTerms('土豆', [['土豆', '馬鈴薯']]), '馬鈴薯');
});

test('chunkBatches：51 則 → 2 批', () => {
  const items = Array.from({ length: 51 }, (_, i) => ({ id: String(i), text: 'hello world ' + i }));
  const batches = DT.chunkBatches(items, 50, 100 * 1024);
  assert.strictEqual(batches.length, 2);
  assert.strictEqual(batches[0].length, 50);
  assert.strictEqual(batches[1].length, 1);
});

test('chunkBatches：單則 60KB × 3 → 2 批（上限 128KiB＝DeepL 單請求上限）', () => {
  const items = Array.from({ length: 3 }, (_, i) => ({ id: String(i), text: 'a'.repeat(60 * 1024) }));
  const batches = DT.chunkBatches(items, 50, 128 * 1024);
  assert.strictEqual(batches.length, 2);
  assert.strictEqual(batches[0].length, 2);
  assert.strictEqual(batches[1].length, 1);
});

test('chunkBatches：content 端 100KB 上限下同一輸入切 3 批；單則超限自成一批並標 tooLarge', () => {
  const items = Array.from({ length: 3 }, (_, i) => ({ id: String(i), text: 'a'.repeat(60 * 1024) }));
  assert.strictEqual(DT.chunkBatches(items, 50, 100 * 1024).length, 3);
  const huge = DT.chunkBatches([{ id: 'x', text: 'b'.repeat(200 * 1024) }], 50, 100 * 1024);
  assert.strictEqual(huge.length, 1);
  assert.strictEqual(huge[0][0].tooLarge, true);
});

test('hashText：同輸入穩定、不同輸入相異、為 8 碼 hex', () => {
  const a = DT.hashText('gm everyone');
  assert.strictEqual(a, DT.hashText('gm everyone'));
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notStrictEqual(a, DT.hashText('gm everyone!'));
  assert.strictEqual(DT.hashText('今天天氣很好'), DT.hashText('今天天氣很好'));
});

test('extractText：保留 unicode emoji alt、移除自訂 emoji 與「已編輯」', () => {
  const el = parseHTML(
    '<div id="message-content-1" class="markup messageContent">' +
    'gm <span class="mention">@alice</span> ' +
    '<img class="emoji" data-type="emoji" data-name=":rofl:" alt="🤣" src="/assets/a.svg">' +
    '<img class="emoji" data-name=":pepe:" alt=":pepe:" src="https://cdn.discordapp.com/emojis/1.png">' +
    ' wen mint<span class="edited_abc"> （已編輯）</span></div>',
  );
  const text = DT.extractText(el);
  assert.strictEqual(text, 'gm @alice 🤣 wen mint');
  assert.ok(!text.includes(':pepe:'));
  assert.ok(!text.includes('已編輯'));
});

test('extractText：純「已編輯」標記元素整個剔除（含 time 與括號分隔）', () => {
  const el = parseHTML('<div id="message-content-1" class="markup_x messageContent_x"><span>It will</span><span class="edited_c19a55"><span class="timestamp_x"><time><i>[</i>(已編輯)<i>]</i></time></span></span></div>');
  assert.strictEqual(DT.extractText(el), 'It will');
});

test('extractText：class 含 edited 的元素若包住正文，正文保留、標記剔除（回歸：已編輯訊息不翻）', () => {
  const el = parseHTML('<div id="message-content-2" class="markup_x messageContent_x"><span class="edited_c19a55">Stoked for the reveal as well <time>(已編輯)</time></span></div>');
  assert.strictEqual(DT.extractText(el), 'Stoked for the reveal as well');
  assert.strictEqual(DT.shouldTranslate(DT.extractText(el)), true);
});

test('extractText：真實 Discord 已編輯結構（time 內標記＋隱藏日期）只留正文（回歸 2026-09-10）', () => {
  const html = '<div id="message-content-100000000000000001" class="markup__75297 messageContent_c19a55"><span>I shared this link earlier today</span> <span class="timestamp_c19a55"><span><time datetime="2026-01-02T03:04:05.000Z"><span class="edited_c19a55">(已編輯)</span></time></span><span id="sr-date-1" class="hiddenVisually_b18fe2">2026年1月2日 星期五 上午11:04</span></span></div>';
  const el = parseHTML(html);
  assert.strictEqual(DT.extractText(el), 'I shared this link earlier today');
});

test('extractText：br 換行、連續空白折疊、前後 trim', () => {
  const el = parseHTML('<div id="message-content-2">  line   one <br>  line two  </div>');
  assert.strictEqual(DT.extractText(el), 'line one\nline two');
});

test('extractText：非元素輸入回傳空字串', () => {
  assert.strictEqual(DT.extractText(null), '');
  assert.strictEqual(DT.extractText(undefined), '');
});

test('mapDeepLError：狀態碼對映', () => {
  assert.strictEqual(DT.mapDeepLError(403), 'AUTH');
  assert.strictEqual(DT.mapDeepLError(456), 'QUOTA');
  assert.strictEqual(DT.mapDeepLError(429), 'RATE');
  assert.strictEqual(DT.mapDeepLError(413), 'TOO_LARGE');
  assert.strictEqual(DT.mapDeepLError(500), 'SERVER');
  assert.strictEqual(DT.mapDeepLError(503), 'SERVER');
  assert.strictEqual(DT.mapDeepLError(418), 'HTTP_418');
});

test('formatUsage：千分位與百分比', () => {
  assert.strictEqual(DT.formatUsage(12345, 500000), '本期已用 12,345 / 500,000 字元（2.5%）');
  assert.strictEqual(DT.formatUsage(0, 500000), '本期已用 0 / 500,000 字元（0.0%）');
  assert.strictEqual(DT.formatUsage(450000, 500000), '本期已用 450,000 / 500,000 字元（90.0%）');
  assert.strictEqual(DT.formatUsage(100, 0), '本期已用 100 字元');
});

test('DEFAULTS：目標語言預設 ZH-HANT、不含已填金鑰', () => {
  assert.strictEqual(DT.DEFAULTS.targetLang, 'ZH-HANT');
  assert.strictEqual(DT.DEFAULTS.apiKey, '');
  assert.strictEqual(DT.DEFAULTS.enabled, true);
  assert.ok(DT.TAIWAN_TERMS.length >= 20, '台灣用語表至少 20 條');
});

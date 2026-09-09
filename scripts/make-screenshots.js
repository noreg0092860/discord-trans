// 產生 README 用的截圖：以 Playwright 實際載入擴充元件，在隨附的 Discord 仿真頁上跑一次翻譯後截圖。
// 譯文來自本檔內建的示範對照表（不呼叫真實 DeepL、不需要金鑰），畫面則是擴充元件真正渲染的結果。
// 用法：node scripts/make-screenshots.js
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildTestExt } = require('../tests/e2e/build-test-ext.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures');

// 示範譯文：貼近 DeepL 的繁中輸出，讓截圖看得出實際效果。
const DEMO = new Map(Object.entries({
  'gm everyone, hope you are having a great week': '早安各位，希望大家這週過得順利',
  'the mint goes live in about two hours': '鑄造大約兩小時後開始',
  'did anyone get the whitelist spot yesterday': '昨天有人拿到白名單資格嗎',
  'floor price is holding steady around 0.4 today': '今天地板價穩定維持在 0.4 左右',
  'team just posted the roadmap update in announcements': '團隊剛在公告頻道發布了路線圖更新',
  'I am staking mine until the next snapshot': '我會質押到下一次快照為止',
  'welcome to all the new collectors joining today': '歡迎今天加入的所有新藏家',
  'the art direction on this collection is unreal': '這個系列的美術風格真的太強了',
  'gas is finally cheap enough to move some pieces': 'gas 費終於便宜到可以搬一些作品了',
  'reminder that the AMA starts at nine tonight': '提醒一下，AMA 今晚九點開始',
  'somebody explain the reveal mechanics to me please': '有人可以解釋一下揭曉機制嗎',
  'just listed two of mine at slightly below floor': '我剛把兩個掛在略低於地板價的價位',
  'the discord bot keeps eating my verification message': 'Discord 機器人一直吃掉我的驗證訊息',
  'congrats to whoever pulled the rare background': '恭喜抽到稀有背景的人',
  'second wave of the drop is scheduled for friday': '第二波空投預計在週五',
  'does the royalty split apply on secondary sales': '版稅拆分適用於二級市場交易嗎',
  'thanks for the quick answer earlier, much appreciated': '謝謝你剛才這麼快回覆，非常感謝',
  'this reveal is wild 🤣 and I am not even mad': '這次揭曉太瘋狂了 🤣 而且我一點也不生氣',
  '@alice the listing is here https://example.com/collection/demo take a look': '@alice 掛單在這裡，來看看吧',
  'yes I grabbed one right before it closed': '對，我在關閉前剛好搶到一個',
}));

function startDemoApi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/v2/usage') return json({ character_count: 128450, character_limit: 500000 });
    if (url.pathname !== '/v2/translate') {
      res.writeHead(404);
      return res.end();
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let texts = [];
      try { texts = JSON.parse(body).text || []; } catch { texts = []; }
      json({
        translations: texts.map((t) => ({
          detected_source_language: 'EN',
          text: DEMO.get(t) || t,
        })),
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((d) => server.close(d)) });
    });
  });
}

function startStatic(dir) {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, name || 'index.html');
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((d) => server.close(d)) });
    });
  });
}

// 仿真頁只保留翻譯所需的結構；截圖時補上頭像與頻道列，讓畫面接近 Discord 實際觀感。
const DRESS_UP = `
  body { background: #313338; }
  .chat { padding: 12px 16px 16px; max-width: 900px; }
  .chat-header {
    display: flex; align-items: center; gap: 8px;
    height: 48px; margin: -12px -16px 12px; padding: 0 16px;
    background: #313338; box-shadow: 0 1px 0 rgba(0,0,0,.2); color: #f2f3f5; font-weight: 600;
  }
  .chat-header .hash { color: #80848e; font-size: 20px; }
  .messageListItem { position: relative; padding: 6px 0 6px 56px; min-height: 24px; }
  .messageListItem:hover { background: #2e3035; }
  .messageListItem > .message > .contents > .header + .messageContent,
  .messageListItem .messageContent { font-size: 15px; line-height: 21px; }
  .header { display: block; margin-bottom: 1px; }
  .username { font-size: 15px; }
  .timestamp { margin-left: 6px; }
  .avatar {
    position: absolute; left: 8px; top: 6px; width: 40px; height: 40px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 15px;
  }
  .repliedMessage { margin-bottom: 2px; }
`;

const AVATAR_COLORS = { alice: '#5865f2', bob: '#3ba55c', carol: '#e67e22', dave: '#eb459e', erin: '#9b59b6' };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const extPath = buildTestExt();
  const api = await startDemoApi();
  const fixture = await startStatic(FIXTURE_DIR);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = sw.url().split('/')[2];

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 700 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.fill('#apiKey', 'demo-key-not-a-real-key:fx');
    await popup.selectOption('#targetLang', 'ZH-HANT');
    await popup.click('#save');
    await popup.evaluate((base) => chrome.storage.local.set({ apiBase: base }), api.url);

    const page = await context.newPage();
    await page.goto(fixture.url + '/discord-like.html');
    await page.addStyleTag({ content: DRESS_UP });
    await page.evaluate((colors) => {
      const header = document.createElement('div');
      header.className = 'chat-header';
      header.innerHTML = '<span class="hash">#</span><span>general-chat</span>';
      document.querySelector('.chat').prepend(header);
      for (const li of document.querySelectorAll('.messageListItem')) {
        const name = li.querySelector('.username');
        if (!name) continue;
        const who = name.textContent.trim();
        const av = document.createElement('div');
        av.className = 'avatar';
        av.style.background = colors[who] || '#4f545c';
        av.textContent = who.slice(0, 1).toUpperCase();
        li.prepend(av);
      }
    }, AVATAR_COLORS);

    // 擴充元件只翻進入視窗的訊息，先緩慢捲過整頁（等同實際使用），再回到頂端。
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.6);
      for (let y = 0; y <= document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 350));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(
      () => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length >= 20,
      null,
      { timeout: 30000 },
    ).catch(async () => {
      const n = await page.evaluate(() => document.querySelectorAll('.dt-translation[data-dt-state="done"]').length);
      throw new Error('譯文只完成 ' + n + ' 則（期望 ≥ 20）');
    });
    // 仿真頁的 emoji 圖檔是佔位路徑，截圖時改以文字呈現（自訂 emoji 依規則本就不入譯文）。
    await page.evaluate(() => {
      for (const img of document.querySelectorAll('img.emoji')) {
        const alt = img.getAttribute('alt') || '';
        const span = document.createElement('span');
        span.textContent = /^:[\w~+-]+:$/.test(alt) ? '' : alt;
        span.style.fontSize = '18px';
        img.replaceWith(span);
      }
    });
    await page.waitForTimeout(800);

    // 1) 聊天區：一般訊息連續翻譯的樣子。
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(OUT_DIR, 'chat.png'), clip: { x: 0, y: 0, width: 900, height: 560 } });

    // 2) 跳過規則與已編輯訊息：捲到頁尾，該區含「(已編輯)」、純中文、純 emoji、純網址、純提及。
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, 'skip-rules.png'), clip: { x: 0, y: 100, width: 900, height: 700 } });

    // 3) popup：設定畫面（金鑰欄為遮罩狀態）。
    await popup.click('#checkUsage');
    await popup.waitForFunction(
      () => document.getElementById('usageText').textContent.includes('/'),
      null,
      { timeout: 10000 },
    );
    const h = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await popup.setViewportSize({ width: 340, height: h });
    await popup.screenshot({ path: path.join(OUT_DIR, 'popup.png') });

    for (const f of ['chat.png', 'skip-rules.png', 'popup.png']) {
      const size = fs.statSync(path.join(OUT_DIR, f)).size;
      console.log('  ' + f + '  ' + Math.round(size / 1024) + ' KB');
    }
    console.log('截圖完成：' + OUT_DIR);
  } finally {
    await context.close().catch(() => {});
    await api.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exit(1);
});

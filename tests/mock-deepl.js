// 假 DeepL 伺服器：/v2/translate、/v2/usage，外加 __mode / __requests / __reset 控制端點。
const http = require('node:http');

function detect(text) {
  const hasHan = /\p{Script=Han}/u.test(text);
  const hasLatin = /\p{Script=Latin}/u.test(text);
  return hasHan && !hasLatin ? 'ZH' : 'EN';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function startMockDeepL() {
  const state = { status: 200, translateRequests: [], usageRequests: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, payload) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end(body);
    };

    if (req.method === 'OPTIONS') return send(204, '');

    if (url.pathname === '/__mode' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.status = Number(body.status) || 200;
      return send(200, { ok: true, status: state.status });
    }
    if (url.pathname === '/__requests' && req.method === 'GET') {
      return send(200, {
        count: state.translateRequests.length,
        usage: state.usageRequests,
        requests: state.translateRequests,
      });
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      state.status = 200;
      state.translateRequests = [];
      state.usageRequests = 0;
      return send(200, { ok: true });
    }

    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('DeepL-Auth-Key ')) return send(401, { message: 'missing auth' });

    if (url.pathname === '/v2/translate' && req.method === 'POST') {
      const raw = await readBody(req);
      let texts = [];
      try { texts = JSON.parse(raw).text || []; } catch { texts = []; }
      state.translateRequests.push({ n: texts.length, texts, at: Date.now() });
      if (state.status !== 200) return send(state.status, { message: 'mock error ' + state.status });
      return send(200, {
        translations: texts.map((t) => ({ detected_source_language: detect(t), text: '【譯】' + t })),
      });
    }

    if (url.pathname === '/v2/usage' && req.method === 'GET') {
      state.usageRequests += 1;
      if (state.status !== 200) return send(state.status, { message: 'mock error ' + state.status });
      return send(200, { character_count: 12345, character_limit: 500000 });
    }

    return send(404, { message: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: 'http://127.0.0.1:' + port,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startMockDeepL };

if (require.main === module) {
  startMockDeepL().then((m) => console.error('mock deepl on ' + m.url));
}

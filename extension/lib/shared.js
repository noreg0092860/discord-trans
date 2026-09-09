// 四方共用純函式（content script / background / popup / Node 單元測試）。
const DT = {
  API_FREE: 'https://api-free.deepl.com',
  API_PRO: 'https://api.deepl.com',

  DEFAULTS: {
    enabled: true,
    apiKey: '',
    endpointMode: 'auto',
    targetLang: 'ZH-HANT',
    twFix: true,
    apiBase: '',
  },

  // 台灣用語修正表（長詞優先由 applyTaiwanTerms 自行排序）。
  // 刻意排除的歧義詞：程序（台灣法律語境亦用）、通過（繁中本義為 pass）、註冊（兩岸同形）。
  TAIWAN_TERMS: [
    ['服務器', '伺服器'],
    ['數據庫', '資料庫'],
    ['文件夾', '資料夾'],
    ['軟件', '軟體'],
    ['硬件', '硬體'],
    ['網絡', '網路'],
    ['信息', '資訊'],
    ['視頻', '影片'],
    ['音頻', '音訊'],
    ['屏幕', '螢幕'],
    ['鼠標', '滑鼠'],
    ['默認', '預設'],
    ['用戶', '使用者'],
    ['鏈接', '連結'],
    ['登錄', '登入'],
    ['內存', '記憶體'],
    ['優化', '最佳化'],
    ['質量', '品質'],
    ['支持', '支援'],
    ['項目', '專案'],
    ['社區', '社群'],
    ['渠道', '管道'],
    ['智能', '智慧'],
    ['激活', '啟用'],
    ['打印', '列印'],
    ['光標', '游標'],
    ['發布', '發佈'],
  ],

  isFreeKey(key) {
    return String(key == null ? '' : key).trim().endsWith(':fx');
  },

  // apiBase 僅在指向本機（測試用 mock）時生效，其餘一律忽略。
  isLocalBase(apiBase) {
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(String(apiBase == null ? '' : apiBase).trim());
  },

  resolveBase(key, mode, apiBase) {
    if (DT.isLocalBase(apiBase)) return String(apiBase).trim().replace(/\/+$/, '');
    if (mode === 'free') return DT.API_FREE;
    if (mode === 'pro') return DT.API_PRO;
    return DT.isFreeKey(key) ? DT.API_FREE : DT.API_PRO;
  },

  // FNV-1a 32bit → 8 碼 hex；不用 crypto，content/background/Node 皆可同步呼叫。
  hashText(str) {
    const s = String(str == null ? '' : str);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  },

  byteLength(str) {
    const s = String(str == null ? '' : str);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  },

  // 去除 URL、@提及／#頻道、:emoji: 碼、unicode emoji、標點與空白。
  stripNoise(text) {
    let t = String(text == null ? '' : text);
    t = t.replace(/<a?:[\w~+-]+:\d+>/g, ' ');
    t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
    t = t.replace(/(^|\s)[@#][^\s]+/g, ' ');
    t = t.replace(/:[\w~+-]+:/g, ' ');
    t = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]/gu, ' ');
    t = t.replace(/[\p{P}\p{S}]/gu, ' ');
    return t.replace(/\s+/g, ' ').trim();
  },

  shouldTranslate(text) {
    const t = DT.stripNoise(text);
    const letters = t.match(/\p{L}/gu);
    if (!letters || letters.length < 2) return false;
    const hasHan = /\p{Script=Han}/u.test(t);
    const hasOther = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t);
    if (hasHan && !hasOther) return false;
    return true;
  },

  // items: [{ id, text }] → [[...], [...]]；單則超過 maxBytes 者自成一批並標 tooLarge。
  chunkBatches(items, maxCount, maxBytes) {
    const batches = [];
    let cur = [];
    let bytes = 0;
    for (const item of Array.from(items || [])) {
      const size = DT.byteLength(item && item.text);
      if (size > maxBytes) {
        if (cur.length) { batches.push(cur); cur = []; bytes = 0; }
        batches.push([Object.assign({}, item, { tooLarge: true })]);
        continue;
      }
      if (cur.length >= maxCount || (cur.length && bytes + size > maxBytes)) {
        batches.push(cur); cur = []; bytes = 0;
      }
      cur.push(item);
      bytes += size;
    }
    if (cur.length) batches.push(cur);
    return batches;
  },

  applyTaiwanTerms(text, table) {
    const pairs = Array.from(table || DT.TAIWAN_TERMS).sort((a, b) => b[0].length - a[0].length);
    let out = String(text == null ? '' : text);
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
  },

  // 走訪 DOM 取內文；不改動原節點，只需 nodeType / tagName / getAttribute / childNodes / nodeValue。
  extractText(el) {
    if (!el || typeof el !== 'object') return '';
    const out = [];
    DT._walk(el, out);
    return DT._normalizeText(out.join(''));
  },

  _walk(node, out) {
    if (!node) return;
    if (node.nodeType === 3) { out.push(node.nodeValue || ''); return; }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'TIME') return;
    const cls = node.getAttribute ? String(node.getAttribute('class') || '') : '';
    // 螢幕閱讀器專用的隱藏文字（Discord 在已編輯標記旁放完整日期）不是正文，不取。
    if (DT._HIDDEN_CLASS.test(cls)) return;
    // 只剔除純粹的「已編輯」標記元素／時間戳包裝（實勘：<span class="timestamp_…"><span><time><span class="edited_…">
    // (已編輯)</span></time></span><span class="hiddenVisually_…">日期</span></span>）；
    // 若這類元素同時包住正文（DOM 改版時可能發生），仍走入取字。
    if (/edited|timestamp/i.test(cls) && DT._isEditedMarker(node)) return;
    if (tag === 'IMG') {
      const alt = node.getAttribute ? String(node.getAttribute('alt') || '') : '';
      if (/^:[\w~+-]+:$/.test(alt)) return;
      out.push(alt);
      return;
    }
    if (tag === 'BR') { out.push('\n'); return; }
    const block = DT._BLOCK_TAGS.has(tag);
    if (block) out.push('\n');
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) DT._walk(kids[i], out);
    if (block) out.push('\n');
  },

  _EDITED_MARK: /^[\[\(（]?\s*(edited|已編輯|已编辑|編集済み|수정됨)\s*[\]\)）]?$/i,

  // 純標記判定：元素文字（不含 <time>）為空或只剩「(已編輯)」字樣 → 純標記，可整個剔除。
  _isEditedMarker(node) {
    const rest = DT._plainText(node, true).replace(/\s+/g, ' ').trim();
    return !rest || DT._EDITED_MARK.test(rest);
  },

  _HIDDEN_CLASS: /hiddenVisually|visuallyHidden|srOnly|sr-only|screenReader/i,

  _plainText(node, skipTime) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.nodeValue || '');
    if (node.nodeType !== 1) return '';
    if (skipTime && String(node.tagName || '').toUpperCase() === 'TIME') return '';
    if (node.getAttribute && DT._HIDDEN_CLASS.test(String(node.getAttribute('class') || ''))) return '';
    let acc = '';
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) acc += DT._plainText(kids[i], skipTime);
    return acc;
  },

  _BLOCK_TAGS: new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR']),

  _normalizeText(str) {
    return String(str == null ? '' : str)
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  mapDeepLError(status) {
    const n = Number(status);
    if (n === 403) return 'AUTH';
    if (n === 456) return 'QUOTA';
    if (n === 429) return 'RATE';
    if (n === 413) return 'TOO_LARGE';
    if (n >= 500) return 'SERVER';
    return 'HTTP_' + n;
  },

  formatUsage(count, limit) {
    const c = Number(count) || 0;
    const l = Number(limit) || 0;
    if (l <= 0) return '本期已用 ' + DT._group(c) + ' 字元';
    const pct = (c / l) * 100;
    return '本期已用 ' + DT._group(c) + ' / ' + DT._group(l) + ' 字元（' + pct.toFixed(1) + '%）';
  },

  _group(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = DT;

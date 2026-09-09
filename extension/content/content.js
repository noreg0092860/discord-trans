// content script：觀察 Discord 聊天區、抓內文、把譯文插在原文下方；不直接連網。
const SELECTORS = {
  list: '[data-list-id="chat-messages"]',
  messageItem: 'li[id^="chat-messages-"]',
  messageContent: '[id^="message-content-"]',
  messageContentFallback: '[class*="messageContent"]',
  replyContext: '[id^="message-reply-context-"]',
  accessories: '[id^="message-accessories-"]',
  translation: '.dt-translation',
};

const FLUSH_DELAY = 300;
const DIRTY_DELAY = 500;
const MAX_PER_BATCH = 50;
const MAX_BATCH_BYTES = 100 * 1024;
const ROOT_MARGIN = '200px 0px';
const CACHE_LIMIT = 2000;
const RETRY_DELAY = 5000;
const MAX_RETRIES = 2;
// 這些錯誤不會因重試而好轉；等金鑰更正或錯誤清除（storage 變更）後再整批重試。
const HARD_ERRORS = new Set(['NO_KEY', 'AUTH', 'QUOTA', 'TOO_LARGE']);

// content 端只讀所需設定，金鑰／端點一律留在 background。
const CONTENT_DEFAULTS = { enabled: DT.DEFAULTS.enabled, targetLang: DT.DEFAULTS.targetLang };

let settings = Object.assign({}, CONTENT_DEFAULTS);
const cache = new Map();
const queue = new Map();
const tracked = new Set();
const dirty = new Set();
const failed = new Set();
let io = null;
let mo = null;
let flushTimer = null;
let dirtyTimer = null;
let inFlight = false;
let seq = 0;
let lastError = null;
// R1 備援：id 前綴整批失效時改用 class 子字串比對，直到下次 rescan 重新判定。
let contentSelector = SELECTORS.messageContent;

init();

function init() {
  chrome.storage.local.get(CONTENT_DEFAULTS).then((stored) => {
    settings = Object.assign({}, CONTENT_DEFAULTS, stored);
    io = new IntersectionObserver(onIntersect, { rootMargin: ROOT_MARGIN });
    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (settings.enabled) rescan();
  });
  chrome.storage.onChanged.addListener(onSettingsChanged);
  window.__DT_DEBUG = debugSnapshot;
}

function debugSnapshot() {
  return {
    tracked: tracked.size,
    queued: queue.size,
    cached: cache.size,
    failed: failed.size,
    rendered: document.querySelectorAll(SELECTORS.translation).length,
    lastError,
    settings: { enabled: settings.enabled, targetLang: settings.targetLang },
  };
}

function rescan() {
  pruneDetached();
  let nodes = document.querySelectorAll(SELECTORS.messageContent);
  if (nodes.length) {
    contentSelector = SELECTORS.messageContent;
  } else {
    const fallback = document.querySelectorAll(SELECTORS.messageContentFallback);
    if (fallback.length) { contentSelector = SELECTORS.messageContentFallback; nodes = fallback; }
  }
  nodes.forEach(track);
}

// 切頻道會整批換掉列表，已脫離文件的元素要放掉，避免長時間常駐累積。
function pruneDetached() {
  for (const el of tracked) {
    if (el.isConnected) continue;
    io.unobserve(el);
    tracked.delete(el);
    failed.delete(el);
  }
}

function cachePut(key, text) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, text);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function track(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.closest(SELECTORS.replyContext)) return;
  if (el.closest(SELECTORS.accessories)) return;
  if (el.dataset.dtTracked) return;
  el.dataset.dtTracked = '1';
  el.dataset.dtId = String(++seq);
  tracked.add(el);
  io.observe(el);
}

function untrackAll() {
  for (const el of tracked) {
    io.unobserve(el);
    delete el.dataset.dtTracked;
    delete el.dataset.dtId;
    delete el.dataset.dtKey;
    delete el.dataset.dtRetries;
  }
  tracked.clear();
  failed.clear();
}

function onIntersect(entries) {
  if (!settings.enabled) return;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    io.unobserve(entry.target);
    enqueue(entry.target);
  }
}

function enqueue(el) {
  if (!settings.enabled || !el.isConnected) return;
  const text = DT.extractText(el);
  if (!DT.shouldTranslate(text)) { removeTranslation(el); return; }
  const key = DT.hashText(text) + '|' + settings.targetLang;
  el.dataset.dtKey = key;
  if (cache.has(key)) { render(el, cache.get(key)); return; }
  renderPending(el);
  queue.set(el.dataset.dtId, { id: el.dataset.dtId, el, text, key });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DELAY);
}

async function flush() {
  if (inFlight || !settings.enabled || queue.size === 0) return;
  const batch = DT.chunkBatches(queue.values(), MAX_PER_BATCH, MAX_BATCH_BYTES)[0];
  if (!batch || !batch.length) return;
  for (const item of batch) queue.delete(item.id);
  // 單則超過上限者不送（DeepL 只會回 413），直接放棄該則。
  const sendable = [];
  for (const item of batch) {
    if (item.tooLarge) removeTranslation(item.el); else sendable.push(item);
  }
  if (!sendable.length) { if (queue.size) scheduleFlush(); return; }
  inFlight = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'translate',
      items: sendable.map((item) => ({ id: item.id, text: item.text })),
      targetLang: settings.targetLang,
    });
    if (resp && resp.ok) {
      lastError = null;
      const byId = new Map((resp.results || []).map((r) => [String(r.id), r]));
      for (const item of sendable) {
        failed.delete(item.el);
        delete item.el.dataset.dtRetries;
        const result = byId.get(String(item.id));
        if (!result || result.skipped || !result.text) { removeTranslation(item.el); continue; }
        cachePut(item.key, result.text);
        render(item.el, result.text);
      }
    } else {
      lastError = (resp && resp.error) || { code: 'UNKNOWN' };
      failBatch(sendable, lastError);
    }
  } catch (err) {
    lastError = { code: 'NETWORK', message: String((err && err.message) || err) };
    failBatch(sendable, lastError);
  } finally {
    inFlight = false;
    if (queue.size) scheduleFlush();
  }
}

// 失敗的一批：撤掉佔位並記入 failed。暫時性錯誤延遲後重新交給 IO（入視窗才重試，
// 最多 MAX_RETRIES 次）；硬錯誤留在 failed 等 retryFailed()。
function failBatch(items, error) {
  for (const item of items) { removeTranslation(item.el); failed.add(item.el); }
  if (error && HARD_ERRORS.has(error.code)) return;
  setTimeout(() => {
    for (const item of items) {
      const el = item.el;
      if (!settings.enabled || !el.isConnected || !el.dataset.dtTracked) continue;
      const n = Number(el.dataset.dtRetries || 0);
      if (n >= MAX_RETRIES) continue;
      el.dataset.dtRetries = String(n + 1);
      io.observe(el);
    }
  }, RETRY_DELAY);
}

// 金鑰更正、錯誤清除或額度暫停解除後：曾失敗的元素重新交給 IO，入視窗即重試。
function retryFailed() {
  if (!settings.enabled || !io) return;
  const items = Array.from(failed);
  failed.clear();
  for (const el of items) {
    if (!el.isConnected || !el.dataset.dtTracked) continue;
    delete el.dataset.dtRetries;
    io.observe(el);
  }
}

function translationNode(el) {
  const next = el.nextElementSibling;
  if (next && next.classList.contains('dt-translation') && next.dataset.dtFor === el.dataset.dtId) return next;
  return null;
}

function ensureNode(el) {
  let node = translationNode(el);
  if (node) return node;
  node = document.createElement('div');
  node.className = 'dt-translation';
  node.dataset.dtFor = el.dataset.dtId || '';
  el.insertAdjacentElement('afterend', node);
  return node;
}

function render(el, translation) {
  const node = ensureNode(el);
  node.textContent = translation;
  node.dataset.dtState = 'done';
}

function renderPending(el) {
  const node = ensureNode(el);
  if (node.dataset.dtState !== 'done') node.textContent = '';
  node.dataset.dtState = 'pending';
}

function removeTranslation(el) {
  const node = translationNode(el);
  if (node) node.remove();
}

function removeAllTranslations() {
  document.querySelectorAll(SELECTORS.translation).forEach((node) => node.remove());
}

function onMutations(mutations) {
  if (!settings.enabled) return;
  // 聊天列表存在時，列表之外的新增節點（側欄、成員列、浮層）一律不掃；
  // 列表不存在（錨點失效的備援情境）才退回全頁掃描。
  const listPresent = Boolean(document.querySelector(SELECTORS.list));
  for (const m of mutations) {
    const host = m.target && m.target.nodeType === 3 ? m.target.parentElement : m.target;
    if (!host || typeof host.closest !== 'function') continue;
    if (host.closest(SELECTORS.translation)) continue;
    if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains('dt-translation')) continue;
        if (!node.closest(SELECTORS.list)) {
          const holdsList = node.matches(SELECTORS.list) || Boolean(node.querySelector(SELECTORS.list));
          if (holdsList) pruneDetached();
          else if (listPresent) continue;
        }
        if (node.matches(contentSelector)) track(node);
        else node.querySelectorAll(contentSelector).forEach(track);
      }
    }
    const mc = host.closest(contentSelector);
    if (mc && mc.dataset.dtTracked) markDirty(mc);
  }
}

function markDirty(el) {
  dirty.add(el);
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    const items = Array.from(dirty);
    dirty.clear();
    for (const el2 of items) {
      if (!el2.isConnected || !el2.dataset.dtTracked) continue;
      enqueue(el2);
    }
  }, DIRTY_DELAY);
}

function onSettingsChanged(changes, area) {
  if (area !== 'local') return;
  if (!io) {
    if (changes.enabled) settings.enabled = Boolean(changes.enabled.newValue);
    if (changes.targetLang) settings.targetLang = changes.targetLang.newValue;
    return;
  }
  if (changes.enabled && Boolean(changes.enabled.newValue) !== settings.enabled) {
    settings.enabled = Boolean(changes.enabled.newValue);
    if (!settings.enabled) {
      queue.clear();
      dirty.clear();
      untrackAll();
      removeAllTranslations();
    } else {
      rescan();
    }
  }
  // 金鑰更正、錯誤清除、額度暫停解除 → 曾失敗的訊息重新排程（不讀金鑰值）。
  if (changes.apiKey ||
      (changes.lastError && changes.lastError.newValue === null) ||
      (changes.pausedQuota && changes.pausedQuota.newValue === false)) {
    retryFailed();
  }
  if (changes.targetLang && changes.targetLang.newValue !== settings.targetLang) {
    settings.targetLang = changes.targetLang.newValue;
    cache.clear();
    queue.clear();
    dirty.clear();
    untrackAll();
    removeAllTranslations();
    if (settings.enabled) rescan();
  }
}

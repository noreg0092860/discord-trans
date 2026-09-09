// service worker：唯一會呼叫 DeepL 的地方；負責金鑰讀取、合批送出、錯誤對映與徽章。
importScripts('lib/shared.js');

const MAX_INFLIGHT = 2;
const CACHE_LIMIT = 1000;
const RETRY_DELAYS = [600, 1800];
const BADGE_COLOR = '#ED4245';

const bgCache = new Map();
let inflight = 0;
const waiters = [];
let pausedQuota = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: { code: 'INTERNAL', message: errMessage(err) } });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.apiKey) {
    pausedQuota = false;
    bgCache.clear();
    clearErrorState();
  }
  if (changes.targetLang) bgCache.clear();
});

function handle(msg) {
  const type = msg && msg.type;
  if (type === 'translate') return translate(msg);
  if (type === 'usage') return usage();
  if (type === 'getStatus') return getStatus();
  if (type === 'clearError') return clearError();
  return Promise.resolve({ ok: false, error: { code: 'BAD_REQUEST' } });
}

function getSettings() {
  return chrome.storage.local.get({
    apiKey: '',
    endpointMode: 'auto',
    targetLang: 'ZH-HANT',
    twFix: true,
    apiBase: '',
    pausedQuota: false,
  });
}

async function translate(msg) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  const s = await getSettings();
  const targetLang = msg.targetLang || s.targetLang || 'ZH-HANT';
  if (!s.apiKey) return { ok: false, error: { code: 'NO_KEY' } };
  if (pausedQuota || s.pausedQuota) {
    pausedQuota = true;
    return { ok: false, error: { code: 'QUOTA', status: 456 } };
  }

  const results = [];
  const pending = [];
  for (const item of items) {
    const cacheKey = DT.hashText(item.text) + '|' + targetLang;
    if (bgCache.has(cacheKey)) {
      results.push(Object.assign({ id: item.id }, bgCache.get(cacheKey)));
    } else {
      pending.push({ item, cacheKey });
    }
  }
  if (!pending.length) return { ok: true, results };

  const base = DT.resolveBase(s.apiKey, s.endpointMode, s.apiBase);
  const body = JSON.stringify({ text: pending.map((p) => p.item.text), target_lang: targetLang });
  const outcome = await withSlot(() => request(base + '/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': 'DeepL-Auth-Key ' + s.apiKey,
      'Content-Type': 'application/json',
    },
    body,
  }));
  if (outcome.error) {
    await noteError(outcome.error);
    return { ok: false, error: outcome.error };
  }

  let data;
  try {
    data = await outcome.res.json();
  } catch (err) {
    const error = { code: 'SERVER', message: errMessage(err) };
    await noteError(error);
    return { ok: false, error };
  }

  const translations = Array.isArray(data && data.translations) ? data.translations : [];
  const twFix = s.twFix && String(targetLang).toUpperCase().startsWith('ZH-HANT');
  pending.forEach((p, i) => {
    const t = translations[i];
    if (!t) return;
    const detected = t.detected_source_language || '';
    const text = twFix ? DT.applyTaiwanTerms(t.text || '') : (t.text || '');
    const skipped = detected.slice(0, 2).toUpperCase() === String(targetLang).slice(0, 2).toUpperCase();
    const entry = { text, detected, skipped };
    cachePut(p.cacheKey, entry);
    results.push(Object.assign({ id: p.item.id }, entry));
  });

  await clearErrorState();
  return { ok: true, results };
}

async function usage() {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: { code: 'NO_KEY' } };
  const base = DT.resolveBase(s.apiKey, s.endpointMode, s.apiBase);
  const outcome = await withSlot(() => request(base + '/v2/usage', {
    method: 'GET',
    headers: { 'Authorization': 'DeepL-Auth-Key ' + s.apiKey },
  }));
  if (outcome.error) {
    await noteError(outcome.error);
    return { ok: false, error: outcome.error };
  }
  try {
    const data = await outcome.res.json();
    await clearErrorState();
    return {
      ok: true,
      character_count: Number(data.character_count) || 0,
      character_limit: Number(data.character_limit) || 0,
    };
  } catch (err) {
    const error = { code: 'SERVER', message: errMessage(err) };
    await noteError(error);
    return { ok: false, error };
  }
}

async function getStatus() {
  const stored = await chrome.storage.local.get({ lastError: null, pausedQuota: false });
  return { ok: true, lastError: stored.lastError, paused: { quota: pausedQuota || stored.pausedQuota } };
}

async function clearError() {
  pausedQuota = false;
  await clearErrorState();
  return { ok: true };
}

async function request(url, init) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt++]); continue; }
      return { error: { code: 'NETWORK', message: errMessage(err) } };
    }
    if (res.ok) return { res };
    const code = DT.mapDeepLError(res.status);
    if ((code === 'RATE' || code === 'SERVER') && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt++]);
      continue;
    }
    return { error: { code, status: res.status } };
  }
}

async function withSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function acquire() {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else inflight--;
}

function cachePut(key, entry) {
  if (bgCache.has(key)) bgCache.delete(key);
  bgCache.set(key, entry);
  while (bgCache.size > CACHE_LIMIT) bgCache.delete(bgCache.keys().next().value);
}

async function noteError(error) {
  if (error.code === 'QUOTA') pausedQuota = true;
  const hard = error.code === 'AUTH' || error.code === 'QUOTA';
  await chrome.storage.local.set({
    lastError: { code: error.code, status: error.status || 0, at: Date.now() },
    pausedQuota: pausedQuota,
  });
  if (hard) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: '!' });
  }
}

async function clearErrorState() {
  const cur = await chrome.storage.local.get({ lastError: null, pausedQuota: false });
  if (cur.lastError !== null || cur.pausedQuota !== pausedQuota) {
    await chrome.storage.local.set({ lastError: null, pausedQuota: pausedQuota });
  }
  if (!pausedQuota) await chrome.action.setBadgeText({ text: '' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err) {
  return String((err && err.message) || err || '');
}

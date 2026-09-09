// popup 邏輯：讀寫 chrome.storage.local 設定、查用量、呈現最近錯誤。
const ERROR_TEXT = {
  AUTH: '金鑰無效（403）',
  QUOTA: '本期額度已用盡（456）',
  RATE: '請求過於頻繁，稍後自動重試',
  TOO_LARGE: '單則訊息過大（413）',
  SERVER: 'DeepL 伺服器忙碌，稍後再試',
  NETWORK: '無法連線 DeepL',
  NO_KEY: '尚未輸入 DeepL 金鑰',
};

const el = {
  enabled: document.getElementById('enabled'),
  apiKey: document.getElementById('apiKey'),
  toggleKey: document.getElementById('toggleKey'),
  targetLang: document.getElementById('targetLang'),
  twFix: document.getElementById('twFix'),
  save: document.getElementById('save'),
  checkUsage: document.getElementById('checkUsage'),
  usageBox: document.getElementById('usageBox'),
  usageText: document.getElementById('usageText'),
  usageBar: document.getElementById('usageBar'),
  statusBox: document.getElementById('statusBox'),
  statusText: document.getElementById('statusText'),
  clearError: document.getElementById('clearError'),
};

load();

async function load() {
  const s = await chrome.storage.local.get(DT.DEFAULTS);
  el.enabled.checked = s.enabled !== false;
  el.apiKey.value = s.apiKey || '';
  el.targetLang.value = s.targetLang || 'ZH-HANT';
  el.twFix.checked = s.twFix !== false;
  setEndpointMode(s.endpointMode || 'auto');
  syncTwFixAvailability();
  bind();
  await refreshStatus();
}

function bind() {
  el.enabled.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: el.enabled.checked });
  });
  el.toggleKey.addEventListener('click', () => {
    const shown = el.apiKey.type === 'text';
    el.apiKey.type = shown ? 'password' : 'text';
    el.toggleKey.textContent = shown ? '顯示' : '隱藏';
  });
  for (const node of [el.apiKey, el.targetLang, el.twFix, ...endpointInputs()]) {
    node.addEventListener('input', markDirty);
    node.addEventListener('change', markDirty);
  }
  el.targetLang.addEventListener('change', syncTwFixAvailability);
  el.save.addEventListener('click', save);
  el.checkUsage.addEventListener('click', checkUsage);
  el.clearError.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearError' });
    await refreshStatus();
  });
}

function endpointInputs() {
  return Array.from(document.querySelectorAll('input[name="endpointMode"]'));
}

function endpointMode() {
  const checked = endpointInputs().find((n) => n.checked);
  return checked ? checked.value : 'auto';
}

function setEndpointMode(mode) {
  for (const node of endpointInputs()) node.checked = node.value === mode;
}

function markDirty() {
  el.save.disabled = false;
}

function syncTwFixAvailability() {
  const isHant = el.targetLang.value === 'ZH-HANT';
  el.twFix.disabled = !isHant;
}

async function save() {
  await chrome.storage.local.set({
    enabled: el.enabled.checked,
    apiKey: el.apiKey.value.trim(),
    endpointMode: endpointMode(),
    targetLang: el.targetLang.value,
    twFix: el.twFix.checked,
  });
  el.save.disabled = true;
  await refreshStatus();
}

async function checkUsage() {
  el.checkUsage.disabled = true;
  el.usageText.textContent = '查詢中…';
  el.usageBox.hidden = false;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'usage' });
    if (resp && resp.ok) {
      el.usageText.textContent = DT.formatUsage(resp.character_count, resp.character_limit);
      const pct = resp.character_limit > 0 ? (resp.character_count / resp.character_limit) * 100 : 0;
      el.usageBar.style.width = Math.min(100, pct).toFixed(1) + '%';
      el.usageBar.classList.toggle('warn', pct >= 80);
      showStatus(null);
    } else {
      el.usageBox.hidden = true;
      showStatus((resp && resp.error) || { code: 'NETWORK' });
    }
  } finally {
    el.checkUsage.disabled = false;
  }
  await refreshStatus();
}

async function refreshStatus() {
  const resp = await chrome.runtime.sendMessage({ type: 'getStatus' });
  const error = (resp && resp.lastError) || (el.apiKey.value.trim() ? null : { code: 'NO_KEY' });
  showStatus(error);
}

function showStatus(error) {
  const hasError = Boolean(error && error.code);
  el.statusBox.classList.toggle('error', hasError);
  el.clearError.hidden = !hasError || error.code === 'NO_KEY';
  el.statusText.textContent = hasError
    ? (ERROR_TEXT[error.code] || ('發生錯誤（' + error.code + '）'))
    : '已儲存 · 正常';
}

importScripts('config.js');

const API = 'http://127.0.0.1:8787';
const TOKEN = globalThis.REEL_TO_CODEX_TOKEN;
let contentStatus = 'Waiting for WhatsApp Web.';

async function api(path, options = {}) {
  if (!TOKEN) throw new Error('setup_required');
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    cache: 'no-store'
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'collector_unavailable');
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'RTC_STATUS') {
    contentStatus = typeof message.status === 'string' ? message.status.slice(0, 120) : 'Status unavailable.';
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'RTC_GET_UI_STATUS') {
    sendResponse({ ok: true, status: contentStatus });
    return false;
  }
  if (message?.type === 'RTC_GET_STATE') {
    api('/v1/state').then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RTC_SET_BASELINE') {
    api('/v1/baseline', { method: 'POST', body: JSON.stringify(message.payload) })
      .then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RTC_HEARTBEAT') {
    api('/v1/heartbeat', { method: 'POST', body: JSON.stringify(message.payload) })
      .then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RTC_INGEST') {
    api('/v1/events', { method: 'POST', body: JSON.stringify(message.payload) })
      .then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RTC_CURSOR_GAP') {
    api('/v1/cursor-gap', { method: 'POST', body: JSON.stringify(message.payload) })
      .then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

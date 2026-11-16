const status = document.getElementById('status');
const button = document.getElementById('rebaseline');
const result = document.getElementById('result');

chrome.runtime.sendMessage({ type: 'RTC_GET_STATE' }).then((response) => {
  if (!response?.ok) {
    status.textContent = response?.error === 'setup_required' ? 'Run npm run setup first.' : 'Collector is offline.';
    return;
  }
  const state = response.data;
  if (state.lastError === 'cursor_gap') status.textContent = 'Paused after a cursor gap.';
  else if (!state.initialized) status.textContent = 'Waiting for the first self-chat baseline.';
  else if (state.lastChatVerifiedAt && Date.now() - Date.parse(state.lastChatVerifiedAt) < 20000) status.textContent = 'Collector connected; self-chat was just verified.';
  else status.textContent = 'Collector is running. Open your Message Yourself chat to collect.';
}).catch(() => { status.textContent = 'Collector is offline.'; });

chrome.runtime.sendMessage({ type: 'RTC_GET_UI_STATUS' }).then((response) => {
  if (response?.ok && response.status) result.textContent = response.status;
}).catch(() => {});

button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = 'Rebaselining…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://web.whatsapp.com/')) throw new Error('Open WhatsApp Web and select your Message Yourself chat.');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'RTC_REBASELINE' });
    if (!response?.ok) throw new Error(response?.error || 'Could not rebaseline.');
    result.textContent = 'Rebased. New messages will be collected from now on.';
    status.textContent = 'Self-chat baseline is ready.';
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

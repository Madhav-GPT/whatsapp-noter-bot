(() => {
  const SELF_CHAT_TITLE = globalThis.REEL_TO_CODEX_SELF_CHAT_TITLE || 'Message Yourself (You)';
  const HEADER = '[data-testid="conversation-info-header-chat-title-name"]';
  const MESSAGE_SELECTOR = '#main [data-testid="msg-container"]';
  let busy = false;
  let blockedByGap = false;
  let lastStatus = '';
  let lastHeartbeat = 0;
  let baselineCandidate;
  let baselineStablePolls = 0;
  const emptySince = new Map();

  function currentTitle() {
    return document.querySelector(HEADER)?.textContent?.trim() || '';
  }

  function notifyStatus(status) {
    if (status === lastStatus) return;
    lastStatus = status;
    chrome.runtime.sendMessage({ type: 'RTC_STATUS', status }).catch(() => {});
  }

  function messageIdentity(node) {
    const id = node.getAttribute('data-id') || node.querySelector('[data-id]')?.getAttribute('data-id');
    return id || null;
  }

  async function hashIdentity(identity) {
    const bytes = new TextEncoder().encode(identity);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }

  function extractVisibleMessageText(node) {
    const parts = [...node.querySelectorAll('[data-testid="selectable-text"], .selectable-text')]
      .map((element) => element.textContent || '')
      .filter(Boolean);
    const anchors = [...node.querySelectorAll('a[href]')]
      .map((anchor) => anchor.href)
      .filter((href) => /^https?:\/\//i.test(href));
    return [...parts, ...anchors].join('\n').trim().slice(0, 10000);
  }

  function isOutgoing(node) {
    return node.classList.contains('message-out') || Boolean(node.querySelector('.message-out')) ||
      Boolean(node.getAttribute('data-id')?.startsWith('true_')) || Boolean(node.querySelector('[data-id^="true_"]'));
  }

  async function markOutbound(item, path, payload) {
    return sendMessage('RTC_OUTBOUND_RESULT', { path, payload: { ...payload, chatTitle: SELF_CHAT_TITLE, outboxId: item.id } });
  }

  async function deliverOne() {
    if (currentTitle() !== SELF_CHAT_TITLE) return false;
    const response = await chrome.runtime.sendMessage({ type: 'RTC_OUTBOX_CLAIM', payload: { chatTitle: SELF_CHAT_TITLE } });
    if (!response?.ok || !response.item) return false;
    const item = response.item;
    const fail = () => markOutbound(item, '/v1/outbox/failed', {});
    try {
      if (currentTitle() !== SELF_CHAT_TITLE || !/^Codex:/i.test(item.body)) { await fail(); return true; }
      const composer = document.querySelector('#main [data-testid="conversation-compose-box-input"][contenteditable="true"]');
      const sendButton = document.querySelector('#main [data-testid="send"]');
      if (!composer || !sendButton || composer.textContent?.trim()) { await fail(); notifyStatus('Outbound message held: the self-chat composer was not in a safe state.'); return true; }
      const beforeSend = new Set([...document.querySelectorAll(MESSAGE_SELECTOR)].map(messageIdentity).filter(Boolean));
      const existingOutgoing = [...document.querySelectorAll(MESSAGE_SELECTOR)].some(isOutgoing);
      if (!existingOutgoing) { await fail(); notifyStatus('Outbound message held: WhatsApp message direction could not be verified.'); return true; }

      composer.focus();
      document.execCommand('insertText', false, item.body);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: item.body }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (currentTitle() !== SELF_CHAT_TITLE || composer.textContent?.trim() !== item.body) { await fail(); return true; }
      const readyButton = document.querySelector('#main [data-testid="send"]');
      if (!readyButton) { await fail(); return true; }
      readyButton.click();

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (currentTitle() !== SELF_CHAT_TITLE) { await fail(); return; }
        const sent = [...document.querySelectorAll(MESSAGE_SELECTOR)].find((node) => {
          const identity = messageIdentity(node);
          return Boolean(identity && !beforeSend.has(identity) && isOutgoing(node) && extractVisibleMessageText(node) === item.body);
        });
        const identity = sent && messageIdentity(sent);
        if (identity) {
          const messageKey = await hashIdentity(identity);
          const marked = await markOutbound(item, '/v1/outbox/sent', { messageKey });
          if (!marked?.ok) {
            await fail().catch(() => {});
            notifyStatus('Message was sent, but the delivery receipt was not confirmed. The gateway will not retry it.');
            return true;
          }
          notifyStatus('One Codex reply was sent to the configured self-chat.');
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await fail();
      notifyStatus('Outbound send could not be verified. It will not be retried automatically.');
      return true;
    } catch {
      await fail().catch(() => {});
      notifyStatus('Outbound send failed safely and will not be retried.');
      return true;
    }
  }

  async function getRows() {
    if (currentTitle() !== SELF_CHAT_TITLE) return [];
    return Promise.all([...document.querySelectorAll(MESSAGE_SELECTOR)].map(async (node) => {
      const identity = messageIdentity(node);
      return identity ? { key: await hashIdentity(identity), node } : null;
    })).then((rows) => rows.filter(Boolean));
  }

  async function sendMessage(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      // This title check must pass before message nodes or text are queried.
      if (currentTitle() !== SELF_CHAT_TITLE) {
        notifyStatus('Open your Message Yourself chat to collect.');
        return;
      }
      notifyStatus('Self-chat active. Checking new messages…');
      if (Date.now() - lastHeartbeat > 15000) {
        lastHeartbeat = Date.now();
        void sendMessage('RTC_HEARTBEAT', { chatTitle: SELF_CHAT_TITLE }).catch(() => {});
      }
      const stateResponse = await chrome.runtime.sendMessage({ type: 'RTC_GET_STATE' });
      if (!stateResponse?.ok) {
        notifyStatus(stateResponse?.error === 'setup_required' ? 'Run npm run setup first.' : 'Collector offline. Start npm run collector.');
        return;
      }
      const state = stateResponse.data;
      if (currentTitle() !== SELF_CHAT_TITLE) return;
      const rows = await getRows();
      if (currentTitle() !== SELF_CHAT_TITLE) return;
      if (!state.initialized) {
        if (!document.querySelector('[data-testid="conversation-panel-messages"]')) {
          notifyStatus('Waiting for the self-chat message panel to finish loading.');
          return;
        }
        const latest = rows.at(-1)?.key || null;
        if (latest === baselineCandidate) baselineStablePolls += 1;
        else {
          baselineCandidate = latest;
          baselineStablePolls = 1;
        }
        if (baselineStablePolls < 3) {
          notifyStatus('Waiting for the self-chat history to settle before setting a safe baseline.');
          return;
        }
        const result = await sendMessage('RTC_SET_BASELINE', { chatTitle: SELF_CHAT_TITLE, messageKey: latest });
        notifyStatus(result?.ok ? 'Baseline set. New messages will be collected.' : 'Could not set the self-chat baseline.');
        return;
      }
      if (blockedByGap) return;

      let start = 0;
      if (state.cursor) {
        const index = rows.findIndex((row) => row?.key === state.cursor);
        if (index < 0) {
          blockedByGap = true;
          await sendMessage('RTC_CURSOR_GAP', { chatTitle: SELF_CHAT_TITLE });
          notifyStatus('Collection paused: the last cursor is no longer visible. Use Rebaseline to resume.');
          return;
        }
        start = index + 1;
      }

      for (const row of rows.slice(start)) {
        if (!row) continue;
        if (currentTitle() !== SELF_CHAT_TITLE) return;
        const text = extractVisibleMessageText(row.node);
        if (!text && Date.now() - (emptySince.get(row.key) || Date.now()) < 5000) {
          if (!emptySince.has(row.key)) emptySince.set(row.key, Date.now());
          break;
        }
        emptySince.delete(row.key);
        const response = await sendMessage('RTC_INGEST', {
          chatTitle: SELF_CHAT_TITLE,
          messageKey: row.key,
          text,
          observedAt: new Date().toISOString()
        });
        if (!response?.ok) {
          notifyStatus('Collector rejected a message. Check local collector status.');
          return;
        }
      }
      const outboundHandled = currentTitle() === SELF_CHAT_TITLE ? await deliverOne() : false;
      if (!outboundHandled) notifyStatus('Self-chat active. Listening for new messages.');
    } catch {
      notifyStatus('Collector unavailable. Check that npm run collector is running.');
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'RTC_REBASELINE') return false;
    void (async () => {
      if (currentTitle() !== SELF_CHAT_TITLE) throw new Error('Open your Message Yourself chat before rebaselining.');
      const rows = await getRows();
      const latest = rows.at(-1)?.key || null;
      const response = await sendMessage('RTC_SET_BASELINE', { chatTitle: SELF_CHAT_TITLE, messageKey: latest });
      if (!response?.ok) throw new Error('Collector rejected the baseline.');
      blockedByGap = false;
      notifyStatus('Rebased. New messages will be collected from now on.');
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  setInterval(() => void poll(), 1500);
  new MutationObserver(() => void poll()).observe(document.documentElement, { childList: true, subtree: true });
  void poll();
})();

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { EXTENSION_ID } from '../src/paths.js';
import { readFile as readText } from 'node:fs/promises';

test('Chrome extension ID used by collector matches the pinned public key', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')) as { key?: string };
  assert.ok(manifest.key);
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const derived = [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(derived, EXTENSION_ID);
});

test('outbound sender waits until after typing to locate send, then requires an enabled control and verified identity', async () => {
  const content = await readText(new URL('../extension/content.js', import.meta.url), 'utf8');
  const compose = content.indexOf("document.execCommand('insertText'");
  const sendLookup = content.indexOf("document.querySelector('#main [data-testid=\"send\"]')");
  const click = content.indexOf('readyButton.click()');
  assert.ok(compose >= 0 && sendLookup > compose && click > sendLookup, 'send button should be queried only after composition');
  assert.match(content.slice(sendLookup, click), /isEnabledControl\(readyButton\)/);
  assert.match(content, /!beforeSend\.has\(identity\) && isOutgoing\(node\) && extractVisibleMessageText\(node\) === item\.body/);
  assert.match(content, /const uncertain = \(\) => markOutbound\(item, '\/v1\/outbox\/uncertain'/);
  assert.match(content.slice(click, content.indexOf('async function getRows')), /await uncertain\(\)/);
});

async function runStartupSelection({ selectedTitle = 'Different Chat', hasSelfChat = true, searchInput = false } = {}) {
  const selfTitle = 'Piet Madhav (You)';
  const messageTypes: string[] = [];
  let selected = selectedTitle;
  let rowClicks = 0;
  let queriedMessageNodes = 0;

  class FakeElement {
    textContent = '';
    value = '';
    isContentEditable = false;
    row: FakeElement | null = null;
    getAttribute() { return null; }
    getClientRects() { return [{}]; }
    closest() { return this.row; }
    click() { rowClicks += 1; selected = selfTitle; }
    dispatchEvent() { return true; }
    focus() {}
  }
  class FakeInput extends FakeElement {}

  const header = new FakeElement();
  header.textContent = selected;
  const row = new FakeElement();
  const label = new FakeElement();
  label.textContent = selfTitle;
  label.row = row;
  const search = new FakeInput();
  const pane = {
    querySelectorAll(selector: string) { return hasSelfChat && selector.includes('[title=') ? [label] : []; },
    querySelector(selector: string) { return searchInput && selector.includes('input[placeholder') ? search : null; },
  };
  const document = {
    documentElement: {},
    querySelector(selector: string) {
      if (selector === '[data-testid="conversation-info-header-chat-title-name"]') {
        header.textContent = selected;
        return header;
      }
      return selector === '#pane-side' ? pane : null;
    },
    querySelectorAll(selector: string) {
      if (selector.includes('msg-container')) queriedMessageNodes += 1;
      return [];
    },
    execCommand() { return true; },
  };
  const sandbox = {
    REEL_TO_CODEX_SELF_CHAT_TITLE: selfTitle,
    document,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class extends FakeElement {},
    InputEvent: class {},
    MutationObserver: class { observe() {} },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage(message: { type: string }) { messageTypes.push(message.type); return Promise.resolve({ ok: true }); },
    } },
    setInterval() { return 1; },
  };
  const content = await readText(new URL('../extension/content.js', import.meta.url), 'utf8');
  runInNewContext(content, sandbox);
  return { messageTypes, rowClicks, queriedMessageNodes, searchValue: search.value };
}

test('WhatsApp startup selects only the configured self-chat before reading any messages', async () => {
  const selected = await runStartupSelection();
  assert.equal(selected.rowClicks, 1);
  assert.deepEqual(selected.messageTypes, ['RTC_STATUS']);
  assert.equal(selected.queriedMessageNodes, 0);

  const searched = await runStartupSelection({ hasSelfChat: false, searchInput: true });
  assert.equal(searched.searchValue, 'Piet Madhav (You)');
  assert.deepEqual(searched.messageTypes, ['RTC_STATUS']);
  assert.equal(searched.queriedMessageNodes, 0);
});

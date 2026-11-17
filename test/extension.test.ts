import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

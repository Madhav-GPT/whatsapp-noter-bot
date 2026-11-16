import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EXTENSION_ID } from '../src/paths.js';

test('Chrome extension ID used by collector matches the pinned public key', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')) as { key?: string };
  assert.ok(manifest.key);
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const derived = [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(derived, EXTENSION_ID);
});

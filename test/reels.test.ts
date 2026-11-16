import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReelLinks, isInstructionCommand } from '../src/reels.js';

test('extracts and canonicalizes common Reel share URLs without fetching them', () => {
  const links = extractReelLinks('Save https://www.instagram.com/reel/AbC_123/?igsh=abc and https://m.instagram.com/reels/XYZ-7?utm_source=share');
  assert.equal(links.length, 2);
  assert.equal(links[0]?.originalUrl, 'https://www.instagram.com/reel/AbC_123/?igsh=abc');
  assert.equal(links[0]?.canonicalUrl, 'https://www.instagram.com/reel/AbC_123/');
  assert.equal(links[1]?.canonicalUrl, 'https://www.instagram.com/reel/XYZ-7/');
});

test('rejects non-Reel Instagram URLs and lookalike hosts', () => {
  assert.deepEqual(extractReelLinks('https://instagram.com/p/ABC https://instagram.com.evil.test/reel/ABC'), []);
});

test('deduplicates equivalent canonical links and recognizes lightweight commands', () => {
  assert.equal(extractReelLinks('https://instagram.com/reel/ABC https://www.instagram.com/reel/ABC/?share=x').length, 1);
  assert.equal(isInstructionCommand(' /DONE '), 'done');
  assert.equal(isInstructionCommand('/cancel'), 'cancel');
  assert.equal(isInstructionCommand('please do this'), undefined);
});

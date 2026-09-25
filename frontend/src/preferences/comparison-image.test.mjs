import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { comparisonImage } from './comparison-image.ts';

test('responsive candidates use the fixed full-composition thumbnails at their actual pixel widths', async () => {
  const catalog = JSON.parse(await readFile(new URL('../../../data/preferences/catalog.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../../../assets/preferences-manifest.json', import.meta.url)));
  const files = new Map(manifest.files.map(f => ['/assets/preferences/' + f.path, f]));
  for (const art of catalog.appearances) {
    const image = comparisonImage(art.image_url, catalog.appearances);
    assert.equal(image.src, art.thumbnail_url);
    assert.equal(image.srcset, `${art.thumbnail_url} ${files.get(art.thumbnail_url).width}w, ${art.image_url} ${files.get(art.image_url).width}w`);
    assert.ok(!image.srcset.includes('/portrait/'));
  }
});

test('unknown or historical task images keep their exact composition and do not borrow newer art', () => {
  assert.deepEqual(comparisonImage('/illustrations/old.webp?v=old', [
    { image_url: '/illustrations/new.webp', thumbnail_url: '/thumb/new.webp', portrait_url: '/portrait/new.webp' },
  ]), { src: '/illustrations/old.webp?v=old' });
});

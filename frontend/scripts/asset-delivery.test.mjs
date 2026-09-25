import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetRoutes, assetVersions } from './asset-delivery.mjs';

test('delivery versions are content digests and restrict immutable routes to fixed assets', async () => {
  const versions = await assetVersions();
  assert.match(versions.atlas, /^[a-f0-9]{24}$/);
  assert.notEqual(versions.atlas, versions.preferences);
  const routes = assetRoutes(versions);
  assert.ok(routes.includes(`/media/${versions.preferences}/assets/preferences/*`));
  assert.ok(routes.includes(`not path /media/${versions.atlas}/avatars/unknown.svg`));
  assert.ok(!routes.includes('/assets/licenses/'));
});

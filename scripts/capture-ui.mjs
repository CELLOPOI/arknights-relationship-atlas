import path from 'node:path';
import { verificationDirectory } from './verification-output.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

import { chromium } from './playwright.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4188';
const output = await verificationDirectory('capture');
const reports = [];
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });

try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
    ['landscape', { width: 844, height: 390 }]
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: name !== 'desktop', isMobile: name !== 'desktop' });
    const report = { name, viewport, errors: [], resourceErrors: [] };
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) report.resourceErrors.push(response.url()); });
    const capture = async state => {
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await page.waitForFunction(() => { const state = window.terraPortal?.getState(); return state && (state.page === 'graph' || !state.forming); });
      await page.screenshot({ path: path.join(output, `${name}-${state}.png`), fullPage: true, animations: 'disabled' });
    };
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    await capture('home');
    await page.locator('.portal-enter').click();
    await page.waitForTimeout(1500);
    await capture('factions');
    if (name === 'landscape') {
      report.particleSeparation = await page.evaluate(() => {
        const field = document.querySelector('.particle-stage').getBoundingClientRect();
        const caption = document.querySelector('.emblem-caption').getBoundingClientRect();
        return { fieldBottom: field.bottom, captionTop: caption.top };
      });
      assert.ok(report.particleSeparation.fieldBottom <= report.particleSeparation.captionTop + 1);
    }
    await page.locator('.faction-entry[data-enter="rhodes"]').click();
    await page.waitForTimeout(1300);
    report.overviewScale = await page.evaluate(() => window.relationshipAtlas.getState().camera.k);
    await capture('graph');
    await page.locator('#search').fill('凯尔希');
    await page.locator('#search').press('Enter');
    await page.waitForTimeout(400);
    report.personScale = await page.evaluate(() => window.relationshipAtlas.getState().camera.k);
    if (name === 'landscape') {
      report.groupLabelsOverlap = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('.group-name')].map(element => element.getBoundingClientRect());
        return boxes.some((a, index) => boxes.slice(index + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
      });
      assert.equal(report.groupLabelsOverlap, false);
      assert.ok(report.overviewScale >= .4 && report.personScale >= .2);
    }
    await capture('kaltsit');
    await page.locator('#open-list').click();
    await page.waitForTimeout(350);
    await page.locator('[data-kind="awareness"]').click();
    await page.waitForTimeout(300);
    await capture('list');
    await page.locator('[data-detail]').first().click();
    await page.locator('.dossier-quote').waitFor();
    await page.waitForTimeout(300);
    await capture('evidence');
    // 使用坐标点击，避免 locator 自动滚动掩盖关闭按钮移出视口的问题。
    report.closeButton = await page.evaluate(() => {
      const button = document.querySelector('#close-panel');
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { x, y, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, hit: button.contains(document.elementFromPoint(x, y)) };
    });
    assert.ok(report.closeButton.top >= 0 && report.closeButton.bottom <= viewport.height);
    assert.ok(report.closeButton.left >= 0 && report.closeButton.right <= viewport.width && report.closeButton.hit);
    await page.mouse.click(report.closeButton.x, report.closeButton.y);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#panel').evaluate(element => element.open), false);
    report.documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.equal(report.documentWidth, viewport.width);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.resourceErrors, []);
    reports.push(report);
    console.log(`PASS ${name}: captures, layout, visible close control`);
    await fs.writeFile(path.join(output, 'visual-checks.json'), JSON.stringify({ date: new Date().toISOString(), reports }, null, 2));
    await page.close();
  }
} finally {
  await browser.close();
}

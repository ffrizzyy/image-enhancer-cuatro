// Playwright drives the real Electron window through the whole fake-provider flow:
// import -> setup -> run (a scripted captcha pauses it) -> resume -> result -> export in all three formats.
//
// The fake provider comes from IE_FAKE_PROVIDER=1 and IE_FAKE_MODES scripts one outcome per provider call.
// A throwaway user-data folder keeps the run away from real settings, logins and jobs.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';
import sharp from 'sharp';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = mkdtempSync(path.join(tmpdir(), 'ie-e2e-profile-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'ie-e2e-work-'));
const sourcePath = path.join(workDir, 'source.png');
const failureShot = path.join(workDir, 'failure.png');

/** A structured picture, so the stitcher has real seams to work with. */
async function makeSource() {
  const width = 480;
  const height = 320;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(
        [120 + 90 * Math.sin(x / 23), 110 + 70 * Math.cos(y / 17), 120 + 60 * Math.sin((x + y) / 31)],
        (y * width + x) * 3,
      );
    }
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(sourcePath);
}

async function cleanUp() {
  for (const dir of [profileDir, workDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* a browser process may still hold a file; the OS cleans the temp folder later */
    }
  }
}

async function main() {
  await makeSource();

  let app;
  let page;
  try {
    console.log('Launching the real Electron app with the fake provider…');
    app = await electron.launch({
      args: ['.'],
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        IE_FAKE_PROVIDER: '1',
        // Tile 1 succeeds, tile 2 asks for a human check, and the rest succeeds after Resume.
        IE_FAKE_MODES: 'ok,challenge,ok,ok,ok,ok,ok,ok',
        IE_FAKE_DELAY_MS: '0',
        // Keep the pause on screen until the test presses Resume instead of auto-resuming after 3 s.
        IE_FAKE_AUTO_RESUME_MS: '600000',
        IE_USER_DATA_DIR: profileDir,
      },
      timeout: 30_000,
    });

    page = await app.firstWindow({ timeout: 30_000 });
    page.on('pageerror', (error) => console.error(`renderer error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`renderer console: ${message.text()}`);
    });
    await page.waitForLoadState('domcontentloaded');

    // 1. First run: the risk notice blocks the app until it is acknowledged.
    const acknowledge = page.getByRole('button', { name: /I understand and accept the risk/i });
    if (await acknowledge.isVisible().catch(() => false)) {
      console.log('Acknowledging the first-run risk notice…');
      await acknowledge.click();
    }
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor({ timeout: 15_000 });

    // 2. Import a picture through the real file input (the preload resolves its path).
    console.log('Importing the source picture…');
    await page.locator('input[type="file"]').setInputFiles(sourcePath);
    await page.getByTestId('asset-summary').waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId('asset-summary').innerText(), /480×320 px/);

    // 3. Setup: pick a category and the fake-backed provider, wait for Ready, then Start.
    console.log('Choosing the category and provider…');
    await page.getByRole('heading', { level: 1, name: 'Setup' }).waitFor();
    await page.locator('input[name="category"][value="env-realistic"]').check();
    await page.getByRole('radio', { name: /Gemini/ }).check();
    await page.getByRole('status', { name: 'Gemini login: Ready' }).waitFor({ timeout: 15_000 });
    const start = page.getByRole('button', { name: 'Start' });
    await start.waitFor();
    assert.equal(await start.isEnabled(), true);
    await start.click();

    // 4. The scripted challenge pauses tile 2; the person presses Resume.
    console.log('Waiting for the injected captcha pause…');
    const banner = page.getByTestId('pause-banner');
    await banner.waitFor({ timeout: 60_000 });
    assert.equal(await banner.getAttribute('data-reason'), 'challenge');
    await page.getByText('Paused: The provider asked for a human check.').waitFor();
    console.log('Paused for the injected captcha; resuming…');
    await page.getByRole('button', { name: /^Resume/ }).click();

    // 5. The run finishes and the Result screen loads the stitched picture.
    await page.getByRole('button', { name: 'See the result' }).waitFor({ timeout: 120_000 });
    await page.getByRole('button', { name: 'See the result' }).click();
    await page.getByTestId('result-summary').waitFor({ timeout: 30_000 });
    await page.getByTestId('save-panel').waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId('result-summary').innerText(), /Done/);

    // 6. Export PNG, JPEG and WebP through the Save panel. The native dialog is answered in the main process.
    for (const { value, extension } of [
      { value: 'png', extension: 'png' },
      { value: 'jpeg', extension: 'jpg' },
      { value: 'webp', extension: 'webp' },
    ]) {
      const destination = path.join(workDir, `enhanced.${extension}`);
      console.log(`Exporting ${value.toUpperCase()} to ${destination}…`);
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, destination);

      await page.locator('#export-format').selectOption(value);
      await page.getByRole('button', { name: 'Save the picture' }).click();
      const saved = page.getByRole('status').filter({ hasText: `Saved to ${destination}` });
      await saved.waitFor({ timeout: 30_000 });

      const text = await saved.innerText();
      const size = text.match(/\((\d+) × (\d+)\)/);
      assert.ok(size, `the saved message should carry the picture size: ${text}`);
      assert.equal(existsSync(destination), true);
      const meta = await sharp(destination).metadata();
      assert.equal(meta.width, Number(size[1]), `${value} width`);
      assert.equal(meta.height, Number(size[2]), `${value} height`);
      assert.equal(meta.format, value === 'jpeg' ? 'jpeg' : value);
    }

    console.log('\nE2E_OK: import -> setup -> captcha pause -> resume -> result -> PNG/JPEG/WebP export');
  } catch (error) {
    if (page) await page.screenshot({ path: failureShot }).catch(() => undefined);
    console.error(`\nE2E_FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    console.error(`A screenshot (when available) is at ${failureShot}`);
    process.exitCode = 1;
  } finally {
    await app?.close().catch(() => undefined);
    await cleanUp();
  }
}

await main();

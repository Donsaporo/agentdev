import { getSupabase } from '../core/supabase.js';
import { getSecretWithFallback } from '../core/secrets.js';
import { logger } from '../core/logger.js';
import type { ScreenshotResult } from '../core/types.js';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

const BROWSERLESS_BASE = 'https://chrome.browserless.io';

async function getBrowserlessToken(): Promise<string> {
  return getSecretWithFallback('browserless');
}

async function captureWithBrowserless(
  url: string,
  width: number,
  height: number,
  token: string
): Promise<Buffer> {
  const response = await fetch(`${BROWSERLESS_BASE}/screenshot?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      options: {
        fullPage: true,
        type: 'png',
      },
      gotoOptions: {
        waitUntil: 'networkidle0',
        timeout: 30000,
      },
      viewport: { width, height },
      waitForTimeout: 2000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    throw new Error(`Browserless screenshot failed (${response.status}): ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

type Browser = { connected: boolean; close: () => Promise<void>; newPage: () => Promise<PuppeteerPage> };
type PuppeteerPage = {
  setViewport: (v: { width: number; height: number }) => Promise<void>;
  goto: (url: string, opts: Record<string, unknown>) => Promise<unknown>;
  screenshot: (opts: Record<string, unknown>) => Promise<Uint8Array>;
  close: () => Promise<void>;
};

let browser: Browser | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let puppeteerModule: any = null;
let puppeteerAvailable: boolean | null = null;

async function getPuppeteer() {
  if (puppeteerAvailable === false) return null;
  if (puppeteerModule) return puppeteerModule;
  try {
    puppeteerModule = await import('puppeteer');
    puppeteerAvailable = true;
    return puppeteerModule;
  } catch {
    puppeteerAvailable = false;
    return null;
  }
}

async function getBrowser(token?: string): Promise<Browser | null> {
  const pptr = await getPuppeteer();
  if (!pptr) return null;

  if (!browser || !browser.connected) {
    try {
      if (token) {
        browser = await pptr.default.connect({
          browserWSEndpoint: `wss://chrome.browserless.io?token=${token}`,
        });
      } else {
        browser = await pptr.default.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
      }
    } catch (err) {
      await logger.warn(`Browser launch failed: ${err instanceof Error ? err.message : String(err)}`, 'qa');
      return null;
    }
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function captureWithPuppeteer(
  url: string,
  width: number,
  height: number,
  token?: string
): Promise<Buffer | null> {
  const b = await getBrowser(token);
  if (!b) return null;
  const page = await b.newPage();
  try {
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    return Buffer.from(screenshot);
  } finally {
    await page.close();
  }
}

async function captureViewport(
  url: string,
  width: number,
  height: number
): Promise<Buffer | null> {
  const token = await getBrowserlessToken();

  if (token) {
    try {
      return await captureWithBrowserless(url, width, height, token);
    } catch (err) {
      await logger.warn(
        `Browserless REST failed, trying Puppeteer WS: ${err instanceof Error ? err.message : String(err)}`,
        'qa'
      );
      try {
        return await captureWithPuppeteer(url, width, height, token);
      } catch (wsErr) {
        await logger.warn(
          `Puppeteer WS also failed: ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`,
          'qa'
        );
        return null;
      }
    }
  }

  return captureWithPuppeteer(url, width, height);
}

async function uploadToStorage(
  projectId: string,
  pageName: string,
  viewportName: string,
  version: number,
  buffer: Buffer
): Promise<string> {
  const supabase = getSupabase();
  const safeName = pageName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const path = `${projectId}/${safeName}/v${version}-${viewportName}.png`;

  const { error } = await supabase.storage
    .from('qa-screenshots')
    .upload(path, buffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData } = supabase.storage
    .from('qa-screenshots')
    .getPublicUrl(path);

  return urlData.publicUrl;
}

export async function capturePageScreenshots(
  url: string,
  pageName: string,
  projectId: string,
  version: number = 1
): Promise<ScreenshotResult> {
  const token = await getBrowserlessToken();
  const hasPptr = await getPuppeteer();

  if (!token && !hasPptr) {
    await logger.info(`Screenshots skipped for ${pageName} (no Browserless token and Puppeteer not available)`, 'qa', projectId);
    return { pageName, pageUrl: url, desktopUrl: '', tabletUrl: '', mobileUrl: '' };
  }

  await logger.info(`Capturing screenshots for ${pageName}${token ? ' via Browserless.io' : ''}`, 'qa', projectId);

  const viewportResults = await Promise.all(
    VIEWPORTS.map(async (viewport) => {
      try {
        const buffer = await captureViewport(url, viewport.width, viewport.height);
        if (!buffer) return { name: viewport.name, url: '' };
        const publicUrl = await uploadToStorage(projectId, pageName, viewport.name, version, buffer);
        return { name: viewport.name, url: publicUrl };
      } catch (err) {
        await logger.error(
          `Screenshot failed for ${pageName} (${viewport.name}): ${err instanceof Error ? err.message : String(err)}`,
          'qa',
          projectId
        );
        return { name: viewport.name, url: '' };
      }
    })
  );

  const results: Record<string, string> = {};
  for (const vr of viewportResults) {
    results[vr.name] = vr.url;
  }

  await logger.success(`Screenshots captured for ${pageName}`, 'qa', projectId);

  return {
    pageName,
    pageUrl: url,
    desktopUrl: results.desktop || '',
    tabletUrl: results.tablet || '',
    mobileUrl: results.mobile || '',
  };
}

const PAGE_CONCURRENCY = 3;

export async function captureAllPages(
  baseUrl: string,
  pages: { name: string; route: string }[],
  projectId: string,
  version: number = 1
): Promise<ScreenshotResult[]> {
  const results: ScreenshotResult[] = [];

  for (let i = 0; i < pages.length; i += PAGE_CONCURRENCY) {
    const batch = pages.slice(i, i + PAGE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (page) => {
        const url = `${baseUrl.replace(/\/$/, '')}${page.route}`;
        try {
          return await capturePageScreenshots(url, page.name, projectId, version);
        } catch (err) {
          await logger.error(
            `Failed to capture ${page.name}: ${err instanceof Error ? err.message : String(err)}`,
            'qa',
            projectId
          );
          return null;
        }
      })
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  return results;
}

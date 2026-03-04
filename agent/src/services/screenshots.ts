import puppeteer, { Browser } from 'puppeteer';
import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import type { ScreenshotResult } from '../core/types.js';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function captureViewport(
  url: string,
  width: number,
  height: number
): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));

    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    return Buffer.from(screenshot);
  } finally {
    await page.close();
  }
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
  await logger.info(`Capturing screenshots for ${pageName}`, 'qa', projectId);

  const results: Record<string, string> = {};

  for (const viewport of VIEWPORTS) {
    try {
      const buffer = await captureViewport(url, viewport.width, viewport.height);
      const publicUrl = await uploadToStorage(
        projectId,
        pageName,
        viewport.name,
        version,
        buffer
      );
      results[viewport.name] = publicUrl;
    } catch (err) {
      await logger.error(
        `Screenshot failed for ${pageName} (${viewport.name}): ${err instanceof Error ? err.message : String(err)}`,
        'qa',
        projectId
      );
      results[viewport.name] = '';
    }
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

export async function captureAllPages(
  baseUrl: string,
  pages: { name: string; route: string }[],
  projectId: string,
  version: number = 1
): Promise<ScreenshotResult[]> {
  const results: ScreenshotResult[] = [];

  for (const page of pages) {
    const url = `${baseUrl.replace(/\/$/, '')}${page.route}`;
    try {
      const result = await capturePageScreenshots(url, page.name, projectId, version);
      results.push(result);
    } catch (err) {
      await logger.error(
        `Failed to capture ${page.name}: ${err instanceof Error ? err.message : String(err)}`,
        'qa',
        projectId
      );
    }
  }

  return results;
}

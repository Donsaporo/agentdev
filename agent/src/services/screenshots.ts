import { getSupabase } from '../core/supabase.js';
import { getSecretWithFallback } from '../core/secrets.js';
import { logger } from '../core/logger.js';
import type { ScreenshotResult } from '../core/types.js';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

const BROWSERLESS_BASE = 'https://production-sfo.browserless.io';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function getBrowserlessToken(): Promise<string> {
  return getSecretWithFallback('browserless');
}

async function captureWithBrowserless(
  url: string,
  width: number,
  height: number,
  token: string
): Promise<Buffer> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
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
        throw new Error(`Browserless HTTP ${response.status}: ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Screenshot capture failed');
}

export interface BrowserAction {
  type: 'click' | 'navigate' | 'wait' | 'scroll_top' | 'screenshot';
  selector?: string;
  url?: string;
  ms?: number;
}

export interface BrowserAutomationResult {
  consoleErrors: string[];
  navigationWorks: boolean;
  scrollToTopWorks: boolean;
  screenshots: Map<string, Buffer>;
}

export async function runBrowserAutomation(
  baseUrl: string,
  pages: { name: string; route: string }[],
  token: string
): Promise<BrowserAutomationResult> {
  const consoleErrors: string[] = [];
  let navigationWorks = true;
  let scrollToTopWorks = true;
  const screenshots = new Map<string, Buffer>();

  for (const page of pages) {
    const pageUrl = `${baseUrl.replace(/\/$/, '')}${page.route}`;
    try {
      const response = await fetch(`${BROWSERLESS_BASE}/function?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: `
            module.exports = async ({ page }) => {
              const errors = [];
              page.on('console', msg => {
                if (msg.type() === 'error') errors.push(msg.text());
              });
              page.on('pageerror', err => errors.push(err.message));

              await page.setViewport({ width: 1440, height: 900 });
              await page.goto('${pageUrl}', { waitUntil: 'networkidle0', timeout: 30000 });
              await new Promise(r => setTimeout(r, 2000));

              const scrollY = await page.evaluate(() => window.scrollY);
              const hasContent = await page.evaluate(() => document.body.innerText.length > 10);

              return {
                errors,
                scrollY,
                hasContent,
                title: await page.title(),
              };
            };
          `,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.errors?.length > 0) {
          consoleErrors.push(...result.errors.map((e: string) => `[${page.name}] ${e}`));
        }
        if (!result.hasContent) {
          navigationWorks = false;
        }
        if (result.scrollY > 0) {
          scrollToTopWorks = false;
        }
      }
    } catch (err) {
      await logger.warn(
        `Browser automation failed for ${page.name}: ${err instanceof Error ? err.message : String(err)}`,
        'qa'
      );
    }
  }

  return { consoleErrors, navigationWorks, scrollToTopWorks, screenshots };
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

  if (!token) {
    await logger.warn(`Screenshots skipped for ${pageName} (no Browserless token)`, 'qa', projectId);
    return { pageName, pageUrl: url, desktopUrl: '', tabletUrl: '', mobileUrl: '' };
  }

  await logger.info(`Capturing screenshots for ${pageName} via Browserless.io`, 'qa', projectId);

  const viewportResults = await Promise.all(
    VIEWPORTS.map(async (viewport) => {
      try {
        const buffer = await captureWithBrowserless(url, viewport.width, viewport.height, token);
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

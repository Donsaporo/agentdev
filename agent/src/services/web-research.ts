import { env } from '../core/env.js';
import { logger } from '../core/logger.js';

interface PageContent {
  url: string;
  title: string;
  text: string;
  links: string[];
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

async function braveSearch(query: string, count = 5): Promise<BraveSearchResult[]> {
  if (!env.BRAVE_API_KEY) return [];

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': env.BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const results: BraveSearchResult[] = [];

    for (const item of data.web?.results || []) {
      results.push({
        title: item.title || '',
        url: item.url || '',
        description: item.description || '',
      });
    }

    return results;
  } catch {
    return [];
  }
}

export async function fetchPageContent(url: string, projectId?: string): Promise<PageContent | null> {
  try {
    let puppeteer;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      return await fetchWithFetch(url);
    }

    const browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

    const result = await page.evaluate(() => {
      const title = document.title || '';
      const navLinks = Array.from(document.querySelectorAll('nav a, header a')).map(
        (a) => (a as HTMLAnchorElement).href
      );
      const textNodes = document.querySelectorAll('h1, h2, h3, h4, p, li, span, a, button, label');
      const texts: string[] = [];
      textNodes.forEach((el) => {
        const t = el.textContent?.trim();
        if (t && t.length > 2 && t.length < 500) texts.push(t);
      });
      return { title, text: [...new Set(texts)].join('\n'), links: [...new Set(navLinks)] };
    });

    await browser.close();

    await logger.info(`Fetched reference page: ${url}`, 'development', projectId);
    return { url, ...result };
  } catch (err) {
    await logger.error(`Failed to fetch page ${url}: ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
    return await fetchWithFetch(url);
  }
}

async function fetchWithFetch(url: string): Promise<PageContent | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);

    return { url, title, text: textContent, links: [] };
  } catch {
    return null;
  }
}

export function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  const matches = text.match(urlRegex) || [];
  return [...new Set(matches)].filter(
    (url) => !url.includes('supabase.co') && !url.includes('localhost') && !url.endsWith('.')
  );
}

export async function researchReferenceUrls(
  briefContent: string,
  projectId: string,
  clientName?: string,
  industry?: string
): Promise<string[]> {
  const results: string[] = [];

  const urls = extractUrlsFromText(briefContent);
  for (const url of urls.slice(0, 5)) {
    const content = await fetchPageContent(url, projectId);
    if (content) {
      results.push(
        `[Reference: ${content.title || url}]\nURL: ${url}\nNavigation: ${content.links.slice(0, 15).join(', ')}\nContent:\n${content.text.slice(0, 3000)}`
      );
    }
  }

  if (env.BRAVE_API_KEY) {
    const queries: string[] = [];

    if (clientName && industry) {
      queries.push(`${clientName} ${industry} website design inspiration`);
    }

    const integrationKeywords = ['stripe', 'paypal', 'payoneer', 'shopify', 'twilio', 'sendgrid', 'firebase', 'supabase', 'mapbox', 'google maps', 'calendly', 'mailchimp'];
    for (const keyword of integrationKeywords) {
      if (briefContent.toLowerCase().includes(keyword)) {
        queries.push(`${keyword} API documentation integration guide`);
      }
    }

    if (industry) {
      queries.push(`best ${industry} website examples 2025`);
    }

    for (const query of queries.slice(0, 3)) {
      await logger.info(`Searching: "${query}"`, 'research', projectId);
      const searchResults = await braveSearch(query, 3);

      for (const sr of searchResults.slice(0, 2)) {
        const content = await fetchPageContent(sr.url, projectId);
        if (content) {
          results.push(
            `[Search: ${sr.title}]\nURL: ${sr.url}\nSnippet: ${sr.description}\nContent:\n${content.text.slice(0, 2000)}`
          );
        } else {
          results.push(
            `[Search: ${sr.title}]\nURL: ${sr.url}\nSnippet: ${sr.description}`
          );
        }
      }
    }
  }

  if (results.length > 0) {
    await logger.info(`Collected ${results.length} research reference(s)`, 'research', projectId);
  }

  return results;
}

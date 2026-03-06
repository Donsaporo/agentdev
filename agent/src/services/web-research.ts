import * as cheerio from 'cheerio';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';

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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function braveSearch(query: string, count = 5): Promise<BraveSearchResult[]> {
  const braveKey = await getSecretWithFallback('brave');
  if (!braveKey) return [];

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveKey,
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
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    $('script, style, noscript, svg, iframe, nav, footer, header').remove();

    const title = $('title').first().text().trim() ||
      $('h1').first().text().trim() ||
      '';

    const navLinks: string[] = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && (href.startsWith('http') || href.startsWith('/'))) {
        try {
          const resolved = href.startsWith('http') ? href : new URL(href, url).toString();
          navLinks.push(resolved);
        } catch { /* skip invalid urls */ }
      }
    });

    const textParts: string[] = [];
    $('h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, code, article, section, main, div').each((_, el) => {
      const text = $(el).clone().children('h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, code, article, section, main, div').remove().end().text().trim();
      if (text && text.length > 5 && text.length < 1000) {
        textParts.push(text);
      }
    });

    const uniqueText = [...new Set(textParts)].join('\n');

    await logger.info(`Fetched reference page: ${url}`, 'development', projectId);

    return {
      url,
      title,
      text: uniqueText.slice(0, 8000),
      links: [...new Set(navLinks)].slice(0, 30),
    };
  } catch (err) {
    await logger.error(
      `Failed to fetch page ${url}: ${err instanceof Error ? err.message : String(err)}`,
      'development',
      projectId
    );
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

  const hasBrave = !!(await getSecretWithFallback('brave'));
  if (hasBrave) {
    const queries: string[] = [];

    if (clientName && industry) {
      queries.push(`${clientName} ${industry} website design inspiration`);
    }

    const integrationKeywords = [
      'stripe', 'paypal', 'payoneer', 'shopify', 'twilio', 'sendgrid',
      'firebase', 'supabase', 'mapbox', 'google maps', 'calendly', 'mailchimp',
      'banco general', 'banistmo', 'cybersource', 'yappy', 'clave', 'nequi',
      'whatsapp api', 'instagram api', 'facebook api', 'hubspot', 'zoho',
      'woocommerce', 'square', 'mercadopago', 'auth0', 'clerk',
    ];
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

import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';

const API_BASE = 'https://api.namecheap.com/xml.response';

interface DnsRecord {
  hostName: string;
  recordType: string;
  address: string;
  ttl: number;
}

async function namecheapRequest(command: string, params: Record<string, string>): Promise<string> {
  const apiUser = await getSecretWithFallback('namecheap_user') || env.NAMECHEAP_API_USER;
  const apiKey = await getSecretWithFallback('namecheap') || env.NAMECHEAP_API_KEY;
  if (!apiUser || !apiKey) throw new Error('Namecheap credentials not configured');

  const url = new URL(API_BASE);
  url.searchParams.set('ApiUser', apiUser);
  url.searchParams.set('ApiKey', apiKey);
  url.searchParams.set('UserName', apiUser);
  url.searchParams.set('ClientIp', env.NAMECHEAP_CLIENT_IP);
  url.searchParams.set('Command', command);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Namecheap API error: ${res.status} ${res.statusText}`);
  }

  return res.text();
}

function parseDomainParts(domain: string): { sld: string; tld: string } {
  const parts = domain.split('.');
  const tld = parts.pop()!;
  const sld = parts.pop()!;
  return { sld, tld };
}

function parseHostEntry(tag: string): DnsRecord | null {
  const hostMatch = tag.match(/HostName="([^"]*)"/i);
  const typeMatch = tag.match(/RecordType="([^"]*)"/i);
  const addrMatch = tag.match(/Address="([^"]*)"/i);
  const ttlMatch = tag.match(/TTL="([^"]*)"/i);

  if (hostMatch && typeMatch && addrMatch) {
    return {
      hostName: hostMatch[1],
      recordType: typeMatch[1],
      address: addrMatch[1],
      ttl: ttlMatch ? parseInt(ttlMatch[1], 10) : 1800,
    };
  }
  return null;
}

export async function getExistingRecords(domain: string): Promise<DnsRecord[]> {
  const { sld, tld } = parseDomainParts(domain);
  const xml = await namecheapRequest('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });

  const records: DnsRecord[] = [];
  const hostTagRegex = /<host\s[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = hostTagRegex.exec(xml)) !== null) {
    const record = parseHostEntry(tagMatch[0]);
    if (record) records.push(record);
  }

  if (records.length === 0) {
    await logger.warn(
      `DNS XML parse found 0 <host> tags. Raw response (first 1000 chars): ${xml.slice(0, 1000)}`,
      'dns'
    );
  }

  return records;
}

export async function setCnameRecord(
  domain: string,
  subdomain: string,
  target: string,
  projectId: string
): Promise<boolean> {
  try {
    const { sld, tld } = parseDomainParts(domain);
    let existing = await getExistingRecords(domain);

    if (existing.length === 0) {
      await logger.warn(`First DNS fetch returned 0 records for ${domain}. Retrying in 5s...`, 'dns', projectId);
      await new Promise((r) => setTimeout(r, 5000));
      existing = await getExistingRecords(domain);
    }

    await logger.info(
      `DNS backup before CNAME write: ${existing.length} existing records for ${domain}`,
      'dns',
      projectId,
      { records: existing }
    );

    if (existing.length === 0) {
      await logger.warn(
        `getExistingRecords returned 0 records for ${domain} after retry. Aborting CNAME write to prevent record loss.`,
        'dns',
        projectId
      );
      return false;
    }

    const filtered = existing.filter(
      (r) => !(r.hostName.toLowerCase() === subdomain.toLowerCase() && r.recordType === 'CNAME')
    );

    const allRecords = [
      ...filtered,
      { hostName: subdomain, recordType: 'CNAME', address: target, ttl: 1800 },
    ];

    const params: Record<string, string> = { SLD: sld, TLD: tld };
    allRecords.forEach((record, i) => {
      params[`HostName${i + 1}`] = record.hostName;
      params[`RecordType${i + 1}`] = record.recordType;
      params[`Address${i + 1}`] = record.address;
      params[`TTL${i + 1}`] = record.ttl.toString();
    });

    await namecheapRequest('namecheap.domains.dns.setHosts', params);
    await logger.success(`Set CNAME: ${subdomain}.${domain} -> ${target}`, 'dns', projectId);
    return true;
  } catch (err) {
    await logger.error(
      `Failed to set CNAME for ${subdomain}.${domain}: ${err instanceof Error ? err.message : String(err)}`,
      'dns',
      projectId
    );
    return false;
  }
}

export async function verifyDnsPropagation(
  fqdn: string,
  expectedTarget: string
): Promise<boolean> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${fqdn}&type=CNAME`);
    if (!res.ok) return false;

    const data = await res.json();
    if (data.Answer) {
      return data.Answer.some(
        (a: { data: string }) => a.data.replace(/\.$/, '').toLowerCase() === expectedTarget.toLowerCase()
      );
    }
    return false;
  } catch {
    return false;
  }
}

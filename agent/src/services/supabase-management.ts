import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';

const API_BASE = 'https://api.supabase.com';

async function supabaseFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getSecretWithFallback('supabase_management');
  if (!token) throw new Error('Supabase Management API token not configured');

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

export async function createSupabaseProject(
  name: string,
  orgId: string,
  region: string = 'us-east-1',
  projectId: string
): Promise<{ ref: string; id: string }> {
  const dbPass = generateDbPassword();

  const res = await supabaseFetch('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: name.slice(0, 40),
      organization_id: orgId,
      region,
      plan: 'free',
      db_pass: dbPass,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Supabase createProject failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  await logger.success(`Created Supabase project: ${data.name} (${data.id})`, 'supabase', projectId);

  return { ref: data.id, id: data.id };
}

export async function waitForProjectReady(
  projectRef: string,
  projectId: string,
  maxWaitMs: number = 300_000
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const res = await supabaseFetch(`/v1/projects/${projectRef}`);
    if (!res.ok) {
      await logger.warn(`Failed to check Supabase project status: ${res.status}`, 'supabase', projectId);
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    const data = await res.json();
    if (data.status === 'ACTIVE_HEALTHY') {
      await logger.success(`Supabase project ${projectRef} is ready`, 'supabase', projectId);
      return true;
    }

    if (data.status === 'INACTIVE' || data.status === 'REMOVED') {
      throw new Error(`Supabase project ${projectRef} is ${data.status}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Supabase project ${projectRef} timed out waiting for ready state`);
}

export async function getProjectApiKeys(
  projectRef: string,
  projectId: string
): Promise<{ anonKey: string; serviceRoleKey: string }> {
  const res = await supabaseFetch(`/v1/projects/${projectRef}/api-keys`);

  if (!res.ok) {
    throw new Error(`Failed to get API keys for project ${projectRef}: ${res.status}`);
  }

  const keys = await res.json();
  let anonKey = '';
  let serviceRoleKey = '';

  for (const key of keys) {
    if (key.name === 'anon') anonKey = key.api_key;
    if (key.name === 'service_role') serviceRoleKey = key.api_key;
  }

  if (!anonKey || !serviceRoleKey) {
    throw new Error('Could not find API keys for Supabase project');
  }

  await logger.info(`Retrieved API keys for Supabase project ${projectRef}`, 'supabase', projectId);
  return { anonKey, serviceRoleKey };
}

export function getProjectUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}

export async function executeSqlOnProject(
  projectRef: string,
  sql: string,
  projectId: string
): Promise<void> {
  const res = await supabaseFetch(`/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`SQL execution failed on ${projectRef}: ${err.slice(0, 500)}`);
  }

  await logger.info('SQL migration executed on project database', 'supabase', projectId);
}

export async function isManagementAvailable(): Promise<boolean> {
  const token = await getSecretWithFallback('supabase_management');
  return !!token;
}

function generateDbPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  for (const byte of array) {
    result += chars[byte % chars.length];
  }
  return result;
}

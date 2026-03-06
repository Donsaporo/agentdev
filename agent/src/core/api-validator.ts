import { getSecretWithFallback, updateSecretStatus } from './secrets.js';
import { logger } from './logger.js';

interface ValidationResult {
  service: string;
  ok: boolean;
  message: string;
}

async function validateAnthropic(): Promise<ValidationResult> {
  const key = await getSecretWithFallback('anthropic');
  if (!key) return { service: 'anthropic', ok: false, message: 'Not configured' };
  if (!key.startsWith('sk-ant-')) return { service: 'anthropic', ok: false, message: 'Invalid key format' };
  return { service: 'anthropic', ok: true, message: 'Key format valid' };
}

async function validateGitHub(): Promise<ValidationResult> {
  const token = await getSecretWithFallback('github');
  if (!token) return { service: 'github', ok: false, message: 'Not configured' };

  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { service: 'github', ok: false, message: `API returned ${res.status}` };
    const data = await res.json();
    return { service: 'github', ok: true, message: `Authenticated as ${data.login}` };
  } catch (err) {
    return { service: 'github', ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function validateVercel(): Promise<ValidationResult> {
  const token = await getSecretWithFallback('vercel');
  if (!token) return { service: 'vercel', ok: false, message: 'Not configured' };

  try {
    const res = await fetch('https://api.vercel.com/v9/projects?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { service: 'vercel', ok: false, message: `API returned ${res.status}` };
    return { service: 'vercel', ok: true, message: 'Token valid' };
  } catch (err) {
    return { service: 'vercel', ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function validateSupabaseManagement(): Promise<ValidationResult> {
  const token = await getSecretWithFallback('supabase_management');
  if (!token) return { service: 'supabase_management', ok: false, message: 'Not configured' };

  try {
    const res = await fetch('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { service: 'supabase_management', ok: false, message: `API returned ${res.status}` };
    return { service: 'supabase_management', ok: true, message: 'Token valid' };
  } catch (err) {
    return { service: 'supabase_management', ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function validateBrave(): Promise<ValidationResult> {
  const key = await getSecretWithFallback('brave');
  if (!key) return { service: 'brave', ok: false, message: 'Not configured' };

  try {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    });
    if (!res.ok) return { service: 'brave', ok: false, message: `API returned ${res.status}` };
    return { service: 'brave', ok: true, message: 'Key valid' };
  } catch (err) {
    return { service: 'brave', ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function validateResend(): Promise<ValidationResult> {
  const key = await getSecretWithFallback('resend');
  if (!key) return { service: 'resend', ok: false, message: 'Not configured' };

  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { service: 'resend', ok: false, message: `API returned ${res.status}` };
    return { service: 'resend', ok: true, message: 'Key valid' };
  } catch (err) {
    return { service: 'resend', ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function validateAllApis(): Promise<void> {
  const validators = [
    validateAnthropic(),
    validateGitHub(),
    validateVercel(),
    validateSupabaseManagement(),
    validateBrave(),
    validateResend(),
  ];

  const results = await Promise.allSettled(validators);
  const validationResults: ValidationResult[] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { service: 'unknown', ok: false, message: 'Validation threw' }
  );

  const connected = validationResults.filter((r) => r.ok);
  const failed = validationResults.filter((r) => !r.ok && r.message !== 'Not configured');
  const unconfigured = validationResults.filter((r) => r.message === 'Not configured');

  for (const result of validationResults) {
    if (result.message === 'Not configured') continue;
    const status = result.ok ? 'connected' : 'error';
    await updateSecretStatus(result.service, status, result.message).catch(() => {});
  }

  const summary = [
    `API Validation: ${connected.length}/${validationResults.length} connected`,
    failed.length > 0 ? `Failed: ${failed.map((f) => `${f.service} (${f.message})`).join(', ')}` : null,
    unconfigured.length > 0 ? `Not configured: ${unconfigured.map((u) => u.service).join(', ')}` : null,
  ].filter(Boolean).join(' | ');

  console.log(`  ${summary}`);
  await logger.info(summary, 'system', null, {
    results: validationResults.map((r) => ({ service: r.service, ok: r.ok, message: r.message })),
  });
}

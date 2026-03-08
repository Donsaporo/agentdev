import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';
import { withRetry } from '../core/retry.js';
import type { DeploymentResult } from '../core/types.js';

const API_BASE = 'https://api.vercel.com';

async function vercelFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getSecretWithFallback('vercel');
  const teamId = await getSecretWithFallback('vercel_team_id') || env.VERCEL_TEAM_ID;

  if (!token) throw new Error('Vercel token not configured');

  const url = new URL(path, API_BASE);
  if (teamId) {
    url.searchParams.set('teamId', teamId);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  return response;
}

export async function createProject(
  name: string,
  repoFullName: string,
  projectId: string
): Promise<string> {
  const [owner, repo] = repoFullName.split('/');

  const existingRes = await vercelFetch(`/v9/projects/${name}`);
  if (existingRes.ok) {
    const existing = await existingRes.json();
    await logger.info(`Vercel project ${name} already exists, reusing`, 'vercel', projectId);
    return existing.id;
  }

  const res = await vercelFetch('/v10/projects', {
    method: 'POST',
    body: JSON.stringify({
      name,
      framework: 'vite',
      gitRepository: {
        type: 'github',
        repo: `${owner}/${repo}`,
      },
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      installCommand: 'npm install',
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Vercel createProject failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  await logger.success(`Created Vercel project: ${name}`, 'vercel', projectId);

  return data.id;
}

export async function triggerDeployment(
  projectName: string,
  projectId: string
): Promise<DeploymentResult> {
  return withRetry(async () => {
  const res = await vercelFetch('/v13/deployments', {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      target: 'production',
      gitSource: {
        type: 'github',
        ref: 'main',
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Vercel deployment trigger failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  await logger.info(`Deployment triggered: ${data.id}`, 'vercel', projectId);

  return {
    deploymentId: data.id,
    url: `https://${data.url}`,
    status: 'building',
  };
  }, 3, 2000, 'triggerDeployment');
}

export async function waitForDeployment(
  deploymentId: string,
  projectId: string,
  maxWaitMs: number = 300_000
): Promise<DeploymentResult> {
  const startTime = Date.now();
  const pollInterval = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const res = await vercelFetch(`/v13/deployments/${deploymentId}`);
    if (!res.ok) {
      throw new Error(`Failed to check deployment status: ${res.status}`);
    }

    const data = await res.json();
    const state = data.readyState || data.state;

    if (state === 'READY') {
      await logger.success(`Deployment ready: https://${data.url}`, 'vercel', projectId);
      return { deploymentId, url: `https://${data.url}`, status: 'ready' };
    }

    if (state === 'ERROR' || state === 'CANCELED') {
      await logger.error(`Deployment failed: ${state}`, 'vercel', projectId);
      return { deploymentId, url: '', status: 'error', buildLogs: data.errorMessage || '' };
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  await logger.warn('Deployment timed out', 'vercel', projectId);
  return { deploymentId, url: '', status: 'error', buildLogs: 'Deployment timed out' };
}

export async function addDomain(
  vercelProjectId: string,
  domain: string,
  projectId: string
): Promise<boolean> {
  const res = await vercelFetch(`/v10/projects/${vercelProjectId}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
  });

  if (!res.ok) {
    const err = await res.json();
    await logger.error(`Failed to add domain ${domain}: ${JSON.stringify(err)}`, 'vercel', projectId);
    return false;
  }

  await logger.success(`Added domain ${domain} to Vercel project`, 'vercel', projectId);
  return true;
}

export async function setEnvironmentVariables(
  vercelProjectId: string,
  envVars: { key: string; value: string; target?: string[] }[],
  projectId: string
): Promise<void> {
  const body = envVars.map((v) => ({
    key: v.key,
    value: v.value,
    target: v.target || ['production', 'preview', 'development'],
    type: 'encrypted',
  }));

  const res = await vercelFetch(`/v10/projects/${vercelProjectId}/env`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const errStr = JSON.stringify(err);
    if (!errStr.includes('already exists')) {
      await logger.warn(`Failed to set some env vars: ${errStr}`, 'vercel', projectId);
    }
  }

  await logger.info(`Set ${envVars.length} environment variable(s) on Vercel project`, 'vercel', projectId);
}

export async function getDeploymentUrl(vercelProjectId: string): Promise<string | null> {
  const res = await vercelFetch(`/v6/deployments?projectId=${vercelProjectId}&target=production&limit=1`);
  if (!res.ok) return null;

  const data = await res.json();
  if (data.deployments && data.deployments.length > 0) {
    return `https://${data.deployments[0].url}`;
  }
  return null;
}

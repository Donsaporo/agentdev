import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import type { DeploymentResult } from '../core/types.js';

const API_BASE = 'https://api.vercel.com';

async function vercelFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = new URL(path, API_BASE);
  if (env.VERCEL_TEAM_ID) {
    url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${env.VERCEL_TOKEN}`,
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

export async function getDeploymentUrl(vercelProjectId: string): Promise<string | null> {
  const res = await vercelFetch(`/v6/deployments?projectId=${vercelProjectId}&target=production&limit=1`);
  if (!res.ok) return null;

  const data = await res.json();
  if (data.deployments && data.deployments.length > 0) {
    return `https://${data.deployments[0].url}`;
  }
  return null;
}

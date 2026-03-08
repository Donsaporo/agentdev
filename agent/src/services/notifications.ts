import { Resend } from 'resend';
import { getConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let resend: Resend | null = null;
let cachedKey: string = '';

async function getClient(): Promise<Resend | null> {
  const key = await getSecretWithFallback('resend');
  if (!key) return null;
  if (!resend || cachedKey !== key) {
    cachedKey = key;
    resend = new Resend(key);
  }
  return resend;
}

async function sendEmail(subject: string, html: string, projectId?: string): Promise<void> {
  const client = await getClient();
  if (!client) {
    await logger.warn('Resend not configured, skipping email', 'notifications', projectId);
    return;
  }

  const config = await getConfig();

  try {
    await client.emails.send({
      from: 'Obzide Agent <agent@obzide.com>',
      to: config.notification_email,
      subject,
      html,
    });
    await logger.info(`Email sent: ${subject}`, 'notifications', projectId);
  } catch (err) {
    await logger.error(
      `Email failed: ${err instanceof Error ? err.message : String(err)}`,
      'notifications',
      projectId
    );
  }
}

export async function notifyBuildComplete(
  projectName: string,
  demoUrl: string,
  projectId: string
): Promise<void> {
  await sendEmail(
    `Build Complete: ${projectName}`,
    `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">Build Complete</h2>
      <p>The project <strong>${escapeHtml(projectName)}</strong> has been built and deployed successfully.</p>
      <p><a href="${escapeHtml(demoUrl)}" style="display: inline-block; background: #0070f3; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">View Demo</a></p>
      <p style="color: #666; font-size: 14px;">QA screenshots are ready for review in the dashboard.</p>
    </div>`,
    projectId
  );
}

export async function notifyQAReady(
  projectName: string,
  screenshotCount: number,
  projectId: string
): Promise<void> {
  await sendEmail(
    `QA Ready: ${projectName}`,
    `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">QA Screenshots Ready</h2>
      <p><strong>${screenshotCount}</strong> screenshots for <strong>${escapeHtml(projectName)}</strong> are ready for your review.</p>
      <p style="color: #666; font-size: 14px;">Open the dashboard to approve or reject each screenshot.</p>
    </div>`,
    projectId
  );
}

export interface ErrorDiagnostics {
  phase?: string;
  modulesCompleted?: number;
  modulesTotal?: number;
  buildErrors?: number;
  repoUrl?: string;
  durationMinutes?: number;
  strategy?: string;
}

export async function notifyError(
  projectName: string,
  errorMessage: string,
  projectId: string,
  diagnostics?: ErrorDiagnostics
): Promise<void> {
  const diagRows = diagnostics ? [
    diagnostics.phase ? `<tr><td style="padding:4px 8px;color:#666;">Phase</td><td style="padding:4px 8px;font-weight:600;">${diagnostics.phase}</td></tr>` : '',
    diagnostics.modulesCompleted !== undefined ? `<tr><td style="padding:4px 8px;color:#666;">Modules</td><td style="padding:4px 8px;">${diagnostics.modulesCompleted}/${diagnostics.modulesTotal || '?'} completed</td></tr>` : '',
    diagnostics.buildErrors ? `<tr><td style="padding:4px 8px;color:#666;">Build Errors</td><td style="padding:4px 8px;">${diagnostics.buildErrors}</td></tr>` : '',
    diagnostics.strategy ? `<tr><td style="padding:4px 8px;color:#666;">Strategy</td><td style="padding:4px 8px;">${diagnostics.strategy}</td></tr>` : '',
    diagnostics.durationMinutes ? `<tr><td style="padding:4px 8px;color:#666;">Duration</td><td style="padding:4px 8px;">${diagnostics.durationMinutes} min</td></tr>` : '',
    diagnostics.repoUrl ? `<tr><td style="padding:4px 8px;color:#666;">Repo</td><td style="padding:4px 8px;"><a href="${diagnostics.repoUrl}">${diagnostics.repoUrl}</a></td></tr>` : '',
  ].filter(Boolean).join('') : '';

  const diagSection = diagRows
    ? `<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;">${diagRows}</table>`
    : '';

  await sendEmail(
    `Error: ${projectName}`,
    `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626;">Agent Error</h2>
      <p>An error occurred while working on <strong>${escapeHtml(projectName)}</strong>:</p>
      <pre style="background: #f5f5f5; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px;">${escapeHtml(errorMessage.slice(0, 2000))}</pre>
      ${diagSection}
      <p style="color: #666; font-size: 14px;">Check the dashboard activity log for details.</p>
    </div>`,
    projectId
  );
}

export async function notifyDeploySuccess(
  projectName: string,
  deployUrl: string,
  projectId: string
): Promise<void> {
  await sendEmail(
    `Deployed: ${projectName}`,
    `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #16a34a;">Deployment Successful</h2>
      <p><strong>${escapeHtml(projectName)}</strong> has been deployed to production.</p>
      <p><a href="${escapeHtml(deployUrl)}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">View Live Site</a></p>
    </div>`,
    projectId
  );
}

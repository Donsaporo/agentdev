import { Resend } from 'resend';
import { env } from '../core/env.js';
import { getConfig } from '../core/config.js';
import { logger } from '../core/logger.js';

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) {
    resend = new Resend(env.RESEND_API_KEY);
  }
  return resend;
}

async function sendEmail(subject: string, html: string, projectId?: string): Promise<void> {
  const client = getClient();
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
      <p>The project <strong>${projectName}</strong> has been built and deployed successfully.</p>
      <p><a href="${demoUrl}" style="display: inline-block; background: #0070f3; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">View Demo</a></p>
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
      <p><strong>${screenshotCount}</strong> screenshots for <strong>${projectName}</strong> are ready for your review.</p>
      <p style="color: #666; font-size: 14px;">Open the dashboard to approve or reject each screenshot.</p>
    </div>`,
    projectId
  );
}

export async function notifyError(
  projectName: string,
  errorMessage: string,
  projectId: string
): Promise<void> {
  await sendEmail(
    `Error: ${projectName}`,
    `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626;">Agent Error</h2>
      <p>An error occurred while working on <strong>${projectName}</strong>:</p>
      <pre style="background: #f5f5f5; padding: 16px; border-radius: 8px; overflow-x: auto;">${errorMessage}</pre>
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
      <p><strong>${projectName}</strong> has been deployed to production.</p>
      <p><a href="${deployUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">View Live Site</a></p>
    </div>`,
    projectId
  );
}

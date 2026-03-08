import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

import { logger } from './core/logger.js';
import { getConfig } from './core/config.js';
import { loadSecrets } from './core/secrets.js';
import { validateAllApis } from './core/api-validator.js';
import { startListening, startHeartbeat, setEventHandler, markOffline, clearBriefRetries } from './core/event-listener.js';
import { processBrief } from './pipelines/brief-processing.js';
import { handleChatMessage } from './pipelines/chat-response.js';
import { handleQARejection } from './pipelines/qa-correction.js';
import { closeBrowser } from './services/screenshots.js';
import { cleanupStaleCheckpoints } from './core/pipeline-state.js';
import type { QueueEvent } from './core/types.js';

async function handleEvent(event: QueueEvent): Promise<void> {
  switch (event.type) {
    case 'brief_approved':
      await processBrief(event.projectId, event.payload.briefId as string);
      break;

    case 'chat_message':
      await handleChatMessage(
        event.projectId,
        event.payload.conversationId as string,
        event.payload.content as string
      );
      break;

    case 'qa_rejected':
      await handleQARejection(
        event.projectId,
        event.payload.screenshotId as string,
        event.payload.pageName as string,
        event.payload.rejectionNotes as string
      );
      break;
  }
}

async function checkStuckProjects(): Promise<void> {
  const { getSupabase } = await import('./core/supabase.js');
  const supabase = getSupabase();

  const { data: stuck } = await supabase
    .from('projects')
    .select('id, name')
    .eq('agent_status', 'working');

  if (stuck && stuck.length > 0) {
    for (const project of stuck) {
      await logger.warn(
        `Found project stuck in "working" state: ${project.name}. Resetting to idle.`,
        'system',
        project.id
      );
      await supabase.from('projects').update({ agent_status: 'idle' }).eq('id', project.id);
    }
  }

  const { data: stuckBriefs } = await supabase
    .from('briefs')
    .select('id, project_id')
    .eq('status', 'processing');

  if (stuckBriefs && stuckBriefs.length > 0) {
    for (const brief of stuckBriefs) {
      await logger.warn(
        `Found brief stuck in "processing" state: ${brief.id}. Resetting to failed.`,
        'system',
        brief.project_id
      );
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', brief.id);
    }
  }

  clearBriefRetries();
}

async function main(): Promise<void> {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║        OBZIDE DEV AGENT v1.0         ║
  ║   Autonomous Web Development Agent   ║
  ╚═══════════════════════════════════════╝
  `);

  const secrets = await loadSecrets();
  const configuredServices = Array.from(secrets.keys()).filter((k) => secrets.get(k));
  console.log(`  Secrets loaded: ${configuredServices.length} services configured`);
  if (configuredServices.length > 0) {
    console.log(`  Services: ${configuredServices.join(', ')}`);
  }

  const agentConfig = await getConfig();
  await logger.info('Agent starting', 'system', null, {
    model: agentConfig.default_model,
    autoQA: agentConfig.auto_qa,
    autoDeploy: agentConfig.auto_deploy,
    maxCorrections: agentConfig.max_corrections,
    servicesConfigured: configuredServices.length,
  });

  console.log('  Validating API connections...');
  await validateAllApis().catch((err) => {
    console.error('  API validation failed (non-critical):', err);
  });

  await checkStuckProjects();
  await cleanupStaleCheckpoints().catch((err) => {
    console.error('  Stale checkpoint cleanup failed (non-critical):', err);
  });

  setEventHandler(handleEvent);
  startListening();
  const heartbeatInterval = startHeartbeat();

  await logger.success('Agent is online and listening for events', 'system');

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    clearInterval(heartbeatInterval);
    await markOffline();
    await closeBrowser();
    await logger.info('Agent shutting down', 'system');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', async (reason) => {
    await logger.error(
      `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      'system'
    );
  });

  process.on('uncaughtException', async (err) => {
    await logger.error(`Uncaught exception: ${err.message}`, 'system');
    await closeBrowser();
    process.exit(1);
  });
}

main().catch(async (err) => {
  console.error('Fatal error starting agent:', err);
  process.exit(1);
});

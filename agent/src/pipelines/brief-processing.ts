import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import {
  analyzeBrief, generateProjectScaffold, generateModuleCode, groupPagesIntoModules,
  generateDatabaseSchema, generateBuildFix, verifyProjectCompleteness,
  analyzeScreenshotAllViewports,
} from '../services/claude.js';
import { processAttachments } from '../services/file-processing.js';
import { researchReferenceUrls } from '../services/web-research.js';
import { createRepo, pushFiles, getMultipleFileContents, getRepoTree } from '../services/github.js';
import { createProject as createVercelProject, triggerDeployment, waitForDeployment, addDomain, setEnvironmentVariables } from '../services/vercel.js';
import { captureAllPages } from '../services/screenshots.js';
import { verifyBuild, extractBuildErrors, hashErrors, validateScaffold } from '../services/build-verify.js';
import { notifyBuildComplete, notifyQAReady, notifyError, notifyDeploySuccess } from '../services/notifications.js';
import { setCnameRecord } from '../services/namecheap.js';
import {
  createSupabaseProject, waitForProjectReady, getProjectApiKeys,
  getProjectUrl, executeSqlOnProject, isManagementAvailable,
  findExistingProject, executeSqlStatements,
} from '../services/supabase-management.js';
import { saveCheckpoint, clearCheckpoint, recordDeployment, getCheckpoint } from '../core/pipeline-state.js';
import {
  extractExportSignatures, buildExportContext, deduplicateErrors,
  filterRelevantFiles, reconcileAppRoutes, resolveStubPaths,
  generateStubForMissingImport,
} from '../services/build-intelligence.js';
import type { ExportSignature } from '../services/build-intelligence.js';
import type { Brief, Client, Project, FullArchitecture, BuildFixAttempt } from '../core/types.js';

const CORE_FILE_PATTERNS = [
  'app.tsx', 'main.tsx', 'layout', 'navbar', 'footer', 'index.css',
  'tailwind.config', 'supabase', 'types', 'api.ts', 'auth', 'mock-data',
  'package.json', 'vite.config',
];

async function updateProject(
  projectId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('projects').update(updates).eq('id', projectId);
}

async function sendChatMessage(
  projectId: string,
  content: string
): Promise<void> {
  const supabase = getSupabase();
  const { data: conv } = await supabase
    .from('agent_conversations')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let conversationId = conv?.id;
  if (!conversationId) {
    const { data: newConv } = await supabase
      .from('agent_conversations')
      .insert({ project_id: projectId, title: 'Build Log' })
      .select('id')
      .maybeSingle();
    conversationId = newConv?.id;
  }

  if (conversationId) {
    await supabase.from('agent_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content,
      metadata: {},
    });
  }
}

function getCoreFilePaths(allFiles: { path: string; type: string }[]): string[] {
  return allFiles
    .filter((f) => {
      if (f.type !== 'file') return false;
      const lower = f.path.toLowerCase();
      return CORE_FILE_PATTERNS.some((p) => lower.includes(p));
    })
    .map((f) => f.path);
}

export async function processBrief(projectId: string, briefId: string): Promise<void> {
  const supabase = getSupabase();
  const config = await getConfig();

  const checkpoint = await getCheckpoint(projectId);
  const isResuming = !!(checkpoint && checkpoint.brief_id === briefId);
  const CHECKPOINT_TTL_HOURS = 12;

  const checkpointExpired = checkpoint && checkpoint.last_checkpoint
    ? (Date.now() - new Date(checkpoint.last_checkpoint).getTime()) > CHECKPOINT_TTL_HOURS * 60 * 60 * 1000
    : false;

  if (isResuming && !checkpointExpired) {
    await logger.info(
      `Found checkpoint at phase "${checkpoint.current_phase}" for project ${projectId}. Resuming...`,
      'development',
      projectId
    );
    await sendChatMessage(projectId, `Resuming from checkpoint: ${checkpoint.current_phase}. Previous progress preserved.`);
  } else if (isResuming && checkpointExpired) {
    await logger.info('Checkpoint expired (>12h), starting fresh', 'development', projectId);
    await clearCheckpoint(projectId, 'failed');
  }

  const resumePhase = (isResuming && !checkpointExpired) ? checkpoint.current_phase : null;
  const skipAnalysis = resumePhase && ['scaffolding', 'scaffolding_complete', 'backend_setup', 'development', 'completeness_check'].includes(resumePhase);
  const skipScaffolding = resumePhase && ['backend_setup', 'development', 'completeness_check'].includes(resumePhase);
  const skipBackend = resumePhase && ['development', 'completeness_check'].includes(resumePhase);

  try {
    await supabase.from('briefs').update({ status: 'processing' }).eq('id', briefId);
    await updateProject(projectId, { agent_status: 'working', current_phase: 'analysis', status: 'in_progress', last_error_message: null });
    await sendChatMessage(projectId, skipAnalysis ? 'Resuming build from checkpoint...' : 'Starting to process your brief. Analyzing requirements...');

    const { data: brief } = await supabase.from('briefs').select('*').eq('id', briefId).maybeSingle();
    if (!brief) throw new Error(`Brief ${briefId} not found`);

    const { data: project } = await supabase
      .from('projects')
      .select('*, clients(*)')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) throw new Error(`Project ${projectId} not found`);

    const client = project.clients as Client;

    // ============================================================
    // PHASE 1: ANALYSIS (skip if resuming past this phase)
    // ============================================================

    let architecture: FullArchitecture;
    let fullName: string;
    let repoUrl: string;
    const clientSlug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const repoName = `${clientSlug}-${projectSlug}`;

    if (skipAnalysis && brief.architecture_plan && Object.keys(brief.architecture_plan).length > 0) {
      architecture = brief.architecture_plan as unknown as FullArchitecture;
      await logger.info('Skipping analysis -- using existing architecture from checkpoint', 'development', projectId);
    } else {
      const { data: attachments } = await supabase
        .from('brief_attachments')
        .select('file_name, file_url, file_type')
        .eq('brief_id', briefId);

      let attachmentContents: string[] = [];
      if (attachments && attachments.length > 0) {
        await sendChatMessage(projectId, `Processing ${attachments.length} attached file(s)...`);
        const processed = await processAttachments(attachments, projectId);
        attachmentContents = processed.map(p => `[${p.fileName} (${p.fileType})]\n${p.content}`);

        for (const p of processed) {
          await supabase
            .from('brief_attachments')
            .update({ processing_status: 'processed', extracted_content: p.content.slice(0, 10000) })
            .eq('brief_id', briefId)
            .eq('file_name', p.fileName);
        }
      }

      const referenceContents = await researchReferenceUrls(brief.original_content, projectId, client.name, client.industry);
      if (referenceContents.length > 0) {
        await sendChatMessage(projectId, `Analyzed ${referenceContents.length} reference website(s) from the brief.`);
        attachmentContents = [...attachmentContents, ...referenceContents];
      }

      await logger.info('Phase 1: Analyzing brief', 'development', projectId);
      const analysis = await analyzeBrief(brief as Brief, client, project as unknown as Project, attachmentContents);

      if (analysis.questions.length > 0) {
        await supabase.from('briefs').update({
          parsed_requirements: analysis.requirements,
          architecture_plan: analysis.architecture as unknown as Record<string, unknown>,
          questions: analysis.questions.map((q, i) => ({
            id: `q-${i}`,
            question: q.question,
            category: q.category,
            answered: false,
          })),
          status: 'questions_pending',
        }).eq('id', briefId);

        await updateProject(projectId, { agent_status: 'waiting' });
        const questionList = analysis.questions.map((q) => `- ${q.question}`).join('\n');
        await sendChatMessage(projectId, `I have some questions before I can start building:\n\n${questionList}\n\nPlease answer these in the Brief section and send the brief back to me.`);
        await logger.info('Questions sent to team, waiting for answers', 'development', projectId);
        return;
      }

      architecture = analysis.architecture as FullArchitecture;
      const totalPages = (architecture.pages || []).length;

      await supabase.from('briefs').update({
        parsed_requirements: analysis.requirements,
        architecture_plan: architecture as unknown as Record<string, unknown>,
      }).eq('id', briefId);

      await sendChatMessage(projectId, `Analysis complete. Found ${totalPages} pages to build${architecture.requiresBackend ? ' with full backend' : ''}. Setting up the repository...`);
      await saveCheckpoint(projectId, briefId, 'analysis_complete', { totalPages }, [], '');
    }

    // ============================================================
    // PHASE 2: SCAFFOLDING (skip if resuming past this phase)
    // ============================================================

    if (skipScaffolding && checkpoint?.repo_full_name) {
      fullName = checkpoint.repo_full_name;
      repoUrl = `https://github.com/${fullName}`;
      await logger.info(`Skipping scaffolding -- reusing repo ${fullName}`, 'development', projectId);
    } else {
      await updateProject(projectId, { current_phase: 'scaffolding', progress: 5, has_backend: architecture.requiresBackend || false });
      await logger.info('Phase 2: Scaffolding project', 'development', projectId);

      const repoResult = await createRepo(
        repoName,
        `${project.name} - ${client.name} | Built by Obzide Agent`,
        projectId,
        true
      );
      repoUrl = repoResult.repoUrl;
      fullName = repoResult.fullName;
      await updateProject(projectId, { git_repo_url: repoUrl });

      const scaffold = await generateProjectScaffold(
        project as unknown as Project,
        client,
        architecture
      );

      {
        const validation = await validateScaffold(scaffold.files, architecture);
        if (validation.issues.length > 0) {
          await logger.warn(`Scaffold validation: ${validation.issues.join('; ')}`, 'development', projectId);
          for (const fix of validation.fixedFiles) {
            const idx = scaffold.files.findIndex((f) => f.path === fix.path);
            if (idx >= 0) scaffold.files[idx] = fix;
            else scaffold.files.push(fix);
          }
        }
        if (scaffold.files.length > 0) {
          await pushFiles(fullName, scaffold.files, 'Initial scaffold', projectId);
        }
      }

      await updateProject(projectId, { progress: 15 });
      await sendChatMessage(projectId, `Repository created: ${repoUrl}\nScaffold pushed with ${scaffold.files.length} files.`);
      await saveCheckpoint(projectId, briefId, 'scaffolding_complete', {}, [], fullName);
    }

    // ============================================================
    // PHASE 2.5: BACKEND SETUP (skip if resuming past this phase)
    // ============================================================

    if (architecture.requiresBackend && !skipBackend) {
      await updateProject(projectId, { current_phase: 'backend_setup', progress: 18 });
      await logger.info('Phase 2.5: Setting up backend', 'development', projectId);

      const hasManagement = await isManagementAvailable();

      if (hasManagement) {
        try {
          const orgId = config.supabase_org_id || (await import('../core/secrets.js').then(s => s.getSecretWithFallback('supabase_org_id')));
          if (!orgId) throw new Error('Supabase org ID not configured');

          const sbNamePrefix = `obz-${projectSlug}`;
          let sbRef: string | null = null;
          let sbDbPassword: string | null = null;

          const { data: existingProject } = await supabase
            .from('projects')
            .select('supabase_project_ref, supabase_url, supabase_anon_key')
            .eq('id', projectId)
            .maybeSingle();

          if (existingProject?.supabase_project_ref) {
            await sendChatMessage(projectId, 'Reusing existing Supabase database from previous build...');
            sbRef = existingProject.supabase_project_ref;
            await logger.info(`Reusing existing Supabase project: ${sbRef}`, 'development', projectId);
          } else {
            const found = await findExistingProject(sbNamePrefix, projectId);
            if (found && found.status === 'ACTIVE_HEALTHY') {
              sbRef = found.ref;
              await sendChatMessage(projectId, `Found existing Supabase project "${found.name}". Reusing...`);
            } else {
              await sendChatMessage(projectId, 'Creating Supabase database for this project...');
              const sbProject = await createSupabaseProject(
                `${sbNamePrefix}-${projectId.slice(0, 6)}`.slice(0, 40),
                orgId,
                config.supabase_db_region || 'us-east-1',
                projectId
              );
              sbRef = sbProject.ref;
              sbDbPassword = sbProject.dbPassword;

              await sendChatMessage(projectId, 'Waiting for database to be ready...');
              await waitForProjectReady(sbRef, projectId);
            }
          }

          if (!sbRef) throw new Error('Supabase project ref is null after setup');
          const keys = await getProjectApiKeys(sbRef, projectId);
          const sbUrl = getProjectUrl(sbRef);

          const sbUpdate: Record<string, unknown> = {
            supabase_project_ref: sbRef,
            supabase_url: sbUrl,
            supabase_anon_key: keys.anonKey,
            supabase_service_role_key: keys.serviceRoleKey,
          };
          if (sbDbPassword) sbUpdate.supabase_db_password = sbDbPassword;
          await updateProject(projectId, sbUpdate);

          await sendChatMessage(projectId, 'Generating and executing database schema...');
          const MAX_SQL_RETRIES = 2;
          let sqlExecuted = false;

          for (let sqlAttempt = 1; sqlAttempt <= MAX_SQL_RETRIES + 1; sqlAttempt++) {
            const sql = await generateDatabaseSchema(architecture, projectId);
            if (!sql || sql.length < 10) {
              await logger.warn('Empty SQL generated, skipping schema', 'development', projectId);
              break;
            }

            const result = await executeSqlStatements(sbRef, sql, projectId);

            if (result.failed === 0) {
              await logger.success(`Database schema executed: ${result.succeeded} statements`, 'development', projectId);
              sqlExecuted = true;
              break;
            }

            if (result.succeeded > 0 && result.failed <= 2) {
              await logger.info(`Schema partially applied: ${result.succeeded} ok, ${result.failed} failed. Retrying failures...`, 'development', projectId);
              sqlExecuted = true;
              break;
            }

            if (sqlAttempt > MAX_SQL_RETRIES) {
              await sendChatMessage(projectId, `Database schema had ${result.failed} failing statement(s) after ${MAX_SQL_RETRIES + 1} attempts: ${result.errors.slice(0, 3).join('; ')}. ${result.succeeded} statements applied successfully. Continuing.`);
              if (result.succeeded > 0) sqlExecuted = true;
              break;
            }

            await sendChatMessage(projectId, `Schema had ${result.failed} error(s). Regenerating (attempt ${sqlAttempt + 1})...`);
          }

          if (sqlExecuted) {
            await sendChatMessage(projectId, `Database ready: ${sbUrl}`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await logger.warn(`Backend setup failed (will continue without real DB): ${errMsg}`, 'development', projectId);
          await sendChatMessage(projectId, `Note: Could not auto-create Supabase project (${errMsg.slice(0, 300)}). The project will use placeholder env vars - configure them manually in Vercel after deployment.`);
        }
      } else {
        await sendChatMessage(projectId, 'Supabase Management API not configured. The project will use placeholder env vars. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel after deployment.');
        await logger.info('Supabase Management API not available, skipping auto-setup', 'development', projectId);
      }
    }

    // ============================================================
    // PHASE 3: MODULE-BASED DEVELOPMENT
    // ============================================================

    await updateProject(projectId, { current_phase: 'development', progress: 20 });
    await logger.info('Phase 3: Module-based development', 'development', projectId);

    const modules = groupPagesIntoModules(architecture);
    const totalPages = (architecture.pages || []).length;
    await sendChatMessage(projectId, `Starting module-based development: ${modules.length} modules, ${totalPages} total pages.`);

    const moduleTasks: { id: string; module: (typeof modules)[number] }[] = [];
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i];
      const { data: task } = await supabase.from('project_tasks').insert({
        project_id: projectId,
        title: `Build ${mod.name} module (${mod.pages.length} pages)`,
        description: `Module: ${mod.name}\nRole: ${mod.role}\nPages: ${mod.pages.map((p) => p.name).join(', ')}`,
        status: 'pending',
        priority: 2,
        order_index: i,
      }).select('id').maybeSingle();
      if (task) moduleTasks.push({ ...task, module: mod });
    }

    const completedModuleNames = new Set(checkpoint?.modules_completed || []);
    if (completedModuleNames.size > 0) {
      await logger.info(`Skipping ${completedModuleNames.size} already-completed modules from checkpoint`, 'development', projectId);
      for (const mt of moduleTasks) {
        if (completedModuleNames.has(mt.module.name)) {
          await supabase.from('project_tasks').update({ status: 'completed' }).eq('id', mt.id);
        }
      }
    }

    const pendingModuleTasks = moduleTasks.filter((t) => !completedModuleNames.has(t.module.name));
    const priorityModules = ['auth', 'support'];
    const phase1Tasks = pendingModuleTasks.filter((t) => priorityModules.some((p) => t.module.name.toLowerCase().includes(p)));
    const phase2Tasks = pendingModuleTasks.filter((t) => !phase1Tasks.includes(t));

    const MODULE_CONCURRENCY = 1;
    const INTER_BATCH_COOLDOWN_MS = 15_000;
    const MAX_RECOVERY_PASSES = 2;
    const RECOVERY_COOLDOWN_MS = 65_000;
    const ABORT_FAILURE_THRESHOLD = 0.4;
    const completedModuleExports: string[] = [];
    const allExportSignatures: ExportSignature[] = [];

    async function buildModuleBatch(
      tasks: typeof moduleTasks,
      batchLabel: string,
      completedBefore: number
    ): Promise<void> {
      for (let i = 0; i < tasks.length; i += MODULE_CONCURRENCY) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, INTER_BATCH_COOLDOWN_MS));
        }

        const batch = tasks.slice(i, i + MODULE_CONCURRENCY);

        const repoFiles = await getRepoTree(fullName);
        const coreFilePaths = getCoreFilePaths(repoFiles);
        const coreFiles = await getMultipleFileContents(fullName, coreFilePaths.slice(0, 25));
        const allPaths = repoFiles.filter((f) => f.type === 'file').map((f) => f.path);
        const exportContext = buildExportContext(allExportSignatures);

        for (const task of batch) {
          await supabase.from('project_tasks').update({
            status: 'in_progress',
            started_at: new Date().toISOString(),
          }).eq('id', task.id);
        }

        const batchNames = batch.map((t) => t.module.name).join(', ');
        await sendChatMessage(projectId, `Building ${batchLabel}: ${batchNames} [${Math.min(i + MODULE_CONCURRENCY, tasks.length)}/${tasks.length}]...`);

        const batchResults = await Promise.all(
          batch.map(async (task) => {
            const taskStartTime = Date.now();
            try {
              const stubPaths = resolveStubPaths(task.module.pages, allPaths);
              const codeResult = await generateModuleCode(
                task.module,
                project as unknown as Project,
                client,
                architecture,
                coreFiles,
                allPaths,
                exportContext,
                stubPaths
              );

              const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000);
              return { task, files: codeResult.files, durationSeconds, error: null };
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              return { task, files: [], durationSeconds: 0, error: errMsg };
            }
          })
        );

        const allFiles = batchResults.flatMap((r) => r.files);
        if (allFiles.length > 0) {
          await pushFiles(fullName, allFiles, `feat: implement ${batchNames}`, projectId);

          for (const f of allFiles) {
            if (f.path.endsWith('.tsx') || f.path.endsWith('.ts')) {
              completedModuleExports.push(f.path);
            }
          }

          const newSignatures = extractExportSignatures(allFiles);
          allExportSignatures.push(...newSignatures);
        }

        for (const result of batchResults) {
          if (result.error) {
            await supabase.from('project_tasks').update({
              status: 'failed',
              error_log: result.error,
            }).eq('id', result.task.id);
            await logger.error(`Module failed: ${result.task.module.name}: ${result.error}`, 'development', projectId);
          } else {
            await supabase.from('project_tasks').update({
              status: 'completed',
              completed_at: new Date().toISOString(),
              duration_seconds: result.durationSeconds,
            }).eq('id', result.task.id);

            await saveCheckpoint(projectId, briefId, 'development', {},
              [...(checkpoint?.modules_completed || []), result.task.module.name],
              fullName
            );
          }
        }

        const completed = completedBefore + Math.min(i + MODULE_CONCURRENCY, tasks.length);
        const progress = 20 + Math.round((completed / moduleTasks.length) * 45);
        await updateProject(projectId, { progress });
      }
    }

    if (phase1Tasks.length > 0) {
      await buildModuleBatch(phase1Tasks, 'foundation modules', 0);
    }
    if (phase2Tasks.length > 0) {
      await buildModuleBatch(phase2Tasks, 'feature modules', phase1Tasks.length);
    }

    // --- Recovery pass for failed modules ---
    for (let recoveryPass = 1; recoveryPass <= MAX_RECOVERY_PASSES; recoveryPass++) {
      const { data: failedTasks } = await supabase
        .from('project_tasks')
        .select('id, title, description')
        .eq('project_id', projectId)
        .eq('status', 'failed');

      if (!failedTasks || failedTasks.length === 0) break;

      await logger.info(`Recovery pass ${recoveryPass}/${MAX_RECOVERY_PASSES}: retrying ${failedTasks.length} failed module(s)`, 'development', projectId);
      await sendChatMessage(projectId, `Retrying ${failedTasks.length} failed module(s) (recovery pass ${recoveryPass})... Waiting for rate limit window to reset.`);
      await new Promise((r) => setTimeout(r, RECOVERY_COOLDOWN_MS));

      for (const failedTask of failedTasks) {
        const matchingModule = moduleTasks.find((mt) => mt.id === failedTask.id);
        if (!matchingModule) continue;

        await supabase.from('project_tasks').update({
          status: 'in_progress',
          error_log: null,
          started_at: new Date().toISOString(),
        }).eq('id', failedTask.id);

        const repoFiles = await getRepoTree(fullName);
        const coreFilePaths = getCoreFilePaths(repoFiles);
        const coreFiles = await getMultipleFileContents(fullName, coreFilePaths.slice(0, 25));
        const allPaths = repoFiles.filter((f) => f.type === 'file').map((f) => f.path);
        const recoveryExportCtx = buildExportContext(allExportSignatures);
        const recoveryStubPaths = resolveStubPaths(matchingModule.module.pages, allPaths);

        const taskStartTime = Date.now();
        try {
          const codeResult = await generateModuleCode(
            matchingModule.module,
            project as unknown as Project,
            client,
            architecture,
            coreFiles,
            allPaths,
            recoveryExportCtx,
            recoveryStubPaths
          );

          const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000);
          if (codeResult.files.length > 0) {
            await pushFiles(fullName, codeResult.files, `feat: implement ${matchingModule.module.name} (recovery)`, projectId);
            const recoverySigs = extractExportSignatures(codeResult.files);
            allExportSignatures.push(...recoverySigs);
          }
          await supabase.from('project_tasks').update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            duration_seconds: durationSeconds,
          }).eq('id', failedTask.id);
          await logger.info(`Recovery: ${matchingModule.module.name} succeeded`, 'development', projectId);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await supabase.from('project_tasks').update({
            status: 'failed',
            error_log: errMsg,
          }).eq('id', failedTask.id);
          await logger.error(`Recovery: ${matchingModule.module.name} failed again: ${errMsg.slice(0, 200)}`, 'development', projectId);
        }

        await new Promise((r) => setTimeout(r, INTER_BATCH_COOLDOWN_MS));
      }
    }

    // --- Abort threshold check ---
    const { data: finalTaskStates } = await supabase
      .from('project_tasks')
      .select('status')
      .eq('project_id', projectId);

    const totalTasks = finalTaskStates?.length || 0;
    const failedCount = finalTaskStates?.filter((t) => t.status === 'failed').length || 0;

    if (totalTasks > 0 && failedCount / totalTasks > ABORT_FAILURE_THRESHOLD) {
      const failedNames = moduleTasks
        .filter((mt) => finalTaskStates?.find((ft, idx) => idx < moduleTasks.length && ft.status === 'failed'))
        .map((mt) => mt.module.name);

      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await updateProject(projectId, {
        agent_status: 'idle',
        current_phase: 'aborted',
        last_error_message: `Pipeline aborted: ${failedCount}/${totalTasks} modules failed (${Math.round(failedCount / totalTasks * 100)}%)`,
      });
      await sendChatMessage(
        projectId,
        `Pipeline aborted: ${failedCount} of ${totalTasks} modules failed even after recovery attempts. ` +
        `This is above the ${Math.round(ABORT_FAILURE_THRESHOLD * 100)}% threshold. ` +
        `Most likely cause: API rate limits. Please retry later or check your Anthropic rate limit tier.`
      );
      await notifyError(project.name, `Pipeline aborted: ${failedCount}/${totalTasks} modules failed`, projectId);
      await clearCheckpoint(projectId, 'failed');
      return;
    }

    if (failedCount > 0) {
      const { data: stillFailed } = await supabase
        .from('project_tasks')
        .select('title')
        .eq('project_id', projectId)
        .eq('status', 'failed');
      const failedModuleNames = stillFailed?.map((t) => t.title).join(', ') || '';
      await sendChatMessage(projectId, `Warning: ${failedCount} module(s) could not be built: ${failedModuleNames}. Continuing with available modules.`);
    }

    // ============================================================
    // PHASE 3.25: RECONCILE App.tsx ROUTES
    // ============================================================

    try {
      const reconRepoFiles = await getRepoTree(fullName);
      const reconPaths = reconRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);
      const reconciledApp = reconcileAppRoutes(reconPaths, architecture.pages || []);
      if (reconciledApp) {
        await pushFiles(fullName, [reconciledApp], 'fix: reconcile App.tsx routes with actual page files', projectId);
        await logger.info('Reconciled App.tsx routes with actual page files', 'development', projectId);
      }
    } catch (err) {
      await logger.warn(`App.tsx reconciliation failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
    }

    // ============================================================
    // PHASE 3.5: COMPLETENESS CHECK (multi-pass)
    // ============================================================

    await updateProject(projectId, { current_phase: 'completeness_check', progress: 68 });
    await logger.info('Phase 3.5: Completeness verification', 'development', projectId);
    await sendChatMessage(projectId, 'Verifying project completeness...');

    const MAX_COMPLETENESS_PASSES = 2;
    for (let completenessPass = 0; completenessPass < MAX_COMPLETENESS_PASSES; completenessPass++) {
      try {
        const allRepoFiles = await getRepoTree(fullName);
        const allCodePaths = allRepoFiles
          .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
          .map((f) => f.path);
        const allCode = await getMultipleFileContents(fullName, allCodePaths.slice(0, 80));

        const completeness = await verifyProjectCompleteness(architecture, allCode, projectId);
        const totalIssues = completeness.missingFiles.length + completeness.brokenImports.length + completeness.missingRoutes.length;

        if (totalIssues === 0) {
          await sendChatMessage(projectId, completenessPass === 0
            ? 'All pages accounted for. No missing routes or broken imports.'
            : `Completeness verified after ${completenessPass} fix pass(es).`);
          break;
        }

        await sendChatMessage(projectId, `Found ${totalIssues} completeness issue(s) (pass ${completenessPass + 1}). Auto-fixing...`);
        await logger.info(`Completeness issues: ${totalIssues} (${completeness.missingFiles.length} missing, ${completeness.brokenImports.length} broken imports, ${completeness.missingRoutes.length} missing routes)`, 'development', projectId);

        if (completeness.fixFiles.length > 0) {
          await pushFiles(fullName, completeness.fixFiles, `fix: resolve completeness issues (pass ${completenessPass + 1})`, projectId);
        }

        if (completeness.missingFiles.length > 0) {
          const BATCH_SIZE = 5;
          const missingPages = completeness.missingFiles
            .map((f) => f.replace(/^src\/pages\//, '').replace(/\.tsx$/, ''))
            .filter((f) => f.length > 0);

          for (let batchStart = 0; batchStart < missingPages.length; batchStart += BATCH_SIZE) {
            const batch = missingPages.slice(batchStart, batchStart + BATCH_SIZE);
            const batchPages = batch.map((name) => {
              const archPage = (architecture.pages || []).find((p) =>
                p.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
              );
              return archPage || { name, route: `/${name.toLowerCase()}`, description: name, module: 'main' };
            });

            const tempModule = {
              name: `completeness-fix-${batchStart}`,
              pages: batchPages,
              role: 'public',
              description: `Auto-generated missing pages batch ${Math.floor(batchStart / BATCH_SIZE) + 1}`,
            };

            const repoFilesNow = await getRepoTree(fullName);
            const coreFilePaths = getCoreFilePaths(repoFilesNow);
            const coreFiles = await getMultipleFileContents(fullName, coreFilePaths.slice(0, 40));
            const allPaths = repoFilesNow.filter((f) => f.type === 'file').map((f) => f.path);

            try {
              const codeResult = await generateModuleCode(
                tempModule,
                project as unknown as Project,
                client,
                architecture,
                coreFiles,
                allPaths
              );
              if (codeResult.files.length > 0) {
                await pushFiles(fullName, codeResult.files, `fix: generate missing pages (${batch.join(', ')})`, projectId);
              }
            } catch (err) {
              await logger.warn(`Failed to generate missing pages batch: ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
            }

            if (batchStart + BATCH_SIZE < missingPages.length) {
              await new Promise((r) => setTimeout(r, 5000));
            }
          }
        }
      } catch (err) {
        await logger.warn(`Completeness check failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
        break;
      }
    }

    // ============================================================
    // BUILD VERIFICATION (with cycle detection)
    // ============================================================

    await sendChatMessage(projectId, 'Verifying build before deployment...');
    await logger.info('Verifying build', 'development', projectId);
    await updateProject(projectId, { progress: 72 });

    let buildPassed = false;
    const previousAttempts: BuildFixAttempt[] = [];
    const strategies: Array<'standard' | 'simplify' | 'regenerate'> = ['standard', 'simplify', 'regenerate', 'simplify', 'regenerate'];
    let duplicateCount = 0;

    for (let attempt = 1; attempt <= config.max_corrections + 1; attempt++) {
      const buildResult = await verifyBuild(fullName, projectId);
      if (buildResult.success) {
        buildPassed = true;
        await sendChatMessage(projectId, attempt === 1 ? 'Build verified successfully.' : `Build verified after ${attempt - 1} fix(es).`);
        break;
      }

      if (attempt > config.max_corrections) break;

      const rawBuildErrors = extractBuildErrors(buildResult.errors || buildResult.output);
      const buildErrors = deduplicateErrors(rawBuildErrors);
      const errorHash = hashErrors(buildErrors);

      const isDuplicate = previousAttempts.some((a) => a.errorHash === errorHash);
      let forceOpus = false;
      let strategy = strategies[Math.min(attempt - 1, strategies.length - 1)];

      if (isDuplicate) {
        duplicateCount++;
        forceOpus = true;
        strategy = duplicateCount >= 2 ? 'regenerate' : 'simplify';
        await sendChatMessage(projectId, `Same errors persisting. Switching to ${strategy} strategy with Opus model...`);
        await logger.warn(`Duplicate error hash #${duplicateCount}, escalating to Opus + ${strategy}`, 'development', projectId);
      }

      previousAttempts.push({
        errorHash,
        attempt,
        errorsText: buildErrors.slice(0, 10).join('\n'),
      });

      await sendChatMessage(projectId, `Build failed (attempt ${attempt}/${config.max_corrections}): ${rawBuildErrors.length} error(s) (${buildErrors.length} root causes). Auto-fixing (${strategy})...`);

      const allRepoFiles = await getRepoTree(fullName);
      const allCodePaths = allRepoFiles
        .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
        .map((f) => f.path);
      const allCode = await getMultipleFileContents(fullName, allCodePaths.slice(0, 60));

      const relevantFiles = filterRelevantFiles(allCode, buildErrors);
      await logger.info(`Build fix context: ${relevantFiles.length}/${allCode.length} relevant files`, 'development', projectId);

      const fixResult = await generateBuildFix(
        buildErrors,
        (buildResult.errors || buildResult.output).slice(0, 5000),
        project as unknown as Project,
        client,
        architecture as unknown as Record<string, unknown>,
        relevantFiles,
        previousAttempts,
        attempt,
        config.max_corrections,
        { forceOpus, strategy }
      );

      if (fixResult.files.length > 0) {
        await pushFiles(fullName, fixResult.files, `fix: resolve build errors (attempt ${attempt}, ${strategy})`, projectId);
      } else {
        const stubs = buildErrors
          .map((e) => generateStubForMissingImport(e, allCodePaths))
          .filter((s): s is NonNullable<typeof s> => s !== null);

        if (stubs.length > 0) {
          await pushFiles(fullName, stubs, `fix: generate stubs for missing modules (attempt ${attempt})`, projectId);
          await logger.info(`Generated ${stubs.length} stub(s) for missing imports`, 'development', projectId);
          continue;
        }

        const reconPaths = allRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);
        const reconciledApp = reconcileAppRoutes(reconPaths, architecture.pages || []);
        if (reconciledApp) {
          await pushFiles(fullName, [reconciledApp], `fix: re-reconcile App.tsx routes (attempt ${attempt})`, projectId);
          await logger.info('Re-reconciled App.tsx as fallback fix', 'development', projectId);
          continue;
        }

        await logger.warn('No fix generated and no fallback available, stopping build loop', 'development', projectId);
        break;
      }
    }

    if (!buildPassed) {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await updateProject(projectId, { agent_status: 'idle', last_error_message: 'Build failed after max correction attempts' });
      await sendChatMessage(projectId, `Build failed after ${config.max_corrections} attempts. The repo is available at ${repoUrl} for manual fixes.`);
      await notifyError(project.name, 'Build failed after max correction attempts', projectId);
      return;
    }

    if (!config.auto_deploy) {
      await supabase.from('briefs').update({ status: 'completed' }).eq('id', briefId);
      await updateProject(projectId, { status: 'review', progress: 100, agent_status: 'idle', current_phase: 'deployment' });
      await sendChatMessage(projectId, `Build verified successfully. Auto-deploy is disabled. Repo: ${repoUrl}\nReady for manual deployment.`);
      await notifyBuildComplete(project.name, repoUrl, projectId);
      await logger.success('Brief processing complete (deploy skipped per config)', 'development', projectId);
      return;
    }

    // ============================================================
    // PHASE 4: DEPLOYMENT
    // ============================================================

    await updateProject(projectId, { current_phase: 'deployment', progress: 80 });
    await logger.info('Phase 4: Deploying to Vercel', 'deployment', projectId);
    await sendChatMessage(projectId, 'Deploying to Vercel...');

    const vercelProjectId = await createVercelProject(repoName, fullName, projectId);
    await updateProject(projectId, { vercel_project_id: vercelProjectId });

    if (architecture.requiresBackend) {
      const { data: freshProject } = await supabase
        .from('projects')
        .select('supabase_url, supabase_anon_key')
        .eq('id', projectId)
        .maybeSingle();

      if (freshProject?.supabase_url) {
        await setEnvironmentVariables(vercelProjectId, [
          { key: 'VITE_SUPABASE_URL', value: freshProject.supabase_url },
          { key: 'VITE_SUPABASE_ANON_KEY', value: freshProject.supabase_anon_key || '' },
        ], projectId);
        await logger.info('Set Supabase env vars on Vercel project', 'deployment', projectId);
      }
    }

    const deployStartTime = Date.now();
    const deployment = await triggerDeployment(repoName, projectId);
    const result = await waitForDeployment(deployment.deploymentId, projectId);
    const deployDuration = Math.round((Date.now() - deployStartTime) / 1000);

    await recordDeployment(
      projectId,
      deployment.deploymentId,
      '',
      result.url || '',
      result.status === 'ready' ? 'ready' : 'error',
      deployDuration,
      'auto',
      result.buildLogs || ''
    );

    if (result.status !== 'ready') {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await updateProject(projectId, { agent_status: 'idle', last_error_message: result.buildLogs || 'Deployment failed' });
      await sendChatMessage(projectId, `Deployment failed: ${result.buildLogs || 'Unknown error'}. Check the logs.`);
      await notifyError(project.name, result.buildLogs || 'Deployment failed', projectId);
      await clearCheckpoint(projectId, 'failed');
      return;
    }

    await updateProject(projectId, { demo_url: result.url, progress: 90 });
    await sendChatMessage(projectId, `Deployed successfully: ${result.url}`);
    await notifyDeploySuccess(project.name, result.url, projectId);

    // Custom domain setup
    const demoSubdomain = clientSlug;
    const demoDomain = `${demoSubdomain}.obzide.com`;
    const cnameSet = await setCnameRecord('obzide.com', demoSubdomain, 'cname.vercel-dns.com', projectId);
    if (cnameSet) {
      const domainAdded = await addDomain(vercelProjectId, demoDomain, projectId);
      if (domainAdded) {
        const { data: existingDomain } = await supabase
          .from('domains')
          .select('id')
          .eq('project_id', projectId)
          .eq('domain_name', demoDomain)
          .maybeSingle();

        if (!existingDomain) {
          await supabase.from('domains').insert({
            project_id: projectId,
            client_id: project.client_id,
            domain_name: demoDomain,
            subdomain: demoSubdomain,
            is_demo: true,
            dns_status: 'propagating',
            ssl_status: 'pending',
            registrar: 'namecheap',
          }).maybeSingle();
        }
        await sendChatMessage(projectId, `Custom domain configured: ${demoDomain}`);
      }
    }

    // ============================================================
    // PHASE 5: QA
    // ============================================================

    const pages = architecture.pages || [];

    if (config.auto_qa && result.url) {
      await updateProject(projectId, { current_phase: 'qa' });
      await logger.info('Phase 5: Multi-viewport QA', 'qa', projectId);
      await sendChatMessage(projectId, 'Running multi-viewport QA (desktop, tablet, mobile)...');

      let qaVersion = 1;
      let screenshotResults = await captureAllPages(
        result.url,
        pages.map((p) => ({ name: p.name, route: p.route })),
        projectId,
        qaVersion
      );

      for (let qaAttempt = 0; qaAttempt < config.max_corrections; qaAttempt++) {
        const failedPages: { pageName: string; issues: string[]; score: number }[] = [];

        for (const ss of screenshotResults) {
          const pageArch = pages.find((p) => p.name === ss.pageName);
          const qaResult = await analyzeScreenshotAllViewports(
            { desktop: ss.desktopUrl, tablet: ss.tabletUrl, mobile: ss.mobileUrl },
            ss.pageName,
            pageArch?.description || ss.pageName,
            projectId
          );

          if (!qaResult.overallPass) {
            const allIssues = qaResult.viewports.flatMap(
              (v) => v.issues.map((issue) => `[${v.viewport}] ${issue}`)
            );
            failedPages.push({ pageName: ss.pageName, issues: allIssues, score: qaResult.overallScore });
          }
        }

        if (failedPages.length === 0) {
          await sendChatMessage(projectId, qaAttempt === 0
            ? 'All pages passed multi-viewport QA on first try.'
            : `All pages passed multi-viewport QA after ${qaAttempt} correction(s).`);
          break;
        }

        if (qaAttempt === config.max_corrections - 1) {
          const summary = failedPages.map((fp) => `${fp.pageName} (${fp.score}/100)`).join(', ');
          await sendChatMessage(projectId, `${failedPages.length} page(s) still have issues after ${config.max_corrections} attempts: ${summary}. Sending to human QA.`);
          break;
        }

        await sendChatMessage(projectId, `${failedPages.length} page(s) failed QA. Auto-correcting (round ${qaAttempt + 1})...`);

        const qaRepoFiles = await getRepoTree(fullName);
        const qaCodePaths = qaRepoFiles
          .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
          .map((f) => f.path);
        const qaCode = await getMultipleFileContents(fullName, qaCodePaths.slice(0, 60));

        const issueDescription = failedPages
          .map((fp) => `${fp.pageName} (score: ${fp.score}/100):\n${fp.issues.map((i) => `  - ${i}`).join('\n')}`)
          .join('\n\n');

        const fixResult = await generateBuildFix(
          failedPages.flatMap((fp) => fp.issues),
          issueDescription,
          project as unknown as Project,
          client,
          architecture as unknown as Record<string, unknown>,
          qaCode,
          [],
          qaAttempt + 1,
          config.max_corrections
        );

        if (fixResult.files.length > 0) {
          await pushFiles(fullName, fixResult.files, `fix: multi-viewport QA corrections (round ${qaAttempt + 1})`, projectId);
          const redeploy = await triggerDeployment(repoName, projectId);
          const redeployResult = await waitForDeployment(redeploy.deploymentId, projectId);

          if (redeployResult.status === 'ready') {
            await updateProject(projectId, { demo_url: redeployResult.url });
            qaVersion++;
            screenshotResults = await captureAllPages(
              redeployResult.url,
              pages.map((p) => ({ name: p.name, route: p.route })),
              projectId,
              qaVersion
            );
          } else {
            await logger.warn('Redeploy failed during QA correction', 'qa', projectId);
            break;
          }
        } else {
          break;
        }
      }

      for (const ss of screenshotResults) {
        await supabase.from('qa_screenshots').insert({
          project_id: projectId,
          page_name: ss.pageName,
          page_url: ss.pageUrl,
          desktop_url: ss.desktopUrl,
          tablet_url: ss.tabletUrl,
          mobile_url: ss.mobileUrl,
          status: 'pending',
          version_number: qaVersion,
        });
      }

      await updateProject(projectId, { status: 'qa', progress: 100, agent_status: 'idle' });
      await sendChatMessage(projectId, `QA screenshots ready for human review. ${screenshotResults.length} pages captured across 3 viewports.`);
      await notifyBuildComplete(project.name, result.url, projectId);
      await notifyQAReady(project.name, screenshotResults.length, projectId);
    } else {
      await updateProject(projectId, { status: 'review', progress: 100, agent_status: 'idle' });
      await sendChatMessage(projectId, 'Build complete. Auto-QA is disabled, project is ready for manual review.');
      await notifyBuildComplete(project.name, result.url, projectId);
    }

    await supabase.from('briefs').update({ status: 'completed' }).eq('id', briefId);
    await clearCheckpoint(projectId, 'completed');
    await logger.success('Brief processing pipeline complete', 'development', projectId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await logger.error(`Brief processing failed: ${errMsg}`, 'development', projectId);
      await updateProject(projectId, { agent_status: 'idle', last_error_message: errMsg });
      await sendChatMessage(projectId, `An error occurred: ${errMsg}`);
      await clearCheckpoint(projectId, 'failed');
      const { data: proj } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle();
      if (proj) await notifyError(proj.name, errMsg, projectId);
    } catch (innerErr) {
      console.error('Error in brief-processing catch block:', innerErr);
      try { await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId); } catch { /* ignore */ }
      try { await supabase.from('projects').update({ agent_status: 'idle', last_error_message: errMsg }).eq('id', projectId); } catch { /* ignore */ }
    }
  }
}

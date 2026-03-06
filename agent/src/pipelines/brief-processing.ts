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
} from '../services/supabase-management.js';
import { saveCheckpoint, clearCheckpoint, recordDeployment, getCheckpoint } from '../core/pipeline-state.js';
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

  const existingCheckpoint = await getCheckpoint(projectId);
  if (existingCheckpoint && existingCheckpoint.brief_id === briefId) {
    await logger.info(
      `Found checkpoint at phase "${existingCheckpoint.current_phase}" for project ${projectId}. Resuming...`,
      'development',
      projectId
    );
    await sendChatMessage(projectId, `Resuming from checkpoint: ${existingCheckpoint.current_phase}. Previous progress preserved.`);
  }

  try {
    await supabase.from('briefs').update({ status: 'processing' }).eq('id', briefId);
    await updateProject(projectId, { agent_status: 'working', current_phase: 'analysis', status: 'in_progress', last_error_message: null });
    await sendChatMessage(projectId, 'Starting to process your brief. Analyzing requirements...');

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
    // PHASE 1: ANALYSIS
    // ============================================================

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

    const architecture = analysis.architecture as FullArchitecture;
    const totalPages = (architecture.pages || []).length;

    await supabase.from('briefs').update({
      parsed_requirements: analysis.requirements,
      architecture_plan: architecture as unknown as Record<string, unknown>,
    }).eq('id', briefId);

    await sendChatMessage(projectId, `Analysis complete. Found ${totalPages} pages to build${architecture.requiresBackend ? ' with full backend' : ''}. Setting up the repository...`);
    await saveCheckpoint(projectId, briefId, 'analysis_complete', { totalPages }, [], '');

    // ============================================================
    // PHASE 2: SCAFFOLDING
    // ============================================================

    await updateProject(projectId, { current_phase: 'scaffolding', progress: 5, has_backend: architecture.requiresBackend || false });
    await logger.info('Phase 2: Scaffolding project', 'development', projectId);

    const clientSlug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const repoName = `${clientSlug}-${projectSlug}`;

    const { repoUrl, fullName } = await createRepo(
      repoName,
      `${project.name} - ${client.name} | Built by Obzide Agent`,
      projectId
    );
    await updateProject(projectId, { git_repo_url: repoUrl });

    const scaffold = await generateProjectScaffold(
      project as unknown as Project,
      client,
      architecture
    );

    if (scaffold.files.length > 0) {
      const validation = await validateScaffold(scaffold.files);
      if (validation.issues.length > 0) {
        await logger.warn(`Scaffold validation: ${validation.issues.join('; ')}`, 'development', projectId);
        for (const fix of validation.fixedFiles) {
          const idx = scaffold.files.findIndex((f) => f.path === fix.path);
          if (idx >= 0) scaffold.files[idx] = fix;
          else scaffold.files.push(fix);
        }
      }
      await pushFiles(fullName, scaffold.files, 'Initial scaffold', projectId);
    }

    await updateProject(projectId, { progress: 15 });
    await sendChatMessage(projectId, `Repository created: ${repoUrl}\nScaffold pushed with ${scaffold.files.length} files.`);
    await saveCheckpoint(projectId, briefId, 'scaffolding_complete', {}, [], fullName);

    // ============================================================
    // PHASE 2.5: BACKEND SETUP (if needed)
    // ============================================================

    if (architecture.requiresBackend) {
      await updateProject(projectId, { current_phase: 'backend_setup', progress: 18 });
      await logger.info('Phase 2.5: Setting up backend', 'development', projectId);

      const hasManagement = await isManagementAvailable();

      if (hasManagement) {
        await sendChatMessage(projectId, 'Creating Supabase database for this project...');

        try {
          const orgId = config.supabase_org_id || (await import('../core/secrets.js').then(s => s.getSecretWithFallback('supabase_org_id')));
          if (!orgId) throw new Error('Supabase org ID not configured');

          const sbProject = await createSupabaseProject(
            `obz-${projectSlug}`.slice(0, 40),
            orgId,
            config.supabase_db_region || 'us-east-1',
            projectId
          );

          await sendChatMessage(projectId, 'Waiting for database to be ready...');
          await waitForProjectReady(sbProject.ref, projectId);

          const keys = await getProjectApiKeys(sbProject.ref, projectId);
          const sbUrl = getProjectUrl(sbProject.ref);

          await updateProject(projectId, {
            supabase_project_ref: sbProject.ref,
            supabase_url: sbUrl,
            supabase_anon_key: keys.anonKey,
            supabase_service_role_key: keys.serviceRoleKey,
            supabase_db_password: sbProject.dbPassword,
          });

          await sendChatMessage(projectId, 'Generating and executing database schema...');
          const sql = await generateDatabaseSchema(architecture, projectId);

          if (sql && sql.length > 10) {
            await executeSqlOnProject(sbProject.ref, sql, projectId);
            await logger.success('Database schema executed', 'development', projectId);
          }

          await sendChatMessage(projectId, `Database ready: ${sbUrl}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await logger.warn(`Backend setup failed (will continue without real DB): ${errMsg}`, 'development', projectId);
          await sendChatMessage(projectId, `Note: Could not auto-create Supabase project (${errMsg}). The project will use placeholder env vars - configure them manually in Vercel after deployment.`);
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
    await sendChatMessage(projectId, `Starting module-based development: ${modules.length} modules, ${totalPages} total pages.`);

    const moduleTasks = [];
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

    const priorityModules = ['auth', 'support'];
    const phase1Tasks = moduleTasks.filter((t) => priorityModules.some((p) => t.module.name.toLowerCase().includes(p)));
    const phase2Tasks = moduleTasks.filter((t) => !phase1Tasks.includes(t));

    const MODULE_CONCURRENCY = 2;

    async function buildModuleBatch(
      tasks: typeof moduleTasks,
      batchLabel: string,
      completedBefore: number
    ): Promise<void> {
      for (let i = 0; i < tasks.length; i += MODULE_CONCURRENCY) {
        const batch = tasks.slice(i, i + MODULE_CONCURRENCY);

        const repoFiles = await getRepoTree(fullName);
        const coreFilePaths = getCoreFilePaths(repoFiles);
        const coreFiles = await getMultipleFileContents(fullName, coreFilePaths.slice(0, 30));
        const allPaths = repoFiles.filter((f) => f.type === 'file').map((f) => f.path);

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
              const codeResult = await generateModuleCode(
                task.module,
                project as unknown as Project,
                client,
                architecture,
                coreFiles,
                allPaths
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

    // ============================================================
    // PHASE 3.5: COMPLETENESS CHECK
    // ============================================================

    await updateProject(projectId, { current_phase: 'completeness_check', progress: 68 });
    await logger.info('Phase 3.5: Completeness verification', 'development', projectId);
    await sendChatMessage(projectId, 'Verifying project completeness...');

    try {
      const allRepoFiles = await getRepoTree(fullName);
      const allCodePaths = allRepoFiles
        .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
        .map((f) => f.path);
      const allCode = await getMultipleFileContents(fullName, allCodePaths.slice(0, 60));

      const completeness = await verifyProjectCompleteness(architecture, allCode, projectId);

      const totalIssues = completeness.missingFiles.length + completeness.brokenImports.length + completeness.missingRoutes.length;

      if (totalIssues > 0) {
        await sendChatMessage(projectId, `Found ${totalIssues} completeness issue(s). Auto-fixing...`);
        await logger.info(`Completeness issues: ${totalIssues} (${completeness.missingFiles.length} missing, ${completeness.brokenImports.length} broken imports, ${completeness.missingRoutes.length} missing routes)`, 'development', projectId);

        if (completeness.fixFiles.length > 0) {
          await pushFiles(fullName, completeness.fixFiles, 'fix: resolve completeness issues (missing routes, broken imports)', projectId);
        }
      } else {
        await sendChatMessage(projectId, 'All pages accounted for. No missing routes or broken imports.');
      }
    } catch (err) {
      await logger.warn(`Completeness check failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
    }

    // ============================================================
    // BUILD VERIFICATION (with cycle detection)
    // ============================================================

    await sendChatMessage(projectId, 'Verifying build before deployment...');
    await logger.info('Verifying build', 'development', projectId);
    await updateProject(projectId, { progress: 72 });

    let buildPassed = false;
    const previousAttempts: BuildFixAttempt[] = [];

    for (let attempt = 1; attempt <= config.max_corrections + 1; attempt++) {
      const buildResult = await verifyBuild(fullName, projectId);
      if (buildResult.success) {
        buildPassed = true;
        await sendChatMessage(projectId, attempt === 1 ? 'Build verified successfully.' : `Build verified after ${attempt - 1} fix(es).`);
        break;
      }

      if (attempt > config.max_corrections) break;

      const buildErrors = extractBuildErrors(buildResult.errors || buildResult.output);
      const errorHash = hashErrors(buildErrors);

      const isDuplicate = previousAttempts.some((a) => a.errorHash === errorHash);
      if (isDuplicate) {
        await sendChatMessage(projectId, `Same errors persisting after fix attempt. Escalating to more powerful model...`);
        await logger.warn('Duplicate error hash detected, escalating', 'development', projectId);
      }

      previousAttempts.push({
        errorHash,
        attempt,
        errorsText: buildErrors.slice(0, 10).join('\n'),
      });

      await sendChatMessage(projectId, `Build failed (attempt ${attempt}/${config.max_corrections}): ${buildErrors.length} error(s). Auto-fixing...`);

      const allRepoFiles = await getRepoTree(fullName);
      const allCodePaths = allRepoFiles
        .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
        .map((f) => f.path);
      const allCode = await getMultipleFileContents(fullName, allCodePaths.slice(0, 60));

      const fixResult = await generateBuildFix(
        buildErrors,
        (buildResult.errors || buildResult.output).slice(0, 5000),
        project as unknown as Project,
        client,
        architecture as unknown as Record<string, unknown>,
        allCode,
        previousAttempts,
        attempt,
        config.max_corrections
      );

      if (fixResult.files.length > 0) {
        await pushFiles(fullName, fixResult.files, `fix: resolve build errors (attempt ${attempt})`, projectId);
      } else {
        await logger.warn('No fix generated, stopping build loop', 'development', projectId);
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

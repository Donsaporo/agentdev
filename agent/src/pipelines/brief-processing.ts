import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import {
  analyzeBrief, generateProjectScaffold, generateModuleCode, groupPagesIntoModules,
  generateDatabaseSchema, generateBuildFix, verifyProjectCompleteness,
  analyzeScreenshotAllViewports, fixFailedSqlStatements, generateAutoQAFix,
  CreditExhaustedError,
} from '../services/claude.js';
import { processAttachments } from '../services/file-processing.js';
import { researchReferenceUrls } from '../services/web-research.js';
import { createRepo, pushFiles, getMultipleFileContents, getRepoTree, getFileContent } from '../services/github.js';
import { createProject as createVercelProject, triggerDeployment, waitForDeployment, addDomain, setEnvironmentVariables, VercelConfigError } from '../services/vercel.js';
import { captureAllPages } from '../services/screenshots.js';
import { verifyBuild, extractBuildErrors, hashErrors, validateScaffold, areAllErrorsTypeOnly, generateTsNoCheckFiles, preFlightCheck, classifyBuildError, cleanupBuildDir } from '../services/build-verify.js';
import { sanitizePackageJson } from '../services/scaffold-templates.js';
import { notifyBuildComplete, notifyQAReady, notifyError, notifyDeploySuccess } from '../services/notifications.js';
import type { ErrorDiagnostics } from '../services/notifications.js';
import { setCnameRecord } from '../services/namecheap.js';
import {
  createSupabaseProject, waitForProjectReady, getProjectApiKeys,
  getProjectUrl, isManagementAvailable,
  findExistingProject, executeSqlStatements,
} from '../services/supabase-management.js';
import { saveCheckpoint, clearCheckpoint, recordDeployment, getCheckpoint } from '../core/pipeline-state.js';
import {
  extractExportSignatures, buildExportContext, deduplicateErrors,
  filterRelevantFiles, reconcileAppRoutes, resolveStubPaths,
  generateStubForMissingImport, validateModuleImports, rewriteAliasImports,
  sanitizeLucideImports,
} from '../services/build-intelligence.js';
import type { ExportSignature } from '../services/build-intelligence.js';
import {
  selectPathsWithinBudget, CONTEXT_BUDGETS,
} from '../core/token-counter.js';
import type { Brief, Client, Project, FullArchitecture, BuildFixAttempt, GeneratedFile } from '../core/types.js';

const CORE_FILE_PATTERNS = [
  'app.tsx', 'main.tsx', 'layout', 'navbar', 'footer', 'index.css',
  'tailwind.config', 'postcss.config', 'tsconfig', 'index.html',
  'lib/supabase', 'lib/types', 'lib/api', 'lib/mock-data',
  'contexts/auth', 'hooks/useauth',
  'package.json', 'vite.config',
];

function sliceBuildOutput(output: string, budget: number): string {
  if (output.length <= budget) return output;
  const lines = output.split('\n');
  const headLines: string[] = [];
  const tailLines: string[] = [];
  const half = Math.floor(budget / 2) - 40;
  let headLen = 0;
  for (const line of lines) {
    if (headLen + line.length + 1 > half) break;
    headLines.push(line);
    headLen += line.length + 1;
  }
  let tailLen = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tailLen + lines[i].length + 1 > half) break;
    tailLines.unshift(lines[i]);
    tailLen += lines[i].length + 1;
  }
  return headLines.join('\n') + '\n\n... [truncated middle] ...\n\n' + tailLines.join('\n');
}

const PIPELINE_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const SCAFFOLD_BUILD_GATE_ATTEMPTS = 4;
const SCAFFOLD_RETRY_GATE_ATTEMPTS = 3;
const MAX_COMPLETENESS_PASSES = 1;
const COMPLETENESS_BATCH_SIZE = 5;
const COMPLETENESS_INTER_BATCH_DELAY_MS = 5000;
const LARGE_PROJECT_PAGE_THRESHOLD = 30;
const BUILD_OUTPUT_CONTEXT_SLICE = 15000;
const INTERMEDIATE_BUILD_OUTPUT_SLICE = 12000;
const MAX_SQL_FIX_PASSES = 2;
const SQL_FIX_DELAY_MS = 3000;

async function updateProject(
  projectId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('projects').update(updates).eq('id', projectId);
  if (error) {
    await logger.warn(`Failed to update project ${projectId}: ${error.message}`, 'pipeline', projectId);
  }
}

async function sendChatMessage(
  projectId: string,
  content: string
): Promise<void> {
  const supabase = getSupabase();
  try {
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
  } catch (err) {
    await logger.warn(`Failed to send chat message: ${err instanceof Error ? err.message : String(err)}`, 'pipeline', projectId);
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

async function validateAndPush(
  repoFullName: string,
  files: GeneratedFile[],
  commitMessage: string,
  projectId: string,
  allFilePaths: string[]
): Promise<string> {
  let processed = rewriteAliasImports(files);
  processed = sanitizeLucideImports(processed);

  const pkgFile = processed.find((f) => f.path === 'package.json');
  if (pkgFile) {
    const { sanitized, issues } = sanitizePackageJson(pkgFile.content);
    if (issues.length > 0) {
      await logger.warn(`validateAndPush: sanitized package.json: ${issues.join('; ')}`, 'development', projectId);
      pkgFile.content = sanitized;
    }
  }

  const { stubs, warnings } = validateModuleImports(processed, allFilePaths);
  if (warnings.length > 0) {
    await logger.warn(`Import validation: ${warnings.length} unresolved import(s) -- generating stubs`, 'development', projectId);
  }

  const filesToPush = [...processed, ...stubs];
  return pushFiles(repoFullName, filesToPush, commitMessage, projectId);
}

function checkPipelineTimeout(startTime: number): void {
  if (Date.now() - startTime > PIPELINE_MAX_DURATION_MS) {
    throw new Error(`Pipeline timeout: exceeded ${PIPELINE_MAX_DURATION_MS / (60 * 60 * 1000)}h maximum duration`);
  }
}

function programmaticCompletenessCheck(
  architecture: FullArchitecture,
  repoFilePaths: string[],
  appTsxContent: string | null,
  coveredPageNames?: Set<string>
): { missingPageFiles: string[]; brokenImports: string[]; missingRoutes: string[] } {
  const pageFiles = repoFilePaths.filter((f) => f.startsWith('src/pages/') && /\.(tsx?|jsx?)$/.test(f));
  const pageFileNormalized = new Set(
    pageFiles.map((f) => f.replace(/^src\/pages\//, '').replace(/\.(tsx?|jsx?)$/, '').toLowerCase().replace(/[^a-z0-9]/g, ''))
  );

  const missingPageFiles: string[] = [];
  const pageFileKeys = Array.from(pageFileNormalized);
  for (const page of (architecture.pages || [])) {
    const normalized = page.name.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (coveredPageNames?.has(normalized)) continue;

    if (pageFileNormalized.has(normalized)) continue;

    const substringMatch = pageFileKeys.some(
      (key) => key.includes(normalized) || normalized.includes(key)
    );
    if (substringMatch) continue;

    const partials = page.name.split(/[\s/]+/).map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const partialMatch = partials.length > 1 && partials.some(
      (partial) => partial.length >= 3 && pageFileKeys.some((key) => key.includes(partial) || partial.includes(key))
    );
    if (partialMatch) continue;

    missingPageFiles.push(page.name);
  }

  const brokenImports: string[] = [];
  const missingRoutes: string[] = [];

  if (appTsxContent) {
    const importRegex = /import\s+\w+\s+from\s+['"]\.\/pages\/([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(appTsxContent)) !== null) {
      const importPath = match[1];
      const candidates = [
        `src/pages/${importPath}`,
        `src/pages/${importPath}.tsx`,
        `src/pages/${importPath}.ts`,
        `src/pages/${importPath}/index.tsx`,
        `src/pages/${importPath}/index.ts`,
      ];
      const exists = candidates.some((c) => repoFilePaths.includes(c));
      if (!exists) {
        brokenImports.push(`src/pages/${importPath}`);
      }
    }

    for (const page of (architecture.pages || [])) {
      if (page.route) {
        const routePattern = new RegExp(`["'\`]${page.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`);
        if (!routePattern.test(appTsxContent)) {
          missingRoutes.push(`${page.name} (${page.route})`);
        }
      }
    }
  }

  return { missingPageFiles, brokenImports, missingRoutes };
}

interface BuildGateResult {
  passed: boolean;
  errorsRemaining: number;
  attemptsUsed: number;
  lastStrategy?: string;
  attempts: BuildFixAttempt[];
  lastCleanSha?: string;
}

async function buildGate(
  fullName: string,
  projectId: string,
  project: Project,
  client: Client,
  architecture: FullArchitecture,
  maxAttempts: number,
  phaseName: string,
  inheritedAttempts?: BuildFixAttempt[]
): Promise<BuildGateResult> {
  const previousAttempts: BuildFixAttempt[] = inheritedAttempts ? [...inheritedAttempts] : [];
  const strategies: Array<'standard' | 'simplify' | 'regenerate' | 'isolate'> = [
    'standard', 'standard', 'simplify', 'simplify', 'regenerate', 'regenerate', 'isolate', 'isolate',
  ];
  let duplicateCount = 0;
  let lastUsedStrategy = 'standard';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const buildResult = await verifyBuild(fullName, projectId);
    if (buildResult.success) {
      return { passed: true, errorsRemaining: 0, attemptsUsed: attempt, attempts: previousAttempts };
    }

    if (buildResult.isEnvironmentError) {
      await logger.error(
        `[${phaseName}] System-level environment error (permissions/disk/memory): ${(buildResult.errors || '').slice(0, 200)}. Cannot proceed with build verification.`,
        'development',
        projectId,
      );
      return { passed: false, errorsRemaining: 1, attemptsUsed: attempt, lastStrategy: 'environment_skip', attempts: previousAttempts };
    }

    const rawBuildErrorsCheck = extractBuildErrors(buildResult.errors || buildResult.output);
    const errorCategory = classifyBuildError(rawBuildErrorsCheck);
    if (errorCategory === 'config') {
      await logger.info(`[${phaseName}] Config error detected, replacing config files with templates`, 'development', projectId);
      const { getAllTemplateFiles } = await import('../services/scaffold-templates.js');
      const templateFiles = getAllTemplateFiles(project.name, architecture);
      const configOnly = templateFiles.filter((f) =>
        f.path.includes('vite.config') || f.path.includes('postcss.config') ||
        f.path.includes('tailwind.config') || f.path.includes('tsconfig')
      );
      if (configOnly.length > 0) {
        await pushFiles(fullName, configOnly, `fix: replace config files with templates (${phaseName})`, projectId);
        continue;
      }
    }

    if (attempt === maxAttempts) {
      const rawErrors = extractBuildErrors(buildResult.errors || buildResult.output);
      const dedupedFinal = deduplicateErrors(rawErrors);
      await logger.warn(
        `[${phaseName}] Build gate exhausted (${maxAttempts} attempts). ${dedupedFinal.length} root cause(s): ${dedupedFinal[0]?.slice(0, 300) || 'unknown'}`,
        'development',
        projectId,
        { errors: dedupedFinal.slice(0, 10), rawErrorCount: rawErrors.length, attempts: previousAttempts.length }
      );
      return { passed: false, errorsRemaining: dedupedFinal.length, attemptsUsed: attempt, lastStrategy: lastUsedStrategy, attempts: previousAttempts };
    }

    const rawBuildErrors = extractBuildErrors(buildResult.errors || buildResult.output);
    const buildErrors = deduplicateErrors(rawBuildErrors);
    const errorHash = hashErrors(buildErrors);

    const isDuplicate = previousAttempts.some((a) => a.errorHash === errorHash);
    let forceOpus = false;
    let strategy = strategies[Math.min(attempt - 1, strategies.length - 1)];

    if (rawBuildErrors.length > 500) {
      strategy = 'isolate';
      forceOpus = true;
    } else if (rawBuildErrors.length > 100) {
      strategy = attempt <= 2 ? 'simplify' : 'regenerate';
    }

    if (isDuplicate) {
      duplicateCount++;
      forceOpus = true;
      strategy = duplicateCount >= 3 ? 'isolate' : duplicateCount >= 2 ? 'regenerate' : 'simplify';
    }

    lastUsedStrategy = strategy;

    await logger.info(
      `[${phaseName}] Build fix attempt ${attempt}/${maxAttempts} (${strategy}): ${buildErrors.length} root cause(s) | ${buildErrors[0]?.slice(0, 200) || 'no error text'}`,
      'development',
      projectId,
      { errors: buildErrors.slice(0, 10), strategy, errorHash, rawErrorCount: rawBuildErrors.length, isDuplicate }
    );

    const allRepoFiles = await getRepoTree(fullName);
    const buildFixCodeFiles = allRepoFiles.filter(
      (f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path)
    );
    const buildFixPathsBudgeted = selectPathsWithinBudget(
      buildFixCodeFiles,
      CONTEXT_BUDGETS.buildFix,
      CORE_FILE_PATTERNS
    );
    const allCode = await getMultipleFileContents(fullName, buildFixPathsBudgeted);
    const relevantFiles = filterRelevantFiles(allCode, buildErrors, CONTEXT_BUDGETS.buildFix);
    const allFilePathsList = allRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);

    previousAttempts.push({
      errorHash,
      attempt,
      errorsText: buildErrors.slice(0, 10).join('\n'),
      strategy,
    });

    const fixResult = await generateBuildFix(
      buildErrors,
      sliceBuildOutput(buildResult.errors || buildResult.output, BUILD_OUTPUT_CONTEXT_SLICE),
      project,
      client,
      architecture as unknown as Record<string, unknown>,
      relevantFiles,
      previousAttempts,
      attempt,
      maxAttempts,
      { forceOpus, strategy, allFilePaths: allFilePathsList }
    );

    if (fixResult.files.length > 0) {
      const lastAttempt = previousAttempts[previousAttempts.length - 1];
      if (lastAttempt) {
        lastAttempt.filesModified = fixResult.files.map((f) => f.path);
      }

      const fixTouchesApp = fixResult.files.some((f) => f.path === 'src/App.tsx');
      const preFixContents = await getMultipleFileContents(
        fullName,
        fixResult.files.map((f) => f.path).filter((p) => allFilePathsList.includes(p))
      );

      await validateAndPush(fullName, fixResult.files, `fix: ${phaseName} build errors (attempt ${attempt}, ${strategy})`, projectId, allFilePathsList);

      if (fixTouchesApp) {
        const gateReconFiles = await getRepoTree(fullName);
        const gateReconPaths = gateReconFiles.filter((f) => f.type === 'file').map((f) => f.path);
        const gateReconApp = await getFileContent(fullName, 'src/App.tsx');
        const gateReconciled = reconcileAppRoutes(gateReconPaths, architecture.pages || [], gateReconApp || undefined);
        if (gateReconciled) {
          await pushFiles(fullName, [gateReconciled], `fix: re-reconcile App.tsx after build fix (${phaseName})`, projectId);
        }
      }

      const postFixBuild = await verifyBuild(fullName, projectId);
      if (!postFixBuild.success) {
        const postFixRawErrors = extractBuildErrors(postFixBuild.errors || postFixBuild.output);
        const postFixDeduped = deduplicateErrors(postFixRawErrors);
        const preFixDeduped = buildErrors;
        if (postFixDeduped.length > preFixDeduped.length && preFixContents.length > 0) {
          await logger.warn(`[${phaseName}] Fix made errors worse (${preFixDeduped.length} -> ${postFixDeduped.length} root causes). Rolling back.`, 'development', projectId);
          await pushFiles(
            fullName,
            preFixContents.map((f) => ({ path: f.path, content: f.content })),
            `revert: rollback ${phaseName} fix attempt ${attempt} (errors increased)`,
            projectId
          );
        }
      }
    } else {
      const stubs = buildErrors
        .map((e) => generateStubForMissingImport(e, allFilePathsList))
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (stubs.length > 0) {
        await pushFiles(fullName, stubs, `fix: generate stubs for missing modules (${phaseName}, attempt ${attempt})`, projectId);
        continue;
      }

      const reconPaths = allRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);
      const fallbackAppContent = await getFileContent(fullName, 'src/App.tsx');
      const reconciledApp = reconcileAppRoutes(reconPaths, architecture.pages || [], fallbackAppContent || undefined);
      if (reconciledApp) {
        await pushFiles(fullName, [reconciledApp], `fix: re-reconcile App.tsx routes (${phaseName}, attempt ${attempt})`, projectId);
        continue;
      }

      await logger.warn(`[${phaseName}] No fix generated, stopping build gate`, 'development', projectId);
      const remaining = extractBuildErrors(buildResult.errors || buildResult.output);
      return { passed: false, errorsRemaining: remaining.length, attemptsUsed: attempt, lastStrategy: lastUsedStrategy, attempts: previousAttempts };
    }
  }

  return { passed: false, errorsRemaining: -1, attemptsUsed: maxAttempts, lastStrategy: lastUsedStrategy, attempts: previousAttempts };
}

export async function processBrief(projectId: string, briefId: string): Promise<void> {
  const supabase = getSupabase();
  const config = await getConfig();
  const pipelineStart = Date.now();

  let checkpoint = await getCheckpoint(projectId);
  const isResuming = !!(checkpoint && checkpoint.brief_id === briefId);
  const CHECKPOINT_TTL_HOURS = 12;

  const checkpointExpired = checkpoint && checkpoint.last_checkpoint
    ? (Date.now() - new Date(checkpoint.last_checkpoint).getTime()) > CHECKPOINT_TTL_HOURS * 60 * 60 * 1000
    : false;

  if (isResuming && !checkpointExpired) {
    await logger.info(
      `Found checkpoint at phase "${checkpoint!.current_phase}" for project ${projectId}. Resuming...`,
      'development',
      projectId
    );
    await sendChatMessage(projectId, `Resuming from checkpoint: ${checkpoint!.current_phase}. Previous progress preserved.`);
  } else if (isResuming && checkpointExpired) {
    await logger.info('Checkpoint expired (>12h), starting fresh', 'development', projectId);
    await clearCheckpoint(projectId, 'failed');
    checkpoint = null;
  }

  const resumePhase = (isResuming && !checkpointExpired) ? checkpoint!.current_phase : null;
  const skipAnalysis = resumePhase && ['scaffolding', 'scaffolding_complete', 'backend_setup', 'development', 'completeness_check', 'build_verified'].includes(resumePhase);
  const skipScaffolding = resumePhase && ['backend_setup', 'development', 'completeness_check', 'build_verified'].includes(resumePhase);
  const skipBackend = resumePhase && ['development', 'completeness_check', 'build_verified'].includes(resumePhase);
  const skipToBuildVerified = resumePhase === 'build_verified';

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
    // PHASE 1: ANALYSIS
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

    checkPipelineTimeout(pipelineStart);

    // ============================================================
    // PHASE 2: SCAFFOLDING
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

        const scaffoldPaths = scaffold.files.map((f) => f.path);
        const preflight = preFlightCheck(scaffold.files, scaffoldPaths);
        if (!preflight.passed) {
          await logger.warn(`Pre-flight check: ${preflight.issues.join('; ')}`, 'development', projectId);
          for (const fix of preflight.fixes) {
            const idx = scaffold.files.findIndex((f) => f.path === fix.path);
            if (idx >= 0) scaffold.files[idx] = fix;
            else scaffold.files.push(fix);
          }
        }

        const pkgFile = scaffold.files.find((f) => f.path === 'package.json');
        if (pkgFile) {
          const { sanitized, issues: pkgIssues } = sanitizePackageJson(pkgFile.content);
          if (pkgIssues.length > 0) {
            await logger.warn(`Final package.json sanitization: ${pkgIssues.join('; ')}`, 'development', projectId);
            pkgFile.content = sanitized;
          }
        }

        await logger.info('Verifying scaffold builds before pushing...', 'development', projectId);
        const localBuild = await verifyBuild('', projectId, scaffold.files);
        if (!localBuild.success) {
          const localErrors = extractBuildErrors(localBuild.errors || localBuild.output);
          const localCategory = localBuild.isEnvironmentError ? 'environment' : classifyBuildError(localErrors);

          if (localCategory === 'environment') {
            await logger.warn(`Local build env issue: ${(localBuild.errors || '').slice(0, 200)}. Applying stubs as precaution before pushing.`, 'development', projectId);
            const scaffoldPaths2 = scaffold.files.map((f) => f.path);
            const { stubs: envStubs } = validateModuleImports(scaffold.files, scaffoldPaths2);
            if (envStubs.length > 0) {
              scaffold.files.push(...envStubs);
              await logger.info(`Added ${envStubs.length} stub(s) as precaution`, 'development', projectId);
            }
          } else if (localCategory === 'code') {
            await logger.warn(`Local build has code errors. Applying stubs before pushing...`, 'development', projectId);
            const scaffoldPaths2 = scaffold.files.map((f) => f.path);
            const { stubs: localStubs } = validateModuleImports(scaffold.files, scaffoldPaths2);
            if (localStubs.length > 0) {
              scaffold.files.push(...localStubs);
              await logger.info(`Added ${localStubs.length} stub(s) to fix imports`, 'development', projectId);
            }
          } else {
            await logger.warn(`Local build failed (${localCategory}): ${(localBuild.errors || '').slice(0, 200)}. Applying stubs before pushing.`, 'development', projectId);
            const scaffoldPaths2 = scaffold.files.map((f) => f.path);
            const { stubs: fallbackStubs } = validateModuleImports(scaffold.files, scaffoldPaths2);
            if (fallbackStubs.length > 0) {
              scaffold.files.push(...fallbackStubs);
              await logger.info(`Added ${fallbackStubs.length} stub(s) to fix imports`, 'development', projectId);
            }
          }
        } else {
          await logger.info('Local build passed! Pushing to GitHub...', 'development', projectId);
        }

        if (scaffold.files.length > 0) {
          const finalPaths = scaffold.files.map((f) => f.path);
          await validateAndPush(fullName, scaffold.files, 'Initial scaffold', projectId, finalPaths);
        }
      }

      await updateProject(projectId, { progress: 15 });
      await sendChatMessage(projectId, `Repository created: ${repoUrl}\nScaffold pushed with ${scaffold.files.length} files.`);
      await saveCheckpoint(projectId, briefId, 'scaffolding_complete', {}, checkpoint?.modules_completed || [], fullName);
    }

    // ============================================================
    // PHASE 2.5: BACKEND SETUP
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
          let sqlExecuted = false;

          const sql = await generateDatabaseSchema(architecture, projectId);
          if (!sql || sql.length < 10) {
            await logger.warn('Empty SQL generated, skipping schema', 'development', projectId);
          } else {
            const result = await executeSqlStatements(sbRef, sql, projectId);

            if (result.failed === 0) {
              await logger.success(`Database schema executed: ${result.succeeded} statements`, 'development', projectId);
              sqlExecuted = true;
            } else if (result.succeeded > 0) {
              sqlExecuted = true;

              let remainingFailures = result.failedStatements.filter(
                (f) => !f.error.includes('already exists') && !f.error.includes('Timed out')
              );

              for (let fixPass = 1; fixPass <= MAX_SQL_FIX_PASSES && remainingFailures.length > 0; fixPass++) {
                await sendChatMessage(projectId, `Schema had ${remainingFailures.length} error(s). Generating targeted fixes (pass ${fixPass})...`);
                await logger.info(`SQL fix pass ${fixPass}: ${remainingFailures.length} failed statements to fix`, 'development', projectId);

                await new Promise((r) => setTimeout(r, SQL_FIX_DELAY_MS));

                const fixSql = await fixFailedSqlStatements(remainingFailures, architecture, projectId);
                if (!fixSql || fixSql.length < 10) {
                  await logger.warn('Empty fix SQL generated, stopping fix passes', 'development', projectId);
                  break;
                }

                const fixResult = await executeSqlStatements(sbRef, fixSql, projectId);
                await logger.info(`SQL fix pass ${fixPass}: ${fixResult.succeeded} fixed, ${fixResult.failed} still failing`, 'development', projectId);

                remainingFailures = fixResult.failedStatements.filter(
                  (f) => !f.error.includes('already exists') && !f.error.includes('Timed out')
                );
              }

              if (remainingFailures.length > 0) {
                await sendChatMessage(projectId, `Database schema: ${result.succeeded} statements applied. ${remainingFailures.length} non-critical statement(s) could not be fixed. Continuing.`);
              } else {
                await logger.success(`Database schema fully applied after fix passes`, 'development', projectId);
              }
            } else {
              await sendChatMessage(projectId, `Database schema failed entirely (${result.errors.slice(0, 2).join('; ')}). Continuing without database.`);
            }
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

    await saveCheckpoint(projectId, briefId, 'backend_complete', {}, checkpoint?.modules_completed || [], fullName);

    // ============================================================
    // PHASE 2.75: SCAFFOLD BUILD GATE
    // ============================================================

    {
      await logger.info('Verifying scaffold builds before module generation...', 'development', projectId);
      await updateProject(projectId, { current_phase: 'scaffold_verification', progress: 19 });
      const scaffoldGate = await buildGate(
        fullName, projectId, project as unknown as Project, client, architecture,
        SCAFFOLD_BUILD_GATE_ATTEMPTS, 'scaffold'
      );
      if (scaffoldGate.passed) {
        await logger.info('Scaffold build verified successfully', 'development', projectId);
      } else if (scaffoldGate.lastStrategy === 'environment_skip') {
        await logger.warn('Scaffold build skipped (environment issue, not code). Relying on Vercel build.', 'development', projectId);
        await sendChatMessage(projectId, 'Local build environment unavailable. Continuing -- Vercel will handle the build.');
      } else {
        await sendChatMessage(projectId, `Scaffold failed to compile after 4 attempts (${scaffoldGate.errorsRemaining} errors). Regenerating scaffold from scratch...`);
        await logger.warn('Scaffold build gate failed. Regenerating scaffold...', 'development', projectId);

        const newScaffold = await generateProjectScaffold(project as unknown as Project, client, architecture);
        const regenValidation = await validateScaffold(newScaffold.files, architecture);
        for (const fix of regenValidation.fixedFiles) {
          const idx = newScaffold.files.findIndex((f) => f.path === fix.path);
          if (idx >= 0) newScaffold.files[idx] = fix;
          else newScaffold.files.push(fix);
        }
        if (newScaffold.files.length > 0) {
          const regenPaths = newScaffold.files.map((f) => f.path);
          await validateAndPush(fullName, newScaffold.files, 'fix: regenerate scaffold from scratch', projectId, regenPaths);
        }

        {
          const repoTree = await getRepoTree(fullName);
          const tsFiles = repoTree.filter((f) => f.type === 'file' && /\.(tsx?|jsx?)$/.test(f.path)).map((f) => f.path);
          const tsContents = await getMultipleFileContents(fullName, tsFiles);
          const rewritten = rewriteAliasImports(tsContents.map((f) => ({ path: f.path, content: f.content })));
          const changed = rewritten.filter((r) => {
            const original = tsContents.find((o) => o.path === r.path);
            return original && original.content !== r.content;
          });
          if (changed.length > 0) {
            await pushFiles(fullName, changed, 'fix: rewrite @/ alias imports across codebase', projectId);
            await logger.info(`Rewrote @/ aliases in ${changed.length} file(s)`, 'development', projectId);
          }
        }

        const retryGate = await buildGate(
          fullName, projectId, project as unknown as Project, client, architecture,
          SCAFFOLD_RETRY_GATE_ATTEMPTS, 'scaffold-retry',
          scaffoldGate.attempts
        );
        if (retryGate.passed) {
          await logger.info('Scaffold build verified after regeneration', 'development', projectId);
        } else {
          await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
          await updateProject(projectId, {
            agent_status: 'idle',
            current_phase: 'failed',
            last_error_message: `Scaffold failed to compile after regeneration (${retryGate.errorsRemaining} errors). Cannot proceed with module generation.`,
          });
          await sendChatMessage(projectId, `Scaffold failed to compile after two full generation attempts (${retryGate.errorsRemaining} errors remaining). The repository is available at https://github.com/${fullName} for manual inspection. Please review the brief and retry.`);
          await notifyError(project.name, `Scaffold build failed: ${retryGate.errorsRemaining} errors after 7 fix attempts`, projectId, {
            phase: 'scaffold_verification',
            repoUrl: `https://github.com/${fullName}`,
            durationMinutes: Math.round((Date.now() - pipelineStart) / 60000),
          });
          await clearCheckpoint(projectId, 'failed');
          return;
        }
      }
    }

    checkPipelineTimeout(pipelineStart);

    const completedModuleExports: string[] = [];
    const allExportSignatures: ExportSignature[] = [];
    let modulesSinceLastBuildCheck = 0;
    let cumulativeIntermediateErrors = 0;

    if (skipToBuildVerified) {
      await logger.info('Skipping to deployment -- build already verified from checkpoint', 'development', projectId);
      await sendChatMessage(projectId, 'Build already verified. Resuming at deployment...');
    }

    if (!skipToBuildVerified) {
    // ============================================================
    // PHASE 2.8: EXTRACT SCAFFOLD EXPORTS
    // ============================================================

    {
      const scaffoldTree = await getRepoTree(fullName);
      const scaffoldTsFiles = scaffoldTree
        .filter((f) => f.type === 'file' && /\.(tsx?|jsx?)$/.test(f.path) && f.path.startsWith('src/'))
        .map((f) => f.path);
      const scaffoldContents = await getMultipleFileContents(fullName, scaffoldTsFiles);
      const scaffoldSigs = extractExportSignatures(scaffoldContents.map((f) => ({ path: f.path, content: f.content })));
      for (const sig of scaffoldSigs) {
        if (!allExportSignatures.some((s) => s.path === sig.path)) {
          allExportSignatures.push(sig);
        }
      }
      await logger.info(`Extracted ${scaffoldSigs.length} export signatures from scaffold`, 'development', projectId);
    }

    // ============================================================
    // PHASE 3: MODULE-BASED DEVELOPMENT
    // ============================================================

    await updateProject(projectId, { current_phase: 'development', progress: 20 });
    await logger.info('Phase 3: Module-based development', 'development', projectId);

    const modules = groupPagesIntoModules(architecture);
    const totalPages = (architecture.pages || []).length;
    await sendChatMessage(projectId, `Starting module-based development: ${modules.length} modules, ${totalPages} total pages.`);

    const isLargeProject = totalPages > LARGE_PROJECT_PAGE_THRESHOLD;
    if (isLargeProject) {
      await logger.info(`Large project detected (${totalPages} pages). Using conservative build intervals.`, 'development', projectId);
    }

    const moduleTasks: { id: string; module: (typeof modules)[number] }[] = [];

    const { data: existingTasks } = await supabase
      .from('project_tasks')
      .select('id, title, status')
      .eq('project_id', projectId);

    const existingTaskMap = new Map(
      (existingTasks || []).map((t) => [t.title, t])
    );

    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i];
      const taskTitle = `Build ${mod.name} module (${mod.pages.length} pages)`;
      const existing = existingTaskMap.get(taskTitle);

      if (existing) {
        moduleTasks.push({ id: existing.id, module: mod });
      } else {
        const { data: task } = await supabase.from('project_tasks').insert({
          project_id: projectId,
          title: taskTitle,
          description: `Module: ${mod.name}\nRole: ${mod.role}\nPages: ${mod.pages.map((p) => p.name).join(', ')}`,
          status: 'pending',
          priority: 2,
          order_index: i,
        }).select('id').maybeSingle();
        if (task) moduleTasks.push({ ...task, module: mod });
      }
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

    if (checkpoint?.phase_data) {
      const pd = checkpoint.phase_data as Record<string, unknown>;
      if (Array.isArray(pd.exportSignatures)) {
        for (const sig of pd.exportSignatures as ExportSignature[]) {
          if (sig.path && !allExportSignatures.some((s) => s.path === sig.path)) {
            allExportSignatures.push(sig);
          }
        }
      }
      if (typeof pd.cumulativeIntermediateErrors === 'number') {
        cumulativeIntermediateErrors = pd.cumulativeIntermediateErrors;
      }
      if (typeof pd.modulesSinceLastBuildCheck === 'number') {
        modulesSinceLastBuildCheck = pd.modulesSinceLastBuildCheck;
      }
      if (Array.isArray(pd.completedModuleExportPaths)) {
        for (const p of pd.completedModuleExportPaths as string[]) {
          if (!completedModuleExports.includes(p)) completedModuleExports.push(p);
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
    const ABORT_FAILURE_THRESHOLD = 0.25;
    const INTERMEDIATE_BUILD_CHECK_INTERVAL = isLargeProject ? 2 : 3;
    const ERROR_BUDGET_THRESHOLD = 30;

    async function buildModuleBatch(
      tasks: typeof moduleTasks,
      batchLabel: string,
      completedBefore: number
    ): Promise<void> {
      for (let i = 0; i < tasks.length; i += MODULE_CONCURRENCY) {
        checkPipelineTimeout(pipelineStart);

        if (i > 0) {
          await new Promise((r) => setTimeout(r, INTER_BATCH_COOLDOWN_MS));
        }

        const batch = tasks.slice(i, i + MODULE_CONCURRENCY);

        const repoFiles = await getRepoTree(fullName);
        const coreFilePaths = getCoreFilePaths(repoFiles);
        const coreFilePathsBudgeted = selectPathsWithinBudget(
          repoFiles.filter((f) => coreFilePaths.includes(f.path)),
          CONTEXT_BUDGETS.moduleGeneration,
          CORE_FILE_PATTERNS
        );
        const coreFiles = await getMultipleFileContents(fullName, coreFilePathsBudgeted);
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
              if (err instanceof CreditExhaustedError) throw err;
              const errMsg = err instanceof Error ? err.message : String(err);
              return { task, files: [], durationSeconds: 0, error: errMsg };
            }
          })
        );

        const allFiles = batchResults.flatMap((r) => r.files);
        if (allFiles.length > 0) {
          const { stubs, warnings } = validateModuleImports(allFiles, allPaths);
          if (warnings.length > 0) {
            await logger.warn(`Module ${batchNames}: ${warnings.length} unresolved import(s)`, 'development', projectId);
          }

          const filesToPush = [...allFiles, ...stubs];
          await pushFiles(fullName, filesToPush, `feat: implement ${batchNames}`, projectId);

          for (const f of filesToPush) {
            if (f.path.endsWith('.tsx') || f.path.endsWith('.ts')) {
              completedModuleExports.push(f.path);
            }
          }

          const newSignatures = extractExportSignatures(filesToPush);
          allExportSignatures.push(...newSignatures);
        }

        modulesSinceLastBuildCheck++;
        if (modulesSinceLastBuildCheck >= INTERMEDIATE_BUILD_CHECK_INTERVAL && i + MODULE_CONCURRENCY < tasks.length) {
          modulesSinceLastBuildCheck = 0;
          try {
            const midBuild = await verifyBuild(fullName, projectId);
            if (!midBuild.success && midBuild.isEnvironmentError) {
              await logger.warn('Intermediate build check: environment issue detected. Treating as potential build failure.', 'development', projectId);
              cumulativeIntermediateErrors += 1;
            } else if (!midBuild.success) {
              const midErrors = extractBuildErrors(midBuild.errors || midBuild.output);
              const midDeduped = deduplicateErrors(midErrors);
              await logger.warn(`Intermediate build check: ${midDeduped.length} error(s). Fixing before next module...`, 'development', projectId);

              for (let midAttempt = 0; midAttempt < 2; midAttempt++) {
                const freshRepoFiles = await getRepoTree(fullName);
                const freshCodeFiles = freshRepoFiles.filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path));
                const freshPathsBudgeted = selectPathsWithinBudget(freshCodeFiles, CONTEXT_BUDGETS.buildFix, CORE_FILE_PATTERNS);
                const freshCode = await getMultipleFileContents(fullName, freshPathsBudgeted);

                const freshBuild = midAttempt === 0 ? midBuild : await verifyBuild(fullName, projectId);
                if (freshBuild.success) {
                  await logger.info('Intermediate build fix succeeded', 'development', projectId);
                  break;
                }

                const freshErrors = extractBuildErrors(freshBuild.errors || freshBuild.output);
                const freshDeduped = deduplicateErrors(freshErrors);
                const freshRelevant = filterRelevantFiles(freshCode, freshDeduped, CONTEXT_BUDGETS.buildFix);
                const freshAllPaths = freshRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);

                const midFix = await generateBuildFix(
                  freshDeduped,
                  sliceBuildOutput(freshBuild.errors || freshBuild.output, INTERMEDIATE_BUILD_OUTPUT_SLICE),
                  project as unknown as Project,
                  client,
                  architecture as unknown as Record<string, unknown>,
                  freshRelevant,
                  [],
                  midAttempt + 1,
                  2,
                  { strategy: midAttempt === 0 ? 'standard' : 'simplify', allFilePaths: freshAllPaths }
                );
                if (midFix.files.length > 0) {
                  const midFixTouchesApp = midFix.files.some((f) => f.path === 'src/App.tsx');
                  await validateAndPush(fullName, midFix.files, `fix: intermediate build errors after ${batchNames}`, projectId, freshAllPaths);
                  if (midFixTouchesApp) {
                    const reconFiles = await getRepoTree(fullName);
                    const reconPaths = reconFiles.filter((f) => f.type === 'file').map((f) => f.path);
                    const reconApp = await getFileContent(fullName, 'src/App.tsx');
                    const reconciled = reconcileAppRoutes(reconPaths, architecture.pages || [], reconApp || undefined);
                    if (reconciled) {
                      await pushFiles(fullName, [reconciled], 'fix: re-reconcile App.tsx after intermediate build fix', projectId);
                    }
                  }
                } else {
                  break;
                }
              }
              const postFixBuild = await verifyBuild(fullName, projectId);
              if (!postFixBuild.success) {
                const remainingErrors = deduplicateErrors(extractBuildErrors(postFixBuild.errors || postFixBuild.output));
                cumulativeIntermediateErrors = remainingErrors.length;
              } else {
                cumulativeIntermediateErrors = 0;
              }
            } else {
              cumulativeIntermediateErrors = 0;
              await logger.info('Intermediate build check passed', 'development', projectId);
            }

            if (cumulativeIntermediateErrors > ERROR_BUDGET_THRESHOLD) {
              await logger.warn(`Error budget exceeded (${cumulativeIntermediateErrors} > ${ERROR_BUDGET_THRESHOLD}). Running full build gate before continuing.`, 'development', projectId);
              await sendChatMessage(projectId, `Pausing module generation to fix ${cumulativeIntermediateErrors} accumulated errors...`);
              const budgetGate = await buildGate(
                fullName, projectId, project as unknown as Project, client, architecture,
                3, 'error-budget'
              );
              cumulativeIntermediateErrors = budgetGate.errorsRemaining;
              if (budgetGate.passed) {
                await logger.info('Error budget gate passed. Resuming module generation.', 'development', projectId);
              }
            }
          } catch (midErr) {
            await logger.warn(`Intermediate build check failed (non-critical): ${midErr instanceof Error ? midErr.message : String(midErr)}`, 'development', projectId);
          }
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

            const updatedModules = [...(checkpoint?.modules_completed || []), result.task.module.name];
            await saveCheckpoint(projectId, briefId, 'development', {
              exportSignatures: allExportSignatures.map((s) => ({ path: s.path, defaultExport: s.defaultExport, namedExports: s.namedExports })),
              cumulativeIntermediateErrors,
              modulesSinceLastBuildCheck,
              completedModuleExportPaths: completedModuleExports,
            },
              updatedModules,
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
        .select('id, title, description, created_at')
        .eq('project_id', projectId)
        .eq('status', 'failed');

      const currentRunTasks = (failedTasks || []).filter((ft) =>
        moduleTasks.some((mt) => mt.id === ft.id)
      );

      if (currentRunTasks.length === 0) break;

      await logger.info(`Recovery pass ${recoveryPass}/${MAX_RECOVERY_PASSES}: retrying ${currentRunTasks.length} failed module(s)`, 'development', projectId);
      await sendChatMessage(projectId, `Retrying ${currentRunTasks.length} failed module(s) (recovery pass ${recoveryPass})... Waiting for rate limit window to reset.`);
      await new Promise((r) => setTimeout(r, RECOVERY_COOLDOWN_MS));

      for (const failedTask of currentRunTasks) {
        checkPipelineTimeout(pipelineStart);

        const matchingModule = moduleTasks.find((mt) => mt.id === failedTask.id);
        if (!matchingModule) continue;

        await supabase.from('project_tasks').update({
          status: 'in_progress',
          error_log: null,
          started_at: new Date().toISOString(),
        }).eq('id', failedTask.id);

        const repoFiles = await getRepoTree(fullName);
        const coreFilePaths = getCoreFilePaths(repoFiles);
        const recoveryFilePathsBudgeted = selectPathsWithinBudget(
          repoFiles.filter((f) => coreFilePaths.includes(f.path)),
          CONTEXT_BUDGETS.moduleGeneration,
          CORE_FILE_PATTERNS
        );
        const coreFiles = await getMultipleFileContents(fullName, recoveryFilePathsBudgeted);
        const allPaths = repoFiles.filter((f) => f.type === 'file').map((f) => f.path);
        const recoveryExportCtx = buildExportContext(allExportSignatures);
        const recoveryStubPaths = resolveStubPaths(matchingModule.module.pages, allPaths);

        const recoveryMode = recoveryPass === 1 ? 'simplified' as const : 'isolated' as const;
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
            recoveryStubPaths,
            recoveryMode
          );

          const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000);
          if (codeResult.files.length > 0) {
            await validateAndPush(fullName, codeResult.files, `feat: implement ${matchingModule.module.name} (recovery)`, projectId, allPaths);
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
          if (err instanceof CreditExhaustedError) throw err;
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
      await notifyError(project.name, `Pipeline aborted: ${failedCount}/${totalTasks} modules failed`, projectId, {
        phase: 'development',
        modulesCompleted: totalTasks - failedCount,
        modulesTotal: totalTasks,
        repoUrl: repoUrl,
        durationMinutes: Math.round((Date.now() - pipelineStart) / 60000),
      });
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

    checkPipelineTimeout(pipelineStart);

    const coveredPageNames = new Set<string>();
    {
      const { data: completedTasks } = await supabase
        .from('project_tasks')
        .select('id, status')
        .eq('project_id', projectId)
        .eq('status', 'completed');
      const completedTaskIds = new Set((completedTasks || []).map((t) => t.id));
      for (const mt of moduleTasks) {
        if (completedTaskIds.has(mt.id)) {
          for (const page of mt.module.pages) {
            coveredPageNames.add(page.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
          }
        }
      }
    }

    // ============================================================
    // PHASE 3.5: PRE-COMPLETENESS App.tsx RECONCILIATION
    // ============================================================

    try {
      const preReconRepoFiles = await getRepoTree(fullName);
      const preReconPaths = preReconRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);
      const preReconAppContent = await getFileContent(fullName, 'src/App.tsx');
      const preReconciledApp = reconcileAppRoutes(preReconPaths, architecture.pages || [], preReconAppContent || undefined);
      if (preReconciledApp) {
        await pushFiles(fullName, [preReconciledApp], 'fix: reconcile App.tsx routes before completeness check', projectId);
        await logger.info('Reconciled App.tsx routes before completeness check', 'development', projectId);
      }
    } catch (err) {
      await logger.warn(`Pre-completeness App.tsx reconciliation failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
    }

    // ============================================================
    // PHASE 3.5: COMPLETENESS CHECK (multi-pass)
    // ============================================================

    await updateProject(projectId, { current_phase: 'completeness_check', progress: 68 });
    await logger.info('Phase 3.5: Completeness verification', 'development', projectId);
    await sendChatMessage(projectId, 'Verifying project completeness...');

    for (let completenessPass = 0; completenessPass < MAX_COMPLETENESS_PASSES; completenessPass++) {
      try {
        const allRepoFiles = await getRepoTree(fullName);
        const allRepoFilePaths = allRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);

        const appTsxContent = await getFileContent(fullName, 'src/App.tsx');
        const progCheck = programmaticCompletenessCheck(architecture, allRepoFilePaths, appTsxContent, coveredPageNames);
        const progIssues = progCheck.missingPageFiles.length + progCheck.brokenImports.length + progCheck.missingRoutes.length;

        if (progIssues > 0) {
          await logger.info(`Programmatic completeness: ${progCheck.missingPageFiles.length} missing pages, ${progCheck.brokenImports.length} broken imports, ${progCheck.missingRoutes.length} missing routes`, 'development', projectId);
        }

        const allCodeFiles = allRepoFiles.filter(
          (f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path)
        );
        const completenessPathsBudgeted = selectPathsWithinBudget(
          allCodeFiles,
          CONTEXT_BUDGETS.completenessCheck,
          CORE_FILE_PATTERNS
        );
        const allCode = await getMultipleFileContents(fullName, completenessPathsBudgeted);

        const completeness = await verifyProjectCompleteness(architecture, allCode, projectId);

        const pageFileKeys = allRepoFilePaths
          .filter((f) => f.startsWith('src/pages/') && /\.(tsx?|jsx?)$/.test(f))
          .map((f) => f.replace(/^src\/pages\//, '').replace(/\.(tsx?|jsx?)$/, '').toLowerCase().replace(/[^a-z0-9]/g, ''));

        completeness.missingFiles = completeness.missingFiles.filter((f) => {
          const norm = f.replace(/^src\/pages\//, '').replace(/\.(tsx?|jsx?)$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (coveredPageNames.has(norm)) return false;
          if (pageFileKeys.some((k) => k.includes(norm) || norm.includes(k))) return false;
          const fileParts = norm.split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
          if (fileParts.length > 1 && fileParts.some((p) => pageFileKeys.some((k) => k.includes(p)))) return false;
          return true;
        });

        const totalIssues = completeness.missingFiles.length + completeness.brokenImports.length + completeness.missingRoutes.length;

        if (totalIssues === 0 && progIssues === 0) {
          await sendChatMessage(projectId, completenessPass === 0
            ? 'All pages accounted for. No missing routes or broken imports.'
            : `Completeness verified after ${completenessPass} fix pass(es).`);
          break;
        }

        const combinedMissingMap = new Map<string, string>();
        for (const f of completeness.missingFiles) {
          combinedMissingMap.set(f.toLowerCase().replace(/[^a-z0-9/]/g, ''), f);
        }
        for (const p of progCheck.missingPageFiles) {
          const full = `src/pages/${p}.tsx`;
          const key = full.toLowerCase().replace(/[^a-z0-9/]/g, '');
          if (!combinedMissingMap.has(key)) combinedMissingMap.set(key, full);
        }
        const combinedMissing = Array.from(combinedMissingMap.values());

        await sendChatMessage(projectId, `Found ${Math.max(totalIssues, progIssues)} completeness issue(s) (pass ${completenessPass + 1}). Auto-fixing...`);
        await logger.info(`Completeness issues: ${combinedMissing.length} missing, ${completeness.brokenImports.length} broken imports, ${completeness.missingRoutes.length} missing routes`, 'development', projectId);

        if (completeness.fixFiles.length > 0) {
          const safeFixFiles = completeness.fixFiles.filter((f) => f.path !== 'src/App.tsx');
          if (safeFixFiles.length > 0) {
            const compAllPaths = allRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);
            await validateAndPush(fullName, safeFixFiles, `fix: resolve completeness issues (pass ${completenessPass + 1})`, projectId, compAllPaths);
          }
        }

        if (combinedMissing.length > 0) {
          const missingPages = combinedMissing
            .map((f) => f.replace(/^src\/pages\//, '').replace(/\.tsx$/, ''))
            .filter((f) => f.length > 0);

          for (let batchStart = 0; batchStart < missingPages.length; batchStart += COMPLETENESS_BATCH_SIZE) {
            const batch = missingPages.slice(batchStart, batchStart + COMPLETENESS_BATCH_SIZE);
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
              description: `Auto-generated missing pages batch ${Math.floor(batchStart / COMPLETENESS_BATCH_SIZE) + 1}`,
            };

            const repoFilesNow = await getRepoTree(fullName);
            const coreFilePaths = getCoreFilePaths(repoFilesNow);
            const fixCorePathsBudgeted = selectPathsWithinBudget(
              repoFilesNow.filter((f) => coreFilePaths.includes(f.path)),
              CONTEXT_BUDGETS.completenessFixCoreFiles,
              CORE_FILE_PATTERNS
            );
            const coreFiles = await getMultipleFileContents(fullName, fixCorePathsBudgeted);
            const allPaths = repoFilesNow.filter((f) => f.type === 'file').map((f) => f.path);

            try {
              const compStubPaths = resolveStubPaths(batchPages, allPaths);
              const compExportCtx = buildExportContext(allExportSignatures);
              const codeResult = await generateModuleCode(
                tempModule,
                project as unknown as Project,
                client,
                architecture,
                coreFiles,
                allPaths,
                compExportCtx,
                compStubPaths
              );
              if (codeResult.files.length > 0) {
                await validateAndPush(fullName, codeResult.files, `fix: generate missing pages (${batch.join(', ')})`, projectId, allPaths);
                const newSigs = extractExportSignatures(codeResult.files);
                allExportSignatures.push(...newSigs);
              }
            } catch (err) {
              if (err instanceof CreditExhaustedError) throw err;
              await logger.warn(`Failed to generate missing pages batch: ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
            }

            if (batchStart + COMPLETENESS_BATCH_SIZE < missingPages.length) {
              await new Promise((r) => setTimeout(r, COMPLETENESS_INTER_BATCH_DELAY_MS));
            }
          }
        }
      } catch (err) {
        if (err instanceof CreditExhaustedError) throw err;
        await logger.warn(`Completeness check failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
        break;
      }
    }

    // ============================================================
    // PHASE 3.75: FINAL App.tsx RECONCILIATION (AFTER completeness)
    // ============================================================

    try {
      const reconRepoFiles = await getRepoTree(fullName);
      const reconPaths = reconRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);
      const existingAppContent = await getFileContent(fullName, 'src/App.tsx');
      const reconciledApp = reconcileAppRoutes(reconPaths, architecture.pages || [], existingAppContent || undefined);
      if (reconciledApp) {
        await pushFiles(fullName, [reconciledApp], 'fix: final App.tsx route reconciliation', projectId);
        await logger.info('Final App.tsx route reconciliation complete', 'development', projectId);
      }
    } catch (err) {
      await logger.warn(`Final App.tsx reconciliation failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'development', projectId);
    }

    // ============================================================
    // PHASE 4: BUILD VERIFICATION (with cycle detection)
    // ============================================================

    await sendChatMessage(projectId, 'Verifying build before deployment...');
    await logger.info('Verifying build', 'development', projectId);
    await updateProject(projectId, { current_phase: 'build_verification', progress: 72 });

    const finalGate = await buildGate(
      fullName, projectId, project as unknown as Project, client, architecture,
      config.max_corrections, 'final-build'
    );

    let buildPassed = finalGate.passed;

    if (buildPassed) {
      await sendChatMessage(projectId, finalGate.attemptsUsed === 1 ? 'Build verified successfully.' : `Build verified after ${finalGate.attemptsUsed - 1} fix(es).`);
    } else if (finalGate.lastStrategy === 'environment_skip') {
      await logger.error('Build verification could not run due to environment issue. Build NOT marked as passed.', 'development', projectId);
      await sendChatMessage(projectId, 'Build verification failed: environment issue prevented local build. Attempting recovery...');
    }

    if (!buildPassed) {
      const lastBuildResult = await verifyBuild(fullName, projectId);
      if (!lastBuildResult.success) {
        const lastErrors = extractBuildErrors(lastBuildResult.errors || lastBuildResult.output);
        const lastRepoFiles = await getRepoTree(fullName);
        const lastAllPaths = lastRepoFiles.filter((f) => f.type === 'file').map((f) => f.path);

        const missingModuleStubs = lastErrors
          .map((e) => generateStubForMissingImport(e, lastAllPaths))
          .filter((s): s is NonNullable<typeof s> => s !== null);

        if (missingModuleStubs.length > 0) {
          await logger.warn(`Generating ${missingModuleStubs.length} stub(s) for missing modules before @ts-nocheck`, 'development', projectId);
          await pushFiles(fullName, missingModuleStubs, 'fix: generate stubs for missing modules (last resort)', projectId);
        }

        if (areAllErrorsTypeOnly(lastErrors) || missingModuleStubs.length > 0) {
          await logger.warn('Applying @ts-nocheck to type-only error files as last resort.', 'development', projectId);
          const freshRepoFiles = missingModuleStubs.length > 0 ? await getRepoTree(fullName) : lastRepoFiles;
          const tsFiles = freshRepoFiles.filter((f) => f.type === 'file' && /\.tsx?$/.test(f.path)).map((f) => f.path);
          const tsContents = await getMultipleFileContents(fullName, tsFiles);
          const tsNoCheckFixes = generateTsNoCheckFiles(lastErrors, tsContents);
          if (tsNoCheckFixes.length > 0) {
            await pushFiles(fullName, tsNoCheckFixes, 'fix: apply @ts-nocheck to type-only error files (last resort)', projectId);
          }

          const retryBuild = await verifyBuild(fullName, projectId);
          if (retryBuild.success) {
            buildPassed = true;
            await sendChatMessage(projectId, 'Build passed after applying stubs and type suppressions.');
          }
        }
      }
    }

    if (!buildPassed) {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await updateProject(projectId, {
        agent_status: 'idle',
        current_phase: 'failed',
        last_error_message: `Build failed after ${config.max_corrections} correction attempts (${finalGate.errorsRemaining} errors remaining)`,
      });
      await sendChatMessage(projectId, `Build failed after ${config.max_corrections} attempts (${finalGate.errorsRemaining} errors remaining). The repo is available at ${repoUrl} for manual fixes.`);
      await notifyError(
        project.name,
        `Build failed after ${config.max_corrections} attempts. ${finalGate.errorsRemaining} errors remaining. Repo: ${repoUrl}`,
        projectId,
        {
          phase: 'build_verification',
          modulesCompleted: completedModuleExports.length,
          modulesTotal: modules.length,
          buildErrors: finalGate.errorsRemaining,
          repoUrl: repoUrl,
          durationMinutes: Math.round((Date.now() - pipelineStart) / 60000),
          strategy: finalGate.lastStrategy,
        }
      );
      await clearCheckpoint(projectId, 'failed');
      return;
    }

    await saveCheckpoint(projectId, briefId, 'build_verified', {}, checkpoint?.modules_completed || [], fullName);

    } // end if (!skipToBuildVerified)

    if (!config.auto_deploy) {
      await supabase.from('briefs').update({ status: 'completed' }).eq('id', briefId);
      await updateProject(projectId, { status: 'review', progress: 100, agent_status: 'idle', current_phase: 'deployment' });
      await sendChatMessage(projectId, `Build verified successfully. Auto-deploy is disabled. Repo: ${repoUrl}\nReady for manual deployment.`);
      await notifyBuildComplete(project.name, repoUrl, projectId);
      await logger.success('Brief processing complete (deploy skipped per config)', 'development', projectId);
      await clearCheckpoint(projectId, 'completed');
      return;
    }

    // ============================================================
    // PHASE 5: DEPLOYMENT
    // ============================================================

    await updateProject(projectId, { current_phase: 'deployment', progress: 80 });
    await logger.info('Phase 5: Deploying to Vercel', 'deployment', projectId);
    await sendChatMessage(projectId, 'Deploying to Vercel...');

    let vercelProjectId: string;
    try {
      vercelProjectId = await createVercelProject(repoName, fullName, projectId);
    } catch (vercelErr) {
      if (vercelErr instanceof VercelConfigError) {
        await supabase.from('briefs').update({ status: 'completed' }).eq('id', briefId);
        await updateProject(projectId, {
          status: 'review',
          progress: 100,
          agent_status: 'idle',
          current_phase: 'build_complete',
          last_error_message: vercelErr.message,
        });
        await sendChatMessage(projectId,
          `Build completed successfully! Repo: ${repoUrl}\n\n` +
          `Deployment could not proceed: ${vercelErr.message}\n\n` +
          `Once you install the Vercel GitHub App, retry the brief to deploy automatically.`
        );
        await notifyBuildComplete(project.name, repoUrl, projectId);
        await saveCheckpoint(projectId, briefId, 'build_verified', {}, checkpoint?.modules_completed || [], fullName);
        return;
      }
      throw vercelErr;
    }
    await updateProject(projectId, { vercel_project_id: vercelProjectId });

    if (architecture.requiresBackend) {
      const { data: freshProject } = await supabase
        .from('projects')
        .select('supabase_url, supabase_anon_key, supabase_service_role_key')
        .eq('id', projectId)
        .maybeSingle();

      if (freshProject?.supabase_url) {
        const envVars: { key: string; value: string }[] = [
          { key: 'VITE_SUPABASE_URL', value: freshProject.supabase_url },
          { key: 'VITE_SUPABASE_ANON_KEY', value: freshProject.supabase_anon_key || '' },
        ];
        if (freshProject.supabase_service_role_key) {
          envVars.push({ key: 'SUPABASE_SERVICE_ROLE_KEY', value: freshProject.supabase_service_role_key });
        }
        await setEnvironmentVariables(vercelProjectId, envVars, projectId);
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
      await updateProject(projectId, { agent_status: 'idle', current_phase: 'failed', last_error_message: result.buildLogs || 'Deployment failed' });
      await sendChatMessage(projectId, `Deployment failed: ${result.buildLogs || 'Unknown error'}. Check the logs.`);
      await notifyError(project.name, result.buildLogs || 'Deployment failed', projectId, {
        phase: 'deployment',
        repoUrl: repoUrl,
        durationMinutes: Math.round((Date.now() - pipelineStart) / 60000),
      });
      await clearCheckpoint(projectId, 'failed');
      return;
    }

    await updateProject(projectId, { demo_url: result.url, progress: 90 });
    await sendChatMessage(projectId, `Deployed successfully: ${result.url}`);
    await notifyDeploySuccess(project.name, result.url, projectId);

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
    // PHASE 6: QA
    // ============================================================

    const pages = architecture.pages || [];

    if (config.auto_qa && result.url) {
      await updateProject(projectId, { current_phase: 'qa' });
      await logger.info('Phase 6: Multi-viewport QA', 'qa', projectId);
      await sendChatMessage(projectId, 'Running multi-viewport QA (desktop, tablet, mobile)...');

      let qaVersion = 1;
      let screenshotResults = await captureAllPages(
        result.url,
        pages.map((p) => ({ name: p.name, route: p.route })),
        projectId,
        qaVersion
      );

      const QA_BATCH_SIZE = 5;

      for (let qaAttempt = 0; qaAttempt < config.max_corrections; qaAttempt++) {
        const failedPages: { pageName: string; issues: string[]; score: number }[] = [];

        for (let ssIdx = 0; ssIdx < screenshotResults.length; ssIdx += QA_BATCH_SIZE) {
          const ssBatch = screenshotResults.slice(ssIdx, ssIdx + QA_BATCH_SIZE);
          const batchResults = await Promise.all(
            ssBatch.map(async (ss) => {
              const pageArch = pages.find((p) => p.name === ss.pageName);
              return {
                ss,
                result: await analyzeScreenshotAllViewports(
                  { desktop: ss.desktopUrl, tablet: ss.tabletUrl, mobile: ss.mobileUrl },
                  ss.pageName,
                  pageArch?.description || ss.pageName,
                  projectId
                ),
              };
            })
          );

          for (const { ss, result: qaResult } of batchResults) {
            if (!qaResult.overallPass) {
              const allIssues = qaResult.viewports.flatMap(
                (v) => v.issues.map((issue) => `[${v.viewport}] ${issue}`)
              );
              failedPages.push({ pageName: ss.pageName, issues: allIssues, score: qaResult.overallScore });
            }
          }

          if (ssIdx + QA_BATCH_SIZE < screenshotResults.length) {
            await new Promise((r) => setTimeout(r, 3000));
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
        const qaCodeFiles = qaRepoFiles.filter(
          (f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path)
        );
        const qaPathsBudgeted = selectPathsWithinBudget(
          qaCodeFiles,
          CONTEXT_BUDGETS.qaFix,
          CORE_FILE_PATTERNS
        );
        const qaCode = await getMultipleFileContents(fullName, qaPathsBudgeted);

        const fixResult = await generateAutoQAFix(
          failedPages,
          qaCode,
          project as unknown as Project,
          client,
          architecture as unknown as Record<string, unknown>,
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
            await sendChatMessage(projectId, 'QA correction deployment failed. Sending current state to human QA.');
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
    await cleanupBuildDir(projectId);
    await logger.success('Brief processing pipeline complete', 'development', projectId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isCreditExhausted = err instanceof CreditExhaustedError;
    try {
      if (isCreditExhausted) {
        await supabase.from('briefs').update({ status: 'paused' }).eq('id', briefId);
        await logger.warn(`Pipeline paused: Anthropic credits exhausted. Add credits and retry.`, 'development', projectId);
        await updateProject(projectId, { agent_status: 'idle', last_error_message: 'Paused: credits exhausted. Add credits to Anthropic and retry the brief.' });
        await sendChatMessage(projectId, `Pipeline paused: your Anthropic API credits ran out. Progress has been saved -- add credits and retry to resume from where it left off.`);
        const { data: proj } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle();
        if (proj) await notifyError(proj.name, 'Credits exhausted -- pipeline paused', projectId, {
          phase: 'paused',
          durationMinutes: Math.round((Date.now() - pipelineStart) / 60000),
        });
      } else {
        await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
        await logger.error(`Brief processing failed: ${errMsg}`, 'development', projectId);
        await updateProject(projectId, { agent_status: 'idle', current_phase: 'failed', last_error_message: errMsg });
        await sendChatMessage(projectId, `An error occurred: ${errMsg}`);
        await clearCheckpoint(projectId, 'failed');
        const { data: proj } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle();
        if (proj) await notifyError(proj.name, errMsg, projectId, {
          phase: 'unknown',
          durationMinutes: Math.round((Date.now() - pipelineStart) / 60000),
        });
      }
    } catch (innerErr) {
      console.error('Error in brief-processing catch block:', innerErr);
      try { await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId); } catch (e) { console.error('[cleanup] brief update failed:', e instanceof Error ? e.message : String(e)); }
      try { await supabase.from('projects').update({ agent_status: 'idle', last_error_message: errMsg }).eq('id', projectId); } catch (e) { console.error('[cleanup] project update failed:', e instanceof Error ? e.message : String(e)); }
      if (!isCreditExhausted) {
        try { await clearCheckpoint(projectId, 'failed'); } catch (e) { console.error('[cleanup] checkpoint clear failed:', e instanceof Error ? e.message : String(e)); }
      }
    }
  }
}

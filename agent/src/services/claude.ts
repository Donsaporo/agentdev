import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { getSecretWithFallback } from '../core/secrets.js';
import { getSupabase } from '../core/supabase.js';
import type {
  GeneratedFile, ClaudeCodeResponse, Brief, Client, Project,
  FullArchitecture, ArchitecturePage, FeatureModule, BuildFixAttempt,
} from '../core/types.js';
import { getProjectTemplate, findMissingPages, findMissingModels } from './project-templates.js';

const MODELS = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-3-20250515',
} as const;

type ModelTier = keyof typeof MODELS;

let anthropic: Anthropic | null = null;
let lastApiCallTimestamp = 0;
const MIN_CALL_INTERVAL_MS = 3000;

async function getClient(): Promise<Anthropic> {
  const key = await getSecretWithFallback('anthropic');
  if (!key) throw new Error('Anthropic API key not configured');
  if (!anthropic || (anthropic as unknown as Record<string, string>)._apiKey !== key) {
    anthropic = new Anthropic({ apiKey: key, timeout: 30 * 60 * 1000 });
  }
  return anthropic;
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastApiCallTimestamp;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_CALL_INTERVAL_MS - elapsed));
  }
  lastApiCallTimestamp = Date.now();
}

function selectModel(task: string): string {
  const complexTasks = ['brief_analysis', 'architecture', 'qa_fix_complex', 'complex_page', 'completeness_check', 'backend_schema'];
  const simpleTasks = ['screenshot_check', 'file_classify', 'status_check'];

  if (complexTasks.includes(task)) return MODELS.opus;
  if (simpleTasks.includes(task)) return MODELS.haiku;
  return MODELS.sonnet;
}

async function trackUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  operation: string,
  projectId?: string
): Promise<void> {
  const costPerMInput: Record<string, number> = {
    [MODELS.opus]: 15,
    [MODELS.sonnet]: 3,
    [MODELS.haiku]: 0.25,
  };
  const costPerMOutput: Record<string, number> = {
    [MODELS.opus]: 75,
    [MODELS.sonnet]: 15,
    [MODELS.haiku]: 1.25,
  };

  const inputCost = (inputTokens / 1_000_000) * (costPerMInput[model] || 3);
  const outputCost = (outputTokens / 1_000_000) * (costPerMOutput[model] || 15);

  try {
    const supabase = getSupabase();
    await supabase.from('token_usage').insert({
      project_id: projectId || null,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_estimate: inputCost + outputCost,
      operation,
    });
  } catch (err) {
    console.error(`[trackUsage] Failed to record token usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

const RATE_LIMIT_WAIT_MS = 62_000;
const RATE_LIMIT_MAX_RETRIES = 5;

async function callWithRetry(
  fn: () => PromiseLike<unknown>,
  maxRetries: number = 3,
  operation: string = 'unknown'
): Promise<Anthropic.Message> {
  let lastError: Error | null = null;

  await throttle();

  const effectiveMaxRetries = maxRetries;

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    try {
      const result = await fn() as Anthropic.Message;
      lastApiCallTimestamp = Date.now();
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const is400 = lastError.message.includes('400') || lastError.message.includes('invalid_request');
      if (is400) throw lastError;

      const isRateLimit = lastError.message.includes('rate_limit') || lastError.message.includes('429');
      const isRetryable = isRateLimit ||
        lastError.message.includes('overloaded') ||
        lastError.message.includes('timeout') ||
        lastError.message.includes('529') ||
        lastError.message.includes('500');

      if (!isRetryable) throw lastError;

      if (isRateLimit) {
        const rateLimitRetries = RATE_LIMIT_MAX_RETRIES;
        if (attempt >= rateLimitRetries) throw lastError;

        const waitMs = RATE_LIMIT_WAIT_MS + Math.random() * 5000;
        await logger.warn(
          `Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${rateLimitRetries} for ${operation}`,
          'ai'
        );
        await new Promise((r) => setTimeout(r, waitMs));
        lastApiCallTimestamp = Date.now();
        continue;
      }

      if (attempt === effectiveMaxRetries) throw lastError;

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30_000);
      await logger.warn(
        `Claude API retry ${attempt + 1}/${effectiveMaxRetries} for ${operation}: ${lastError.message.slice(0, 200)}`,
        'ai'
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Retry exhausted');
}

function buildThinkingParams(
  thinking?: ThinkingConfig
) {
  if (!thinking?.enabled) return {};
  return {
    thinking: { type: 'enabled' as const, budget_tokens: thinking.budgetTokens },
    temperature: 1 as const,
  };
}

function extractThinkingAndText(response: Anthropic.Message): { thinking: string; text: string } {
  let thinking = '';
  let text = '';
  for (const block of response.content) {
    if (block.type === 'thinking') thinking = (block as unknown as { thinking: string }).thinking;
    if (block.type === 'text') text = block.text;
  }
  return { thinking, text };
}

function parseCodeBlocks(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();

  const patterns = [
    /```(?:\w+)?\s*\n\/\/\s*FILE:\s*(.+?)\n([\s\S]*?)```/g,
    /---\s*(\S+)\s*---\n```(?:\w+)?\n([\s\S]*?)```/g,
    /```(?:\w+)?\s*\n\/\*\s*FILE:\s*(.+?)\s*\*\/\n([\s\S]*?)```/g,
    /<file\s+path=["']([^"']+)["']\s*>\s*\n?([\s\S]*?)<\/file>/g,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const path = match[1].trim();
      if (!seen.has(path)) {
        files.push({ path, content: match[2].trim() });
        seen.add(path);
      }
    }
  }

  return files;
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

function safeParseJSON<T>(text: string, fallback: T): T {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return fallback;
  }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(ct: string): ImageMediaType {
  const t = ct.toLowerCase().split(';')[0].trim();
  if (t.includes('jpeg') || t.includes('jpg')) return 'image/jpeg';
  if (t.includes('gif')) return 'image/gif';
  if (t.includes('webp')) return 'image/webp';
  return 'image/png';
}

async function fetchImageBase64(url: string): Promise<{ data: string; mediaType: ImageMediaType } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return {
      data: Buffer.from(buf).toString('base64'),
      mediaType: normalizeMediaType(res.headers.get('content-type') || 'image/png'),
    };
  } catch {
    return null;
  }
}

export async function analyzePdfDocument(
  pdfBase64: string,
  prompt: string,
  projectId?: string | null,
  modelTier: ModelTier = 'sonnet'
): Promise<string> {
  const ai = await getClient();
  const model = MODELS[modelTier];

  try {
    const response = await callWithRetry(
      () => ai.messages.create({
        model,
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            } as unknown as Anthropic.ImageBlockParam,
            { type: 'text', text: prompt },
          ],
        }],
      }),
      2,
      'pdf_analysis'
    );

    await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'pdf_analysis', projectId || undefined);
    return extractText(response);
  } catch (err) {
    await logger.error(`PDF analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'ai', projectId || undefined);
    return '';
  }
}

export async function analyzeImage(
  imageUrl: string,
  prompt: string,
  projectId?: string | null,
  modelTier: ModelTier = 'haiku'
): Promise<string> {
  const ai = await getClient();
  const model = MODELS[modelTier];

  const img = await fetchImageBase64(imageUrl);
  if (!img) return '';

  try {
    const response = await callWithRetry(
      () => ai.messages.create({
        model,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      2,
      'image_analysis'
    );

    await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'image_analysis', projectId || undefined);
    return extractText(response);
  } catch (err) {
    await logger.error(`Image analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'ai', projectId || undefined);
    return '';
  }
}

// ============================================================
// PHASE 1: BRIEF ANALYSIS (completely rewritten)
// ============================================================

export async function analyzeBrief(
  brief: Brief,
  client: Client,
  project: Project,
  attachmentContents?: string[]
): Promise<{ requirements: string[]; architecture: FullArchitecture; questions: { question: string; category: string }[] }> {
  const ai = await getClient();
  const model = selectModel('brief_analysis');

  const systemPrompt = `You are a senior full-stack architect at Obzide Tech, a premium web agency based in Panama City.
You decompose client briefs into comprehensive, buildable architecture plans that cover EVERYTHING needed for a production-ready application.

DECOMPOSITION FRAMEWORK (follow this EXACTLY):

STEP 1 - CLASSIFY THE PROJECT:
Determine the project type: website, landing, ecommerce, crm, lms, dashboard, saas, blog, portfolio, marketplace, pwa, or custom.
If the brief mentions "mobile app", "iOS", "Android", or "app", ALWAYS set projectType to "pwa" and design as a Progressive Web App with mobile-first responsive design, bottom navigation, and installable PWA manifest.
If the brief mentions "demo" explicitly, mark it as a demo project.

STEP 2 - IDENTIFY USER ROLES:
List ALL distinct user roles (e.g., admin, customer, instructor, viewer). For each role, define what they can do.

STEP 3 - DESIGN DATA MODELS WITH FULL FIELDS:
For each entity, provide complete field definitions with types, constraints, and relationships.
Field types must be one of: uuid, text, integer, numeric, boolean, timestamptz, jsonb, text[].
Every table must have: id (uuid, pk), created_at (timestamptz).
User-owned tables must have: user_id (uuid, FK to auth.users).
Include all foreign keys as explicit references.

STEP 4 - PLAN USER FLOWS:
For each role, map the complete journey: registration -> first use -> core workflows -> edge cases.

STEP 5 - LIST ALL PAGES:
Generate a comprehensive page list. For apps with backends, this typically means 20-40+ pages.
Every CRUD entity needs: List, Detail, Create, Edit pages (for the roles that manage it).
Include: Auth pages (Login, Register), User pages (Profile, Settings), Admin pages, Support pages (404, Terms, Privacy).
Assign each page to a module (e.g., "auth", "admin-courses", "student-dashboard") and a role.

STEP 6 - GROUP INTO FEATURE MODULES:
Group related pages into modules. Each module is a cohesive set of 2-5 pages that share state and data.

STEP 7 - DETERMINE BACKEND NEEDS:
If the project has user roles, data models, or any dynamic data beyond static content, set requiresBackend: true.
Static websites and landing pages set requiresBackend: false.

STEP 8 - PLAN INTEGRATIONS:
List all third-party services needed (payments, email, storage, analytics, etc.).

STEP 9 - DESIGN SYSTEM:
Plan colors, fonts, spacing, and visual style. For Panama-based projects, consider local payment gateways (Yappy, Banco General, CyberSource/Banistmo).

TECH STACK:
- React + Vite + TypeScript + Tailwind CSS
- react-router-dom for routing
- lucide-react for icons
- @supabase/supabase-js for backend/auth/database (when requiresBackend is true)
- Responsive design (mobile-first)
- NEVER use React Native or Expo. For mobile requests, build a responsive PWA.
- NEVER use purple/indigo unless brand colors specify them.

QUESTION RULES:
- ONLY ask if genuine ambiguity would BLOCK development
- NEVER ask about things inferable from the brief or industry norms
- If fewer than 3 genuine questions, ask NONE and just build
- Maximum 5 questions

Output valid JSON only, no markdown wrapping.`;

  const attachmentSection = attachmentContents?.length
    ? `\n\nATTACHED DOCUMENTS:\n${attachmentContents.map((c, i) => `--- Attachment ${i + 1} ---\n${c}`).join('\n\n')}`
    : '';

  const userPrompt = `Analyze this client brief comprehensively.

CLIENT: ${client.name}
INDUSTRY: ${client.industry}
BRAND COLORS: ${JSON.stringify(client.brand_colors)}
BRAND FONTS: ${JSON.stringify(client.brand_fonts)}
${client.notes ? `CLIENT NOTES: ${client.notes}` : ''}

PROJECT: ${project.name}
TYPE: ${project.type}
DESCRIPTION: ${project.description}
TECHNOLOGIES: ${JSON.stringify(project.technologies)}

FULL BRIEF:
${brief.original_content}
${attachmentSection}

Respond with this exact JSON structure (fill ALL fields completely):
{
  "requirements": ["detailed requirement 1", "..."],
  "architecture": {
    "framework": "vite-react",
    "styling": "tailwindcss",
    "projectType": "lms|ecommerce|crm|website|landing|dashboard|saas|blog|portfolio|marketplace|pwa|custom",
    "requiresBackend": true,
    "userRoles": [
      {"name": "student", "permissions": ["view_courses", "enroll", "track_progress"], "description": "End user learning on the platform"},
      {"name": "admin", "permissions": ["manage_courses", "manage_users", "view_analytics"], "description": "Platform administrator"}
    ],
    "dataModels": [
      {
        "name": "courses",
        "fields": [
          {"name": "id", "type": "uuid", "pk": true},
          {"name": "title", "type": "text", "required": true},
          {"name": "description", "type": "text"},
          {"name": "instructor_id", "type": "uuid", "reference": {"table": "auth.users", "column": "id"}},
          {"name": "price", "type": "numeric", "default": "0"},
          {"name": "is_published", "type": "boolean", "default": "false"},
          {"name": "created_at", "type": "timestamptz", "default": "now()"}
        ],
        "rls": {"select": "authenticated", "insert": "admin", "update": "admin", "delete": "admin"}
      }
    ],
    "features": [
      {"name": "Course Management", "pages": ["AdminCourseList", "AdminCourseCreate", "AdminCourseEdit"], "role": "admin", "description": "Full CRUD for courses"}
    ],
    "pages": [
      {"name": "Home", "route": "/", "description": "Landing page with hero, features, testimonials, CTA", "role": "public", "module": "marketing", "requiresAuth": false},
      {"name": "Login", "route": "/login", "description": "Email/password login form with validation", "role": "public", "module": "auth", "requiresAuth": false},
      {"name": "StudentDashboard", "route": "/dashboard", "description": "Overview of enrolled courses, progress, recommendations", "role": "student", "module": "student-dashboard", "requiresAuth": true}
    ],
    "flows": [
      {"name": "Student Enrollment", "role": "student", "steps": ["Browse courses", "View course detail", "Click enroll", "Complete payment", "Access course content"]}
    ],
    "components": [
      {"name": "Navbar", "description": "Sticky responsive nav with auth state, role-based menu items"},
      {"name": "Footer", "description": "Professional footer with links, social, copyright"}
    ],
    "integrations": ["supabase-auth", "supabase-storage"],
    "auth": {"providers": ["email"], "requiresVerification": false},
    "storage": {"buckets": ["course-images", "avatars"]},
    "designSystem": {
      "primaryColor": "#hex",
      "secondaryColor": "#hex",
      "accentColor": "#hex",
      "fonts": {"heading": "Inter", "body": "Inter"},
      "style": "modern|minimal|bold|corporate|playful"
    }
  },
  "questions": []
}`;

  const thinking: ThinkingConfig = { enabled: true, budgetTokens: 16000 };

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...buildThinkingParams(thinking),
    }),
    3,
    'brief_analysis'
  );

  const { text } = extractThinkingAndText(response);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'brief_analysis', project.id);
  await logger.info('Brief analyzed', 'ai', project.id, {
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  const fallback = { requirements: [], architecture: {} as FullArchitecture, questions: [] };
  const result = safeParseJSON(text, fallback);

  if (result.architecture && result.architecture.pages) {
    const expanded = await expandArchitectureCompleteness(result.architecture, project, client);
    result.architecture = expanded;

    result.architecture = await validateArchitectureCrossCheck(
      result.architecture,
      brief,
      attachmentContents || [],
      project
    );
  }

  return result;
}

// ============================================================
// PASS 3: VALIDATION CROSS-CHECK
// ============================================================

async function validateArchitectureCrossCheck(
  architecture: FullArchitecture,
  brief: Brief,
  attachmentContents: string[],
  project: Project
): Promise<FullArchitecture> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const visualAnalysis = attachmentContents
    .filter((c) => c.includes('[VISUAL ANALYSIS]'))
    .join('\n\n');

  const validationPrompt = `You are performing a final validation pass on a project architecture before code generation begins.

ORIGINAL BRIEF:
${brief.original_content.slice(0, 3000)}

${visualAnalysis ? `VISUAL REFERENCES FROM ATTACHMENTS:\n${visualAnalysis.slice(0, 4000)}` : ''}

ARCHITECTURE TO VALIDATE:
${JSON.stringify(architecture, null, 2)}

Validate that:
1. Every requirement from the brief has a corresponding page, feature, or data model
2. Every data model has all necessary fields for the features that use it
3. User flows are complete (no dead-ends or missing steps)
4. If visual references were provided, the designSystem colors and style match what was shown
5. All foreign key relationships between data models are present and correct
6. No critical pages are missing for the project type

If EVERYTHING is correct, respond: {"valid": true, "fixes": {}}

If issues are found, respond with specific fixes:
{
  "valid": false,
  "fixes": {
    "designSystem": {"primaryColor": "#corrected", ...},
    "additionalFields": [{"model": "courses", "field": {"name": "thumbnail_url", "type": "text"}}],
    "additionalPages": [...],
    "missingFlows": [...]
  }
}

Output valid JSON only.`;

  try {
    const response = await callWithRetry(
      () => ai.messages.create({
        model,
        max_tokens: 8192,
        messages: [{ role: 'user', content: validationPrompt }],
      }),
      2,
      'architecture_validation'
    );

    const text = extractText(response);
    await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'architecture_validation', project.id);

    const validation = safeParseJSON<{
      valid: boolean;
      fixes?: {
        designSystem?: FullArchitecture['designSystem'];
        additionalFields?: { model: string; field: { name: string; type: string } }[];
        additionalPages?: ArchitecturePage[];
        missingFlows?: FullArchitecture['flows'];
      };
    }>(text, { valid: true });

    if (!validation.valid && validation.fixes) {
      if (validation.fixes.designSystem) {
        architecture.designSystem = { ...architecture.designSystem, ...validation.fixes.designSystem };
      }

      if (validation.fixes.additionalFields) {
        for (const af of validation.fixes.additionalFields) {
          if (!af?.model || !af?.field?.name) continue;
          const dataModel = (architecture.dataModels || []).find((m) => m?.name === af.model);
          if (dataModel && dataModel.fields) {
            const exists = dataModel.fields.some((f) => f?.name === af.field.name);
            if (!exists) {
              dataModel.fields.push(af.field as typeof dataModel.fields[number]);
            }
          }
        }
      }

      if (validation.fixes.additionalPages?.length) {
        architecture.pages = [...(architecture.pages || []), ...validation.fixes.additionalPages];
      }

      if (validation.fixes.missingFlows?.length) {
        architecture.flows = [...(architecture.flows || []), ...validation.fixes.missingFlows];
      }

      await logger.info('Architecture validation: applied fixes from cross-check', 'ai', project.id);
    } else {
      await logger.info('Architecture validation: all checks passed', 'ai', project.id);
    }
  } catch (err) {
    await logger.warn(`Architecture validation failed (non-critical): ${err instanceof Error ? err.message : String(err)}`, 'ai', project.id);
  }

  return architecture;
}

// ============================================================
// COMPLETENESS EXPANSION PASS
// ============================================================

async function expandArchitectureCompleteness(
  architecture: FullArchitecture,
  project: Project,
  client: Client
): Promise<FullArchitecture> {
  const template = getProjectTemplate(architecture.projectType || project.type);
  if (!template) return architecture;

  const existingPageNames = (architecture.pages || []).map((p) => p.name);
  const missingPages = findMissingPages(existingPageNames, template);

  const existingModelNames = (architecture.dataModels || []).map((m) => m.name);
  const missingModels = findMissingModels(existingModelNames, template);

  if (missingPages.length === 0 && missingModels.length === 0) return architecture;

  await logger.info(
    `Completeness check: ${missingPages.length} missing pages, ${missingModels.length} missing models. Expanding...`,
    'ai',
    project.id
  );

  const ai = await getClient();
  const model = MODELS.sonnet;

  const expansionPrompt = `You are expanding an existing architecture to fill in missing pages and data models.

EXISTING ARCHITECTURE:
${JSON.stringify(architecture, null, 2)}

MISSING PAGES (must be added):
${missingPages.map((p) => `- ${p}`).join('\n')}

MISSING DATA MODELS (must be added):
${missingModels.map((m) => `- ${m}`).join('\n')}

CLIENT: ${client.name} (${client.industry})
PROJECT TYPE: ${architecture.projectType}

For each missing page, create a complete page entry with: name, route, description (detailed section-by-section), role, module, requiresAuth.
For each missing data model, create a complete model with all fields, types, and RLS rules.

IMPORTANT: Only output the NEW items to add. Do not repeat existing items.
Output valid JSON only:
{
  "additionalPages": [...],
  "additionalDataModels": [...],
  "additionalFeatures": [...],
  "additionalComponents": [...]
}`;

  try {
    const response = await callWithRetry(
      () => ai.messages.create({
        model,
        max_tokens: 16384,
        messages: [{ role: 'user', content: expansionPrompt }],
      }),
      2,
      'architecture_expansion'
    );

    const text = extractText(response);
    await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'architecture_expansion', project.id);

    const additions = safeParseJSON<{
      additionalPages?: ArchitecturePage[];
      additionalDataModels?: FullArchitecture['dataModels'];
      additionalFeatures?: FullArchitecture['features'];
      additionalComponents?: FullArchitecture['components'];
    }>(text, {});

    if (additions.additionalPages?.length) {
      architecture.pages = [...(architecture.pages || []), ...additions.additionalPages];
    }
    if (additions.additionalDataModels?.length) {
      architecture.dataModels = [...(architecture.dataModels || []), ...additions.additionalDataModels];
    }
    if (additions.additionalFeatures?.length) {
      architecture.features = [...(architecture.features || []), ...additions.additionalFeatures];
    }
    if (additions.additionalComponents?.length) {
      architecture.components = [...(architecture.components || []), ...additions.additionalComponents];
    }

    await logger.info(
      `Architecture expanded: +${additions.additionalPages?.length || 0} pages, +${additions.additionalDataModels?.length || 0} models`,
      'ai',
      project.id
    );
  } catch (err) {
    await logger.warn(`Architecture expansion failed, continuing with original: ${err instanceof Error ? err.message : String(err)}`, 'ai', project.id);
  }

  return architecture;
}

// ============================================================
// PHASE 2: SCAFFOLD GENERATION (improved)
// ============================================================

export async function generateProjectScaffold(
  project: Project,
  client: Client,
  architecture: FullArchitecture
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const hasBackend = architecture.requiresBackend;

  const backendFiles = hasBackend ? `
- src/lib/supabase.ts (Supabase client singleton using VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars)
- src/lib/types.ts (TypeScript interfaces for ALL data models: ${(architecture.dataModels || []).map((m) => m.name).join(', ')})
- src/lib/api.ts (CRUD helper functions for each data model using Supabase client - getAll, getById, create, update, delete)
- src/contexts/AuthContext.tsx (Supabase Auth context with signUp, signIn, signOut, session management, role from user metadata)
- src/hooks/useAuth.ts (hook wrapping AuthContext for easy consumption)
- .env.example (VITE_SUPABASE_URL=your-project-url, VITE_SUPABASE_ANON_KEY=your-anon-key)` : `
- src/lib/mock-data.ts (realistic mock data for all entities, shared by all pages - NOT lorem ipsum)
- src/contexts/AppContext.tsx (local state management for the demo with all mock data)`;

  const authInstructions = hasBackend ? `
AUTH INTEGRATION:
- Wrap App in AuthProvider from AuthContext
- Login page must use supabase.auth.signInWithPassword()
- Register page must use supabase.auth.signUp()
- Protected routes check auth state and redirect to /login if not authenticated
- Navbar shows user info when logged in, Login/Register when not
- Use role from user_metadata to show/hide admin-only navigation` : '';

  const systemPrompt = `You are a senior full-stack developer at Obzide Tech building production websites.
Generate a complete project scaffold with all configuration, shared components, and infrastructure.

ENVIRONMENT CONSTRAINTS (CRITICAL - violating these causes build failures):
- Target: Vite 5.x + React 18 + TypeScript 5.x
- Node compatibility: ES2020+ modules only
- ALLOWED dependencies (do NOT add ANY others):
  react, react-dom, react-router-dom, lucide-react, date-fns${hasBackend ? ', @supabase/supabase-js' : ''}
- ALLOWED devDependencies:
  vite, @vitejs/plugin-react, typescript, tailwindcss, postcss, autoprefixer, @types/react, @types/react-dom
- FORBIDDEN packages (NEVER include): react-native, expo, @emotion/*, styled-components, @mui/*, antd, @chakra-ui/*, next, gatsby, axios, lodash, moment, @headlessui/*, @radix-ui/*
- Import rules: use RELATIVE paths only (./  ../) - NO @/ aliases
- All component files: .tsx extension
- All non-JSX files: .ts extension

EXACT DEPENDENCY VERSIONS (use these exactly in package.json):
"react": "^18.3.1", "react-dom": "^18.3.1", "react-router-dom": "^7.1.0"
"lucide-react": "^0.344.0", "date-fns": "^4.1.0"${hasBackend ? '\n"@supabase/supabase-js": "^2.57.4"' : ''}
"vite": "^5.4.2", "@vitejs/plugin-react": "^4.3.1", "typescript": "^5.5.3"
"tailwindcss": "^3.4.1", "postcss": "^8.4.35", "autoprefixer": "^10.4.18"

EXACT DIRECTORY STRUCTURE:
src/
  main.tsx            (entry point with BrowserRouter${hasBackend ? ', AuthProvider' : ''})
  App.tsx             (ALL routes defined here, imports ALL page components)
  index.css           (Tailwind directives + custom CSS)
  vite-env.d.ts       (Vite type declarations)
  components/         (shared reusable components: Layout, Navbar, Footer, etc.)
  pages/              (ONE file per route, each with default export)
  lib/                (${hasBackend ? 'supabase client, types, api helpers' : 'mock data, types, utilities'})
  contexts/           (React contexts${hasBackend ? ': AuthContext' : ''})
  hooks/              (custom hooks)

FILE OUTPUT FORMAT:
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a fenced code block
- Use the exact path relative to project root

REQUIRED FILES (generate ALL of these):
- package.json (scripts: {"dev": "vite", "build": "vite build", "preview": "vite preview"})
- vite.config.ts
- tsconfig.json, tsconfig.app.json, tsconfig.node.json
- tailwind.config.js (brand colors as custom theme colors)
- postcss.config.js
- index.html (with Google Fonts link if custom fonts specified)
- src/main.tsx
- src/App.tsx (routes for ALL ${(architecture.pages || []).length} pages)
- src/index.css (Tailwind directives + custom fonts + base styles + scroll animations)
- src/components/Layout.tsx (shared layout with nav + footer, responsive hamburger)
- src/components/Navbar.tsx (sticky, responsive, brand-colored${hasBackend ? ', auth-aware with role-based nav' : ''})
- src/components/Footer.tsx (professional with links, social, copyright)
${backendFiles}
- One STUB file per page in src/pages/ (default export, realistic placeholder content)
${authInstructions}

DESIGN RULES:
- Brand colors: ${JSON.stringify(client.brand_colors)} - use as primary/accent in Tailwind config
- Brand fonts: ${JSON.stringify(client.brand_fonts)} - configure in Tailwind and import in CSS
- Modern, beautiful, production-ready design
- Responsive: mobile-first, works on all screen sizes
- Add CSS transitions and keyframe animations in index.css
- Consistent spacing (8px system)
- Professional typography hierarchy
- NEVER use purple/indigo unless brand colors include them
- Use lucide-react for all icons`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Generate the complete scaffold for:\n\n${JSON.stringify(architecture, null, 2)}` }],
    }),
    3,
    'scaffold'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'scaffold', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

// ============================================================
// BACKEND: DATABASE SCHEMA GENERATION
// ============================================================

export async function generateDatabaseSchema(
  architecture: FullArchitecture,
  projectId: string
): Promise<string> {
  const ai = await getClient();
  const model = selectModel('backend_schema');

  const dataModelNames = (architecture.dataModels || []).map((m) => m.name);

  const systemPrompt = `You are a senior database architect generating PostgreSQL migrations for a Supabase project.

STRUCTURE (output SQL in this EXACT order):
1. Helper functions (updated_at trigger function)
2. CREATE TABLE statements (dependency order: independent tables first, then dependent tables)
3. ALTER TABLE ENABLE ROW LEVEL SECURITY for each table
4. CREATE INDEX statements
5. RLS policies for each table
6. Storage bucket creation (if needed)
7. Seed data (last, after all DDL)

TABLE RULES:
- Use uuid PRIMARY KEY DEFAULT gen_random_uuid() for id columns
- Use timestamptz DEFAULT now() for created_at columns
- Add updated_at timestamptz DEFAULT now() where appropriate
- Add proper FOREIGN KEY constraints with ON DELETE CASCADE or SET NULL as appropriate
- Add indexes on all foreign key columns and frequently queried columns (status fields, email, etc.)
- Enable RLS on EVERY table
- Use IF NOT EXISTS on ALL CREATE TABLE and CREATE INDEX statements
- Create tables in DEPENDENCY ORDER: independent tables first, referencing tables after
- ONLY create tables from this list: ${dataModelNames.join(', ')}
- Do NOT create a "profiles" table unless explicitly listed above
- ONLY reference tables from this list or Supabase system tables (auth.users, storage.objects, storage.buckets)

RLS POLICY SYNTAX (CRITICAL - follow exactly):
- SELECT: CREATE POLICY "name" ON table FOR SELECT TO authenticated USING (condition);
- INSERT: CREATE POLICY "name" ON table FOR INSERT TO authenticated WITH CHECK (condition);  -- NEVER use USING for INSERT
- UPDATE: CREATE POLICY "name" ON table FOR UPDATE TO authenticated USING (condition) WITH CHECK (condition);
- DELETE: CREATE POLICY "name" ON table FOR DELETE TO authenticated USING (condition);
- ONLY reference columns that exist in the CREATE TABLE definition for that table
- Do NOT use FOR ALL -- always separate into SELECT/INSERT/UPDATE/DELETE

SEED DATA RULES (CRITICAL):
- Use gen_random_uuid() for ALL id values in INSERT statements (NEVER hardcode UUIDs)
- NEVER insert rows into auth.users -- that table is managed by Supabase Auth and is EMPTY at migration time
- For tables with a user_id FK to auth.users: SKIP seed data entirely (no users exist yet)
- For tables WITHOUT user_id references: generate 5-15 realistic rows with meaningful content
- Wrap seed data in DO $$ blocks to prevent duplicates on re-run:
  DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM table_name LIMIT 1) THEN INSERT INTO ... END IF; END $$;
- NEVER use lorem ipsum -- generate realistic domain-appropriate content

FORBIDDEN:
- DO NOT wrap in transaction blocks (no BEGIN/COMMIT/ROLLBACK at the top level)
- DO NOT create triggers or functions that reference non-existent tables
- DO NOT use FOR ALL in policies

Output ONLY raw SQL, no markdown wrapping, no explanations.`;

  const userPrompt = `Generate the complete PostgreSQL schema for these data models:

USER ROLES:
${JSON.stringify(architecture.userRoles, null, 2)}

DATA MODELS:
${JSON.stringify(architecture.dataModels, null, 2)}

STORAGE BUCKETS NEEDED:
${JSON.stringify(architecture.storage?.buckets || [], null, 2)}

AUTH SETUP:
${JSON.stringify(architecture.auth, null, 2)}

Generate:
1. All CREATE TABLE statements with proper types, constraints, and defaults
2. All foreign key relationships
3. All indexes
4. RLS enabled on every table
5. RLS policies matching the defined roles
6. updated_at trigger function
7. Storage bucket creation if needed`;

  const thinking: ThinkingConfig = { enabled: true, budgetTokens: 10000 };

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 26000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...buildThinkingParams(thinking),
    }),
    3,
    'backend_schema'
  );

  const { text } = extractThinkingAndText(response);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'backend_schema', projectId);

  let sql = text.trim();
  sql = sql.replace(/^```sql\n?/g, '').replace(/^```\n?/g, '').replace(/\n?```$/g, '').trim();

  sql = postProcessSql(sql);

  const validationIssues = validateGeneratedSql(sql, dataModelNames);
  if (validationIssues.length > 0) {
    await logger.warn(`SQL validation issues: ${validationIssues.join('; ')}`, 'ai', projectId);
  }

  return sql;
}

function validateGeneratedSql(sql: string, allowedModelNames: string[]): string[] {
  const issues: string[] = [];
  const systemTables = ['auth.users', 'storage.objects', 'storage.buckets'];

  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
  const createdTables = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = createTableRegex.exec(sql)) !== null) {
    createdTables.add(match[1].toLowerCase());
  }

  const referencesRegex = /REFERENCES\s+(?:public\.)?(\S+?)[\s(]/gi;
  while ((match = referencesRegex.exec(sql)) !== null) {
    const ref = match[1].replace(/['"]/g, '').toLowerCase();
    const isSystem = systemTables.some((st) => st.toLowerCase() === ref || ref === st.split('.')[1]);
    const isCreated = createdTables.has(ref);
    if (!isSystem && !isCreated) {
      issues.push(`References non-existent table: ${ref}`);
    }
  }

  return issues;
}

function postProcessSql(sql: string): string {
  let result = sql;

  result = result.replace(
    /CREATE\s+POLICY\s+(["'][^"']+["'])\s+ON\s+(\S+)\s+FOR\s+INSERT\s+(?:TO\s+\w+\s+)?USING\s*\(/gi,
    (fullMatch, policyName, tableName) => {
      const toMatch = fullMatch.match(/TO\s+(\w+)/i);
      const toClause = toMatch ? `TO ${toMatch[1]} ` : '';
      return `CREATE POLICY ${policyName} ON ${tableName} FOR INSERT ${toClause}WITH CHECK (`;
    }
  );

  result = result.replace(/\bBEGIN\s*;/gi, '');
  result = result.replace(/\bCOMMIT\s*;/gi, '');
  result = result.replace(/\bROLLBACK\s*;/gi, '');

  return result;
}

export async function fixFailedSqlStatements(
  failedStatements: { sql: string; error: string }[],
  architecture: FullArchitecture,
  projectId: string
): Promise<string> {
  if (failedStatements.length === 0) return '';

  const ai = await getClient();
  const model = selectModel('backend_schema');

  const dataModelNames = (architecture.dataModels || []).map((m) => m.name);

  const failedContext = failedStatements
    .slice(0, 20)
    .map((f, i) => `--- Failed Statement ${i + 1} ---\nSQL: ${f.sql}\nERROR: ${f.error}`)
    .join('\n\n');

  const systemPrompt = `You are fixing failed PostgreSQL statements for a Supabase project.

RULES:
- Output ONLY corrected SQL statements that will fix the errors
- Do NOT recreate tables that already exist (they succeeded)
- Use IF NOT EXISTS on all CREATE statements
- For INSERT policies: use WITH CHECK (condition) -- NEVER use USING for INSERT policies
- For SELECT policies: use USING (condition) only -- no WITH CHECK
- For UPDATE policies: use both USING and WITH CHECK
- For DELETE policies: use USING (condition) only -- no WITH CHECK
- In RLS policies, ONLY reference columns that exist in the table definition
- ONLY reference tables from this list: ${dataModelNames.join(', ')}, auth.users, storage.objects, storage.buckets
- If a column referenced in a policy doesn't exist, either add it with ALTER TABLE or adjust the policy
- Do NOT wrap in transaction blocks (no BEGIN/COMMIT)
- Output ONLY raw SQL, no markdown, no explanations`;

  const userPrompt = `Fix these failed SQL statements:\n\n${failedContext}\n\nDATA MODELS FOR REFERENCE:\n${JSON.stringify(architecture.dataModels, null, 2)}`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    2,
    'sql_fix'
  );

  const text = extractText(response);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'sql_fix', projectId);

  let fixSql = text.trim();
  fixSql = fixSql.replace(/^```sql\n?/g, '').replace(/^```\n?/g, '').replace(/\n?```$/g, '').trim();
  fixSql = postProcessSql(fixSql);

  return fixSql;
}

// ============================================================
// PHASE 3: MODULE-BASED PAGE GENERATION (improved)
// ============================================================

export function groupPagesIntoModules(architecture: FullArchitecture): FeatureModule[] {
  const pages = architecture.pages || [];
  const moduleMap = new Map<string, ArchitecturePage[]>();

  for (const page of pages) {
    const moduleName = page.module || inferModule(page);
    const existing = moduleMap.get(moduleName) || [];
    existing.push(page);
    moduleMap.set(moduleName, existing);
  }

  const modules: FeatureModule[] = [];
  for (const [name, modulePages] of moduleMap) {
    const role = modulePages[0]?.role || 'public';
    modules.push({
      name,
      pages: modulePages,
      role,
      description: `${name} module (${modulePages.length} pages) for ${role} role`,
    });
  }

  return modules;
}

function inferModule(page: ArchitecturePage): string {
  const name = page.name.toLowerCase();
  if (name.includes('login') || name.includes('register') || name.includes('forgot') || name.includes('verify')) return 'auth';
  if (name.includes('admin')) return 'admin';
  if (name.includes('dashboard')) return 'dashboard';
  if (name.includes('setting') || name.includes('profile')) return 'settings';
  if (name.includes('404') || name.includes('terms') || name.includes('privacy')) return 'support';
  return 'main';
}

export async function generateModuleCode(
  module: FeatureModule,
  project: Project,
  client: Client,
  architecture: FullArchitecture,
  coreFiles: { path: string; content: string }[],
  allFilePaths: string[],
  previousExports?: string,
  stubPathsHint?: string,
  recoveryMode?: 'simplified' | 'isolated'
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const hasBackend = architecture.requiresBackend;

  const coreContext = coreFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const pageList = module.pages
    .map((p) => `- ${p.name} (${p.route}): ${p.description}`)
    .join('\n');

  const relevantModels = hasBackend
    ? (architecture.dataModels || []).filter((m) => {
        const modulePages = module.pages.map((p) => p.name.toLowerCase()).join(' ');
        return modulePages.includes(m.name.toLowerCase().replace(/_/g, ''));
      })
    : [];

  const systemPrompt = `You are a senior full-stack developer at Obzide Tech implementing a feature module.
You are building ALL pages in this module together to ensure consistency.

MODULE: ${module.name} (${module.pages.length} pages)
ROLE: ${module.role}

FILE OUTPUT FORMAT (MANDATORY):
- Every file MUST start with exactly: // FILE: path/to/file.ext
- Wrap each file in a fenced code block (\`\`\`tsx or \`\`\`ts)
- Output ONLY files that need to be created or modified
- For page components, use EXACTLY the file paths listed in PAGE FILE PATHS below
- NEVER put pages in subdirectories unless the existing stub is already in a subdirectory

AVAILABLE IMPORTS (ONLY import from these sources):
NPM packages: react, react-dom, react-router-dom, lucide-react, date-fns${hasBackend ? ', @supabase/supabase-js' : ''}
Project files that EXIST (listed in "OTHER FILES IN PROJECT" below)
Files you are CREATING in this same response

FORBIDDEN IMPORTS (NEVER use these):
- Any path not listed in "OTHER FILES IN PROJECT" or created in this response
- @/ path aliases (use relative paths: ./ or ../)
- react-native, expo, @mui/*, styled-components, axios, lodash, moment, @headlessui/*, @radix-ui/*
- Hypothetical files or files that "might be created later" by another module

IMPLEMENTATION RULES:
- Follow existing code patterns, component structure, and styling conventions exactly
- Use the shared Layout, Navbar, Footer components already in the project
- Use brand colors defined in tailwind.config.js as Tailwind classes
- Every page must be fully responsive (mobile, tablet, desktop)
- Include meaningful, realistic content (NOT lorem ipsum)
- Add hover states, focus states, transitions, and micro-interactions
- Use lucide-react for all icons
- Use react-router-dom Link/useNavigate for navigation
- Brand colors: ${JSON.stringify(client.brand_colors)}
- Brand fonts: ${JSON.stringify(client.brand_fonts)}
${hasBackend ? `
BACKEND INTEGRATION (CRITICAL):
- Import and use Supabase client from src/lib/supabase.ts
- Import types from src/lib/types.ts
- Import API functions from src/lib/api.ts (use ONLY functions that are exported there)
- Forms MUST call real API functions (create, update, delete) with proper error handling
- Lists MUST fetch data using getAll/getById from api.ts with loading and error states
- Tables MUST have: search input, column sorting, pagination (10-20 per page)
- Protected pages MUST use useAuth() hook to check authentication and role
- Show loading spinners during API calls
- Show toast/alert on success and error
- If a needed API function is not in api.ts, use supabase client directly (do NOT assume functions exist)` : `
DEMO DATA:
- Import mock data from src/lib/mock-data.ts
- Use local state for filtering, searching, and sorting
- Forms should update local state (demo mode)`}

QUALITY STANDARDS:
- Production-ready code - this ships to real clients
- Clean TypeScript types for all props and state
- Accessible: aria labels, semantic HTML, keyboard navigation
- Proper heading hierarchy
- Each page component must be fully featured, minimum 150 lines
- Create sub-components when sections get complex (put them in the same module directory or components/)
- NEVER use purple/indigo unless brand colors include them
${recoveryMode === 'simplified' ? `
SIMPLIFIED MODE (this is a retry - the previous attempt failed to compile):
- Generate SIMPLER pages that are GUARANTEED to compile
- No complex data tables, no multi-step forms, no advanced state management
- Use simple lists instead of sortable tables
- Use simple forms instead of multi-step wizards
- Minimize cross-file dependencies
- If a shared utility/hook might not exist, inline the logic instead
` : ''}${recoveryMode === 'isolated' ? `
ISOLATION MODE (NUCLEAR - this module has failed multiple times):
- Each file MUST be 100% self-contained with ZERO imports from other src/ files
- The ONLY allowed imports are npm packages: react, react-dom, react-router-dom, lucide-react, @supabase/supabase-js, date-fns
- Define ALL TypeScript types inline within each file
- Use inline mock data instead of importing from shared files
- Each file is an independent island that CANNOT have import errors
- Keep components simple but functional
` : ''}`;

  const stubPathsSection = stubPathsHint
    ? `\nPAGE FILE PATHS (use these EXACT paths for each page component):\n${stubPathsHint}\n`
    : '';

  const exportsSection = previousExports
    ? `\n${previousExports}\n`
    : '';

  const userPrompt = `IMPLEMENT THIS MODULE COMPLETELY:

MODULE: ${module.name}
PAGES TO BUILD:
${pageList}
${stubPathsSection}${exportsSection}
${relevantModels.length > 0 ? `RELEVANT DATA MODELS:\n${JSON.stringify(relevantModels, null, 2)}` : ''}

FULL ARCHITECTURE:
${JSON.stringify(architecture, null, 2)}

EXISTING CORE FILES:
${coreContext}

OTHER FILES IN PROJECT (for reference):
${allFilePaths.join(', ')}

Generate ALL ${module.pages.length} pages completely. Every page must be production-ready with full functionality.`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'module_code'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'module_code', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

// ============================================================
// COMPLETENESS VERIFICATION
// ============================================================

export async function verifyProjectCompleteness(
  architecture: FullArchitecture,
  repoFiles: { path: string; content: string }[],
  projectId: string
): Promise<{ missingFiles: string[]; brokenImports: string[]; missingRoutes: string[]; fixFiles: GeneratedFile[] }> {
  const ai = await getClient();
  const model = selectModel('completeness_check');

  const filePaths = repoFiles.map((f) => f.path);
  const appTsx = repoFiles.find((f) => f.path.includes('App.tsx'));
  const navbarFile = repoFiles.find((f) => f.path.toLowerCase().includes('navbar'));

  const systemPrompt = `You are a QA engineer verifying that a generated project is complete and has no broken references.

Analyze the project and identify:
1. Pages in the architecture that don't have a corresponding file
2. Routes in App.tsx that import files that don't exist
3. Navbar links pointing to routes that don't exist in App.tsx
4. Any import statements referencing files that don't exist in the project

Also generate fix files for any critical issues (missing App.tsx routes, broken imports).

Output JSON only:
{
  "missingFiles": ["path/to/missing/file.tsx"],
  "brokenImports": ["ComponentX imported in App.tsx but file not found"],
  "missingRoutes": ["PageY exists but has no route in App.tsx"],
  "fixFiles": [{"path": "src/App.tsx", "content": "complete fixed file content"}]
}`;

  const fileListStr = filePaths.join('\n');
  const appContent = appTsx?.content || 'NOT FOUND';
  const navContent = navbarFile?.content || 'NOT FOUND';

  const archPages = (architecture.pages || []).map((p) => `${p.name} -> ${p.route}`).join('\n');

  const thinking: ThinkingConfig = { enabled: true, budgetTokens: 8000 };

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 24000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `ARCHITECTURE PAGES:\n${archPages}\n\nALL FILES IN REPO:\n${fileListStr}\n\nApp.tsx:\n${appContent}\n\nNavbar:\n${navContent}`,
      }],
      ...buildThinkingParams(thinking),
    }),
    2,
    'completeness_check'
  );

  const { text } = extractThinkingAndText(response);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'completeness_check', projectId);

  return safeParseJSON(text, { missingFiles: [], brokenImports: [], missingRoutes: [], fixFiles: [] });
}

// ============================================================
// BUILD FIX (improved with cycle detection)
// ============================================================

export async function generateBuildFix(
  buildErrors: string[],
  buildOutput: string,
  project: Project,
  client: Client,
  architecture: Record<string, unknown>,
  existingFiles: { path: string; content: string }[],
  previousAttempts: BuildFixAttempt[],
  attempt: number,
  maxAttempts: number,
  options?: { forceOpus?: boolean; strategy?: 'standard' | 'simplify' | 'regenerate' | 'isolate'; allFilePaths?: string[] }
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const useOpus = options?.forceOpus || attempt >= maxAttempts - 1;
  const model = useOpus ? MODELS.opus : MODELS.sonnet;
  const strategy = options?.strategy || 'standard';

  const previousAttemptsContext = previousAttempts.length > 0
    ? `\n\nPREVIOUS FIX ATTEMPTS THAT FAILED:\n${previousAttempts.map((a, i) => {
      const filesModified = a.filesModified?.length
        ? `\nFiles modified: ${a.filesModified.join(', ')}`
        : '';
      return `--- Attempt ${i + 1} (strategy: ${a.strategy || 'standard'}) ---\nErrors after fix: ${a.errorsText}${filesModified}`;
    }).join('\n\n')}\n\nIMPORTANT: The above approaches did NOT work. Try a COMPLETELY DIFFERENT strategy. Do NOT repeat the same file changes.`
    : '';

  const MAX_CONTEXT_CHARS = 250_000;
  let existingContext = '';
  let charBudget = MAX_CONTEXT_CHARS;
  const sortedFiles = [...existingFiles].sort((a, b) => {
    const aIsError = buildErrors.some((e) => e.includes(a.path.replace('src/', '')));
    const bIsError = buildErrors.some((e) => e.includes(b.path.replace('src/', '')));
    if (aIsError && !bIsError) return -1;
    if (!aIsError && bIsError) return 1;
    return 0;
  });
  for (const f of sortedFiles) {
    const entry = `--- ${f.path} ---\n${f.content}\n\n`;
    if (entry.length <= charBudget) {
      existingContext += entry;
      charBudget -= entry.length;
    }
  }

  const strategyInstructions: Record<string, string> = {
    standard: `Fix the root cause, not just the symptom.
- If a dependency doesn't exist in npm, REMOVE it from package.json
- If an import references a file that doesn't exist, either create the file or remove the import`,
    simplify: `SIMPLIFICATION STRATEGY: Remove complexity to make the build pass.
- Remove ALL imports that reference non-existent files instead of creating them
- Replace complex components with simple placeholder implementations
- Remove unused dependencies from package.json
- Goal: make the build PASS even if some features are simplified`,
    regenerate: `REGENERATION STRATEGY: Rewrite broken files from scratch.
- Do NOT try to patch existing code -- write fresh implementations
- Use ONLY imports that you can verify exist in the files provided below
- Keep implementations simple but functional
- Every component must compile independently`,
    isolate: `ISOLATION STRATEGY (NUCLEAR OPTION): Each file MUST be 100% self-contained.
- Each component file MUST compile with ZERO imports from other src/ files
- The ONLY allowed imports are: react, react-dom, react-router-dom, lucide-react, @supabase/supabase-js, date-fns (npm packages only)
- Do NOT import from src/lib/*, src/contexts/*, src/hooks/*, src/components/* -- inline everything you need
- Define all TypeScript types inline within each file
- Use inline mock data instead of importing from shared files
- Each file must be a completely independent island that cannot possibly have import errors
- Keep components simple: a header, some content, basic styling with Tailwind
- This MUST compile. Simplicity over features.`,
  };

  const allFilePathsSection = options?.allFilePaths?.length
    ? `\n- IMPORTANT: The project contains these files (use this list to verify imports):\n${options.allFilePaths.map((p) => `  ${p}`).join('\n')}`
    : '';

  const systemPrompt = `You are a senior developer fixing build errors in a React + Vite + TypeScript project.
${useOpus ? 'This is the FINAL attempt. Apply the most robust fix possible.' : ''}

RULES:
- Output ONLY files that need changes
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Output COMPLETE file contents (not partial patches)
- ${strategyInstructions[strategy] || strategyInstructions.standard}
- NEVER introduce React Native or Expo dependencies
- Every import MUST reference a file that actually exists in the project file list below
- If an import references a file that does not exist, REMOVE the import and the code using it
${previousAttempts.length > 0 ? '- Previous fix attempts failed. You MUST take a COMPLETELY different approach.' : ''}${allFilePathsSection}`;

  const userPrompt = `BUILD ERRORS (attempt ${attempt}/${maxAttempts}, strategy: ${strategy}):
${buildErrors.join('\n')}

FULL BUILD OUTPUT:
${buildOutput.slice(-15000)}
${previousAttemptsContext}

EXISTING CODE:
${existingContext}

Fix all errors. Output complete corrected files.`;

  const thinkingParams = useOpus ? buildThinkingParams({ enabled: true, budgetTokens: 10000 }) : {};

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...thinkingParams,
    }),
    3,
    'build_fix'
  );

  const { text } = extractThinkingAndText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'build_fix', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

// ============================================================
// AUTOMATED QA FIX (visual/layout issues from screenshot analysis)
// ============================================================

export async function generateAutoQAFix(
  failedPages: { pageName: string; issues: string[]; score: number }[],
  existingFiles: { path: string; content: string }[],
  project: Project,
  client: Client,
  architecture: Record<string, unknown>,
  attempt: number,
  maxAttempts: number
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = attempt >= maxAttempts - 1 ? MODELS.opus : MODELS.sonnet;

  const issuesSummary = failedPages
    .map((fp) => `${fp.pageName} (score: ${fp.score}/100):\n${fp.issues.map((i) => `  - ${i}`).join('\n')}`)
    .join('\n\n');

  const MAX_QA_CONTEXT_CHARS = 120_000;
  let codeContext = '';
  let charBudget = MAX_QA_CONTEXT_CHARS;
  const failedPageNames = new Set(failedPages.map((fp) => fp.pageName.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const sortedFiles = [...existingFiles].sort((a, b) => {
    const aRelevant = failedPageNames.has(a.path.replace(/.*\//, '').replace(/\.\w+$/, '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    const bRelevant = failedPageNames.has(b.path.replace(/.*\//, '').replace(/\.\w+$/, '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (aRelevant && !bRelevant) return -1;
    if (!aRelevant && bRelevant) return 1;
    return 0;
  });
  for (const f of sortedFiles) {
    const entry = `--- ${f.path} ---\n${f.content}\n\n`;
    if (entry.length <= charBudget) {
      codeContext += entry;
      charBudget -= entry.length;
    }
  }

  const designSystem = (architecture as unknown as FullArchitecture)?.designSystem;
  const brandContext = designSystem
    ? `Brand: primary=${designSystem.primaryColor}, secondary=${designSystem.secondaryColor}, accent=${designSystem.accentColor}, fonts=${designSystem.fonts?.heading}/${designSystem.fonts?.body}, style=${designSystem.style}`
    : '';

  const systemPrompt = `You are a senior frontend developer at Obzide Tech fixing visual QA issues found during automated screenshot analysis.

These are NOT build/compile errors -- these are VISUAL and LAYOUT problems detected from screenshots across desktop, tablet, and mobile viewports.

PROJECT: ${project.name} for ${client.name} (${client.industry})
${brandContext}

RULES:
- Focus ONLY on visual/layout/responsive fixes -- do NOT change functionality or break working logic
- Fix layout issues: alignment, spacing, overflow, missing content, broken grids
- Fix responsive issues: ensure proper breakpoints at 768px (tablet) and 640px (mobile)
- Fix typography: readability, contrast, font sizes, line heights
- Fix color issues: proper contrast ratios, brand consistency, readable text on all backgrounds
- NEVER use purple/indigo unless brand colors specify them
- Output ONLY files that need visual changes
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Output COMPLETE file contents (not partial patches)
- Preserve ALL existing imports and functionality
- Use Tailwind CSS for all styling fixes
- Ensure fixes work across ALL viewports (desktop, tablet, mobile)
${attempt > 1 ? '- Previous QA fix attempts did not fully resolve issues. Be more aggressive with fixes.' : ''}`;

  const userPrompt = `QA ISSUES FOUND (attempt ${attempt}/${maxAttempts}):

${issuesSummary}

EXISTING CODE:
${codeContext}

Fix all visual issues listed above. Output complete corrected files.`;

  const thinkingParams = model === MODELS.opus ? buildThinkingParams({ enabled: true, budgetTokens: 8000 }) : {};

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...thinkingParams,
    }),
    3,
    'qa_fix'
  );

  const { text } = extractThinkingAndText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'qa_fix', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

// ============================================================
// LEGACY: generateTaskCode (kept for backwards compat with chat/QA)
// ============================================================

export async function generateTaskCode(
  task: { title: string; description: string },
  project: Project,
  client: Client,
  architecture: Record<string, unknown>,
  existingFiles: { path: string; content: string }[]
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const relevantFiles = existingFiles.filter((f) => {
    const taskSlug = task.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const fileLower = f.path.toLowerCase();
    return fileLower.includes(taskSlug) ||
      fileLower.includes('layout') ||
      fileLower.includes('app.tsx') ||
      fileLower.includes('navbar') ||
      fileLower.includes('footer') ||
      fileLower.includes('index.css') ||
      fileLower.includes('tailwind.config') ||
      fileLower.includes('supabase') ||
      fileLower.includes('types') ||
      fileLower.includes('api.ts') ||
      fileLower.includes('auth');
  });

  const allOtherPaths = existingFiles
    .filter((f) => !relevantFiles.some((r) => r.path === f.path))
    .map((f) => f.path);

  const existingContext = relevantFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior full-stack developer at Obzide Tech implementing a specific task.

FILE OUTPUT FORMAT:
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Output ONLY files that need to be created or modified

IMPLEMENTATION RULES:
- Follow existing code patterns
- Use brand colors: ${JSON.stringify(client.brand_colors)}
- Use brand fonts: ${JSON.stringify(client.brand_fonts)}
- Fully responsive (mobile, tablet, desktop)
- Include meaningful content (NOT lorem ipsum)
- Add transitions and micro-interactions
- Use lucide-react for icons
- NEVER use purple/indigo unless brand colors specify them
- NEVER use React Native or Expo`;

  const userPrompt = `TASK: ${task.title}
DESCRIPTION: ${task.description}

ARCHITECTURE:
${JSON.stringify(architecture, null, 2)}

EXISTING CODE:
${existingContext}

OTHER FILES:
${allOtherPaths.join(', ')}

Generate the complete implementation.`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'task_code'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'task_code', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

// ============================================================
// CHAT RESPONSE
// ============================================================

export async function generateChatResponse(
  messages: { role: 'user' | 'assistant'; content: string }[],
  projectContext: string
): Promise<{ response: string; files: GeneratedFile[]; shouldRedeploy: boolean }> {
  if (!messages || messages.length === 0) {
    return { response: 'No messages to respond to.', files: [], shouldRedeploy: false };
  }

  const ai = await getClient();
  const model = MODELS.sonnet;

  const systemPrompt = `You are the Obzide Dev Agent, an AI assistant that builds and modifies web projects.
You are chatting with a team member about a specific project.

PROJECT CONTEXT:
${projectContext}

CAPABILITIES:
- Modify code files (output them with // FILE: path comments in code blocks)
- Answer project questions
- Suggest improvements and fixes
- Explain architectural decisions

RULES:
- Be concise and direct
- NEVER ask clarifying questions about the brief, technology stack, or architecture. The brief processing pipeline handles that automatically. Just acknowledge and proceed.
- If the project has no architecture yet, inform the user the brief is being analyzed and the build pipeline will start shortly.
- If you modify code, output complete files (not diffs)
- Use the same conventions as the existing codebase
- NEVER use React Native or Expo
- End your response with a JSON metadata block:
\`\`\`json
{"shouldRedeploy": true/false}
\`\`\`
- Set shouldRedeploy to true when you output code changes`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    3,
    'chat'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'chat');

  let shouldRedeploy = false;
  const metaMatch = text.match(/```json\s*\n\s*\{[^}]*"shouldRedeploy"\s*:\s*(true|false)[^}]*\}\s*\n?\s*```/);
  if (metaMatch) {
    shouldRedeploy = metaMatch[1] === 'true';
  } else if (files.length > 0) {
    shouldRedeploy = true;
  }

  const responseText = text
    .replace(/```json\s*\n\s*\{[^}]*"shouldRedeploy"[^}]*\}\s*\n?\s*```/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();

  return { response: responseText || 'Done. Changes applied.', files, shouldRedeploy };
}

// ============================================================
// QA FUNCTIONS (kept from original)
// ============================================================

export async function analyzeQARejection(
  rejectionNotes: string,
  pageName: string,
  currentCode: { path: string; content: string }[],
  briefContext: string,
  screenshotUrls?: { desktop?: string; tablet?: string; mobile?: string }
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = selectModel('qa_fix_complex');

  const codeContext = currentCode
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior frontend developer at Obzide Tech fixing QA issues.
A QA screenshot was rejected. Fix the exact issues described in the rejection notes.

RULES:
- Only output files that need changes
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Fix what was flagged precisely
- Maintain existing code style
- Ensure fixes are responsive across all viewports
- NEVER use purple/indigo unless brand colors specify them`;

  const userContent: Array<Record<string, unknown>> = [];

  for (const [label, url] of Object.entries(screenshotUrls || {})) {
    if (url) {
      const img = await fetchImageBase64(url);
      if (img) {
        userContent.push({ type: 'text', text: `--- ${label.toUpperCase()} VIEWPORT ---` });
        userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
    }
  }

  userContent.push({
    type: 'text',
    text: `PAGE: ${pageName}
REJECTION NOTES: ${rejectionNotes}

BRIEF CONTEXT:
${briefContext}

CURRENT CODE:
${codeContext}

Fix the problems described in the rejection notes.`,
  });

  const thinking: ThinkingConfig = { enabled: true, budgetTokens: 8000 };

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 24000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent as never }],
      ...buildThinkingParams(thinking),
    }),
    3,
    'qa_fix'
  );

  const { text } = extractThinkingAndText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'qa_fix');

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

interface ViewportQAResult {
  viewport: string;
  issues: string[];
  pass: boolean;
  score: number;
}

export async function analyzeScreenshotAllViewports(
  screenshotUrls: { desktop?: string; tablet?: string; mobile?: string },
  pageName: string,
  expectedDescription: string,
  projectId: string
): Promise<{ viewports: ViewportQAResult[]; overallPass: boolean; overallScore: number }> {
  const viewports: ViewportQAResult[] = [];

  const entries = Object.entries(screenshotUrls).filter(([, url]) => url);

  const viewportCriteria: Record<string, string> = {
    desktop: `Desktop-specific checks: overall layout balance, whitespace usage, content hierarchy, proper grid alignment`,
    tablet: `Tablet-specific checks: proper responsive breakpoints at ~768px, touch-friendly sizing`,
    mobile: `Mobile-specific checks: hamburger menu, text readable without zooming, no horizontal overflow`,
  };

  const viewportAnalysis = await Promise.all(
    entries.map(async ([viewport, url]) => {
      if (!url) {
        return {
          viewport,
          issues: ['Screenshot not available for analysis'],
          pass: false,
          score: 0,
        };
      }

      const prompt = `You are performing QA review of the "${pageName}" page - ${viewport.toUpperCase()} viewport.

EXPECTED: ${expectedDescription}

${viewportCriteria[viewport] || ''}

Score each category 0-100:
- layout, typography, colors, responsiveness, quality

Respond with JSON only:
{"issues": ["specific issue 1", ...], "pass": true/false, "scores": {"layout": 90, "typography": 85, "colors": 90, "responsiveness": 85, "quality": 80}}

Pass threshold: all scores >= 75 and no critical issues.`;

      const result = await analyzeImage(url, prompt, projectId, 'haiku');

      if (!result || result.trim().length === 0) {
        return {
          viewport,
          issues: ['Screenshot analysis returned empty result'],
          pass: false,
          score: 0,
        };
      }

      const parsed = safeParseJSON<{
        issues: string[];
        pass: boolean;
        scores?: Record<string, number>;
      }>(result, { issues: [], pass: true, scores: {} });

      const scores = parsed.scores || {};
      const avgScore = Object.values(scores).length > 0
        ? Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length)
        : parsed.pass ? 90 : 60;

      return {
        viewport,
        issues: parsed.issues,
        pass: parsed.pass && avgScore >= 75,
        score: avgScore,
      };
    })
  );

  viewports.push(...viewportAnalysis);

  const overallScore = viewports.length > 0
    ? Math.round(viewports.reduce((a, v) => a + v.score, 0) / viewports.length)
    : 100;

  return {
    viewports,
    overallPass: viewports.every((v) => v.pass),
    overallScore,
  };
}

export async function analyzeScreenshot(
  screenshotUrl: string,
  pageName: string,
  expectedDescription: string,
  projectId: string
): Promise<{ issues: string[]; pass: boolean }> {
  const result = await analyzeImage(
    screenshotUrl,
    `You are reviewing a QA screenshot of the "${pageName}" page.
EXPECTED: ${expectedDescription}
Analyze for: layout, typography, colors, responsive, content, quality.
Respond with JSON only:
{"issues": ["issue 1"], "pass": true/false}`,
    projectId,
    'haiku'
  );

  return safeParseJSON(result, { issues: [], pass: true });
}

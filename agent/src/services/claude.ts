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

async function getClient(): Promise<Anthropic> {
  const key = await getSecretWithFallback('anthropic');
  if (!key) throw new Error('Anthropic API key not configured');
  if (!anthropic || (anthropic as unknown as Record<string, string>)._apiKey !== key) {
    anthropic = new Anthropic({ apiKey: key });
  }
  return anthropic;
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
  } catch { /* non-critical */ }
}

async function callWithRetry(
  fn: () => Promise<Anthropic.Message>,
  maxRetries: number = 3,
  operation: string = 'unknown'
): Promise<Anthropic.Message> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const is400 = lastError.message.includes('400') || lastError.message.includes('invalid_request');
      if (is400) throw lastError;

      const isRetryable = lastError.message.includes('overloaded') ||
        lastError.message.includes('rate_limit') ||
        lastError.message.includes('timeout') ||
        lastError.message.includes('529') ||
        lastError.message.includes('500');

      if (!isRetryable || attempt === maxRetries) throw lastError;

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30_000);
      await logger.warn(
        `Claude API retry ${attempt + 1}/${maxRetries} for ${operation}: ${lastError.message}`,
        'ai'
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Retry exhausted');
}

function parseCodeBlocks(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();

  const patterns = [
    /```(?:\w+)?\s*\n\/\/\s*FILE:\s*(.+?)\n([\s\S]*?)```/g,
    /---\s*(\S+)\s*---\n```(?:\w+)?\n([\s\S]*?)```/g,
    /```(?:\w+)?\s*\n\/\*\s*FILE:\s*(.+?)\s*\*\/\n([\s\S]*?)```/g,
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
    if (files.length > 0) return files;
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
Determine the project type: website, landing, ecommerce, crm, lms, dashboard, saas, blog, portfolio, marketplace, or custom.
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
    "projectType": "lms|ecommerce|crm|website|landing|dashboard|saas|blog|portfolio|marketplace|custom",
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

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'brief_analysis'
  );

  const text = extractText(response);
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
  }

  return result;
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

THINK BEFORE CODING:
1. Review the architecture plan - identify ALL files needed
2. Plan the component hierarchy and shared styles
3. Ensure brand colors and fonts are properly configured
4. Plan responsive breakpoints and animation approach
5. Ensure package.json has CORRECT dependency versions

FILE OUTPUT FORMAT:
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Use the exact path relative to project root

REQUIRED FILES:
- package.json (MUST include: react, react-dom, react-router-dom, lucide-react, tailwindcss, postcss, autoprefixer, @vitejs/plugin-react, vite, typescript${hasBackend ? ', @supabase/supabase-js' : ''})
- package.json MUST have scripts: {"dev": "vite", "build": "vite build", "preview": "vite preview"}
- vite.config.ts
- tsconfig.json, tsconfig.app.json, tsconfig.node.json
- tailwind.config.js (with brand colors as custom theme colors)
- postcss.config.js
- index.html (with Google Fonts link if custom fonts specified)
- src/main.tsx (with BrowserRouter, ${hasBackend ? 'AuthProvider wrapping everything' : 'AppProvider if using context'})
- src/App.tsx (with routes for ALL ${(architecture.pages || []).length} pages from the architecture)
- src/index.css (Tailwind directives + custom fonts + base styles + scroll animations)
- src/components/Layout.tsx (shared layout with nav + footer, responsive hamburger)
- src/components/Navbar.tsx (sticky, responsive, brand-colored${hasBackend ? ', auth-aware with role-based navigation' : ''})
- src/components/Footer.tsx (professional with links, social, copyright)
${backendFiles}
- One STUB file per page in src/pages/ (each page file should export a functional component with realistic placeholder content indicating what will be built)

CRITICAL RULES:
- NEVER use React Native, Expo, or any mobile-native libraries
- NEVER include react-native or expo in package.json
- package.json dependencies must be REAL npm packages with valid versions
- Use "react": "^18.3.1", "react-dom": "^18.3.1", "react-router-dom": "^7.1.0"
- Use "lucide-react": "^0.344.0", "tailwindcss": "^3.4.1"${hasBackend ? ', "@supabase/supabase-js": "^2.57.4"' : ''}
- Use "@vitejs/plugin-react": "^4.3.1", "vite": "^5.4.2", "typescript": "^5.5.3"
- Every page component must be exported as default
- App.tsx must import ALL page components and define routes for them
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

  const systemPrompt = `You are a senior database architect generating PostgreSQL migrations for a Supabase project.

RULES:
- Generate CREATE TABLE statements for ALL data models
- Use uuid PRIMARY KEY DEFAULT gen_random_uuid() for id columns
- Use timestamptz DEFAULT now() for created_at columns
- Add updated_at timestamptz DEFAULT now() where appropriate
- Add proper FOREIGN KEY constraints
- Add indexes on frequently queried columns (foreign keys, status fields)
- Enable RLS on EVERY table: ALTER TABLE tablename ENABLE ROW LEVEL SECURITY;
- Create RLS policies based on the rls rules provided for each model
- Use auth.uid() for user ownership checks
- Add a trigger function for auto-updating updated_at columns
- Generate realistic seed data (10-20 rows per table) unless the brief says "demo" or seed data is inappropriate
- DO NOT wrap in transaction blocks (no BEGIN/COMMIT)
- Use IF NOT EXISTS where possible

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

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'backend_schema'
  );

  const text = extractText(response);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'backend_schema', projectId);

  let sql = text.trim();
  sql = sql.replace(/^```sql\n?/g, '').replace(/^```\n?/g, '').replace(/\n?```$/g, '').trim();

  return sql;
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
  allFilePaths: string[]
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

THINK BEFORE CODING:
1. Study the existing components to match patterns exactly
2. Plan shared state/hooks within this module
3. Plan consistent styling across all pages in this module
4. Ensure forms have real validation and call real API functions
5. Ensure tables have search, filter, and pagination

FILE OUTPUT FORMAT:
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Output ONLY files that need to be created or modified

IMPLEMENTATION RULES:
- Follow existing code patterns, component structure, and styling conventions
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
- Import API functions from src/lib/api.ts
- Forms MUST call real API functions (create, update, delete) with proper error handling
- Lists MUST fetch data using getAll/getById from api.ts with loading and error states
- Tables MUST have: search input, column sorting, pagination (10-20 per page)
- Protected pages MUST use useAuth() hook to check authentication and role
- Show loading spinners during API calls
- Show toast/alert on success and error
- Modals for create/edit forms where appropriate` : `
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
- NEVER use purple/indigo unless brand colors include them`;

  const userPrompt = `IMPLEMENT THIS MODULE COMPLETELY:

MODULE: ${module.name}
PAGES TO BUILD:
${pageList}

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

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `ARCHITECTURE PAGES:\n${archPages}\n\nALL FILES IN REPO:\n${fileListStr}\n\nApp.tsx:\n${appContent}\n\nNavbar:\n${navContent}`,
      }],
    }),
    2,
    'completeness_check'
  );

  const text = extractText(response);
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
  maxAttempts: number
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const useOpus = attempt >= maxAttempts - 1;
  const model = useOpus ? MODELS.opus : MODELS.sonnet;

  const previousAttemptsContext = previousAttempts.length > 0
    ? `\n\nPREVIOUS FIX ATTEMPTS THAT FAILED:\n${previousAttempts.map((a, i) => `--- Attempt ${i + 1} ---\nErrors: ${a.errorsText}`).join('\n\n')}\n\nIMPORTANT: The above approaches did NOT work. Try a DIFFERENT strategy.`
    : '';

  const existingContext = existingFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior developer fixing build errors in a React + Vite + TypeScript project.
${useOpus ? 'This is the FINAL attempt. Apply the most robust fix possible.' : ''}

RULES:
- Output ONLY files that need changes
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Output COMPLETE file contents (not partial patches)
- Fix the root cause, not just the symptom
- If a dependency doesn't exist in npm, REMOVE it from package.json
- If an import references a file that doesn't exist, either create the file or remove the import
- NEVER introduce React Native or Expo dependencies
${previousAttempts.length > 0 ? '- Previous fix attempts failed. You MUST take a different approach.' : ''}`;

  const userPrompt = `BUILD ERRORS (attempt ${attempt}/${maxAttempts}):
${buildErrors.join('\n')}

FULL BUILD OUTPUT:
${buildOutput.slice(0, 4000)}
${previousAttemptsContext}

EXISTING CODE:
${existingContext}

Fix all errors. Output complete corrected files.`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'build_fix'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'build_fix', project.id);

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

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent as never }],
    }),
    3,
    'qa_fix'
  );

  const text = extractText(response);
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

  for (const [viewport, url] of entries) {
    const prompt = `You are performing QA review of the "${pageName}" page - ${viewport.toUpperCase()} viewport.

EXPECTED: ${expectedDescription}

${viewportCriteria[viewport] || ''}

Score each category 0-100:
- layout, typography, colors, responsiveness, quality

Respond with JSON only:
{"issues": ["specific issue 1", ...], "pass": true/false, "scores": {"layout": 90, "typography": 85, "colors": 90, "responsiveness": 85, "quality": 80}}

Pass threshold: all scores >= 75 and no critical issues.`;

    const result = await analyzeImage(url!, prompt, projectId, 'haiku');

    const parsed = safeParseJSON<{
      issues: string[];
      pass: boolean;
      scores?: Record<string, number>;
    }>(result, { issues: [], pass: true, scores: {} });

    const scores = parsed.scores || {};
    const avgScore = Object.values(scores).length > 0
      ? Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length)
      : parsed.pass ? 90 : 60;

    viewports.push({
      viewport,
      issues: parsed.issues,
      pass: parsed.pass && avgScore >= 75,
      score: avgScore,
    });
  }

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

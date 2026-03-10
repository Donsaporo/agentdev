import type { FullArchitecture } from '../core/types.js';

const CORE_DEPENDENCIES: Record<string, string> = {
  'react': '^18.3.1',
  'react-dom': '^18.3.1',
  'react-router-dom': '^7.1.0',
  'lucide-react': '^0.344.0',
  'date-fns': '^4.1.0',
};

const BACKEND_DEPENDENCIES: Record<string, string> = {
  '@supabase/supabase-js': '^2.57.4',
};

const DEV_DEPENDENCIES: Record<string, string> = {
  '@vitejs/plugin-react': '^4.3.1',
  '@types/react': '^18.3.5',
  '@types/react-dom': '^18.3.0',
  'autoprefixer': '^10.4.18',
  'postcss': '^8.4.35',
  'tailwindcss': '^3.4.1',
  'typescript': '^5.5.3',
  'vite': '^5.4.2',
};

export const ALLOWED_DEPENDENCIES = new Set([
  ...Object.keys(CORE_DEPENDENCIES),
  ...Object.keys(BACKEND_DEPENDENCIES),
]);

export const ALLOWED_DEV_DEPENDENCIES = new Set(Object.keys(DEV_DEPENDENCIES));

export const PROHIBITED_PACKAGES = [
  'react-native', 'expo', '@react-native', 'react-native-web',
  '@expo/', 'expo-', 'react-native-',
  '@emotion/', 'styled-components', '@mui/', 'antd', '@chakra-ui/',
  'next', 'gatsby', 'nuxt', 'svelte',
  'axios', 'lodash', 'moment', 'underscore',
  '@headlessui/', '@radix-ui/', '@mantine/',
  'bootstrap', 'jquery', 'angular',
];

const DANGEROUS_SCRIPT_PATTERNS = [
  /npm\s+install/i,
  /npm\s+i\b/i,
  /pnpm\s+install/i,
  /yarn\s+install/i,
  /yarn\s+add/i,
  /pnpm\s+add/i,
];

export function generatePackageJson(
  projectName: string,
  hasBackend: boolean
): string {
  const deps = { ...CORE_DEPENDENCIES };
  if (hasBackend) {
    Object.assign(deps, BACKEND_DEPENDENCIES);
  }

  const pkg = {
    name: sanitizePackageName(projectName),
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: deps,
    devDependencies: { ...DEV_DEPENDENCIES },
  };

  return JSON.stringify(pkg, null, 2);
}

function sanitizePackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'project';
}

export function generateViteConfig(): string {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});`;
}

export function generateTsConfig(): string {
  return `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}`;
}

export function generateTsConfigApp(): string {
  return `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}`;
}

export function generateTsConfigNode(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}`;
}

export function generatePostcssConfig(): string {
  return `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`;
}

export function generateTailwindConfig(
  designSystem?: FullArchitecture['designSystem'],
  extractedSpec?: { colors?: Record<string, string>; fonts?: Record<string, string>; borderRadius?: string }
): string {
  const colors: Record<string, string> = {};
  const fonts: Record<string, string[]> = {};

  if (extractedSpec?.colors) {
    for (const [key, val] of Object.entries(extractedSpec.colors)) {
      if (val && val !== 'auto' && val.startsWith('#')) {
        colors[key] = val;
      }
    }
  }

  if (designSystem) {
    if (!colors.primary && designSystem.primaryColor) colors.primary = designSystem.primaryColor;
    if (!colors.secondary && designSystem.secondaryColor) colors.secondary = designSystem.secondaryColor;
    if (!colors.accent && designSystem.accentColor) colors.accent = designSystem.accentColor;
  }

  if (!colors.primary) colors.primary = '#0F172A';
  if (!colors.secondary) colors.secondary = '#475569';
  if (!colors.accent) colors.accent = '#0EA5E9';

  const headingFont = extractedSpec?.fonts?.heading && extractedSpec.fonts.heading !== 'auto'
    ? extractedSpec.fonts.heading
    : designSystem?.fonts?.heading || 'Inter';
  const bodyFont = extractedSpec?.fonts?.body && extractedSpec.fonts.body !== 'auto'
    ? extractedSpec.fonts.body
    : designSystem?.fonts?.body || 'Inter';

  fonts.heading = [`'${headingFont}'`, `'sans-serif'`];
  fonts.body = [`'${bodyFont}'`, `'sans-serif'`];

  const colorLines = Object.entries(colors)
    .map(([k, v]) => `        ${k}: '${v}',`)
    .join('\n');

  const fontLines = Object.entries(fonts)
    .map(([k, v]) => `        ${k}: [${v.join(', ')}],`)
    .join('\n');

  let borderRadiusExt = '';
  if (extractedSpec?.borderRadius && extractedSpec.borderRadius !== 'auto') {
    borderRadiusExt = `\n      borderRadius: {\n        DEFAULT: '${extractedSpec.borderRadius}',\n      },`;
  }

  return `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
${colorLines}
      },
      fontFamily: {
${fontLines}
      },${borderRadiusExt}
    },
  },
  plugins: [],
};`;
}

export function generateIndexHtml(
  title: string,
  fonts?: { heading?: string; body?: string }
): string {
  const fontFamilies = new Set<string>();
  if (fonts?.heading && fonts.heading !== 'Inter') fontFamilies.add(fonts.heading);
  if (fonts?.body && fonts.body !== 'Inter') fontFamilies.add(fonts.body);
  fontFamilies.add('Inter');

  const fontParam = Array.from(fontFamilies)
    .map((f) => `family=${f.replace(/\s+/g, '+')}:wght@300;400;500;600;700`)
    .join('&');
  const fontLink = `<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?${fontParam}&display=swap" rel="stylesheet" />`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%230F172A'/><text x='16' y='22' text-anchor='middle' fill='white' font-size='18' font-family='sans-serif'>O</text></svg>" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${fontLink}
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateIndexCss(fonts?: { heading?: string; body?: string }): string {
  const headingFont = fonts?.heading || 'Inter';
  const bodyFont = fonts?.body || 'Inter';

  return `@tailwind base;
@tailwind components;
@tailwind utilities;

html {
  scroll-behavior: smooth;
}

:root {
  font-family: '${bodyFont}', system-ui, -apple-system, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1, h2, h3, h4, h5, h6 {
  font-family: '${headingFont}', system-ui, -apple-system, sans-serif;
  line-height: 1.2;
}

body {
  margin: 0;
  min-height: 100vh;
}

::selection {
  background-color: rgba(14, 165, 233, 0.2);
}

*:focus-visible {
  outline: 2px solid rgba(14, 165, 233, 0.5);
  outline-offset: 2px;
}

button, a, input, select, textarea {
  transition: all 150ms ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.animate-fade-in {
  animation: fadeIn 0.4s ease-out forwards;
}

.animate-slide-up {
  animation: slideUp 0.5s ease-out forwards;
}

.animate-slide-down {
  animation: slideDown 0.3s ease-out forwards;
}

.animate-scale-in {
  animation: scaleIn 0.2s ease-out forwards;
}

.animate-pulse {
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.page-enter {
  animation: fadeIn 0.3s ease-out forwards;
}`;
}

export function generateMainTsx(hasBackend: boolean): string {
  if (hasBackend) {
    return `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);`;
  }

  return `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);`;
}

export function generateViteEnvDts(): string {
  return `/// <reference types="vite/client" />`;
}

export function generateEnvExample(): string {
  return `VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key`;
}

export function generateGitignore(): string {
  return `node_modules
dist
.env
.env.local
.env.*.local
*.log
.DS_Store
.vite`;
}

export function generateSupabaseClient(): string {
  return `import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase environment variables are not set. Database features will not work.');
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key'
);`;
}

export function generateAuthContext(): string {
  return `import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  session: null,
  loading: true,
  signUp: async () => ({ error: null }),
  signIn: async () => ({ error: null }),
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return { error: error ? new Error(error.message) : null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? new Error(error.message) : null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}

export { AuthContext };`;
}

export function generateUseAuth(): string {
  return `export { useAuth } from '../contexts/AuthContext';`;
}

export function generateLibTypes(architecture: FullArchitecture): string {
  const models = architecture.dataModels || [];
  if (models.length === 0) {
    return `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface UserProfile {
  id: string;
  email: string;
  created_at: string;
}`;
  }

  const typeMap: Record<string, string> = {
    uuid: 'string',
    text: 'string',
    integer: 'number',
    numeric: 'number',
    boolean: 'boolean',
    timestamptz: 'string',
    jsonb: 'Record<string, unknown>',
    'text[]': 'string[]',
  };

  const lines: string[] = [
    'export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];',
    '',
  ];

  for (const model of models) {
    const name = model.name.replace(/[^a-zA-Z0-9_]/g, '');
    const pascalName = name
      .split(/[-_]/)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');

    lines.push(`export interface ${pascalName} {`);

    const fields = model.fields || [];
    for (const field of fields) {
      const tsType = typeMap[field.type] || 'string';
      const optional = !field.required && !field.pk ? '?' : '';
      lines.push(`  ${field.name}${optional}: ${tsType};`);
    }

    if (!fields.some((f: { name: string }) => f.name === 'id')) {
      lines.push('  id: string;');
    }
    if (!fields.some((f: { name: string }) => f.name === 'created_at')) {
      lines.push('  created_at: string;');
    }

    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

export function generateLibApi(architecture: FullArchitecture): string {
  const models = architecture.dataModels || [];
  if (models.length === 0) {
    return `import { supabase } from './supabase';

export async function fetchData(table: string) {
  const { data, error } = await supabase.from(table).select('*');
  if (error) throw error;
  return data;
}`;
  }

  const lines: string[] = [
    "import { supabase } from './supabase';",
    '',
  ];

  for (const model of models) {
    const table = model.name;
    const camel = table
      .split(/[-_]/)
      .map((w: string, i: number) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join('');
    const pascal = table
      .split(/[-_]/)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');

    lines.push(`export async function get${pascal}() {`);
    lines.push(`  const { data, error } = await supabase.from('${table}').select('*');`);
    lines.push('  if (error) throw error;');
    lines.push('  return data;');
    lines.push('}');
    lines.push('');

    lines.push(`export async function get${pascal}ById(id: string) {`);
    lines.push(`  const { data, error } = await supabase.from('${table}').select('*').eq('id', id).maybeSingle();`);
    lines.push('  if (error) throw error;');
    lines.push('  return data;');
    lines.push('}');
    lines.push('');

    lines.push(`export async function create${pascal}(record: Omit<Record<string, unknown>, 'id' | 'created_at'>) {`);
    lines.push(`  const { data, error } = await supabase.from('${table}').insert(record).select().maybeSingle();`);
    lines.push('  if (error) throw error;');
    lines.push('  return data;');
    lines.push('}');
    lines.push('');

    lines.push(`export async function update${pascal}(id: string, updates: Record<string, unknown>) {`);
    lines.push(`  const { data, error } = await supabase.from('${table}').update(updates).eq('id', id).select().maybeSingle();`);
    lines.push('  if (error) throw error;');
    lines.push('  return data;');
    lines.push('}');
    lines.push('');

    lines.push(`export async function delete${pascal}(id: string) {`);
    lines.push(`  const { error } = await supabase.from('${table}').delete().eq('id', id);`);
    lines.push('  if (error) throw error;');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

export function sanitizePackageJson(content: string): {
  sanitized: string;
  issues: string[];
} {
  const issues: string[] = [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch {
    return {
      sanitized: generatePackageJson('project', false),
      issues: ['Invalid JSON in package.json, replaced with template'],
    };
  }

  if (!pkg.type || pkg.type !== 'module') {
    pkg.type = 'module';
    issues.push('Set type to "module"');
  }

  const scripts = (pkg.scripts || {}) as Record<string, string>;
  pkg.scripts = scripts;

  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue;

    const isDangerous = DANGEROUS_SCRIPT_PATTERNS.some((p) => p.test(value));
    if (isDangerous) {
      delete scripts[name];
      issues.push(`Removed dangerous script "${name}": "${value}"`);
    }
  }

  scripts.dev = 'vite';
  scripts.build = 'vite build';
  scripts.preview = 'vite preview';

  const deps = (pkg.dependencies || {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies || {}) as Record<string, string>;

  for (const key of Object.keys(deps)) {
    const isProhibited = PROHIBITED_PACKAGES.some(
      (p) => key === p || key.startsWith(p)
    );
    if (isProhibited) {
      delete deps[key];
      issues.push(`Removed prohibited dependency: ${key}`);
    }
  }

  for (const key of Object.keys(devDeps)) {
    const isProhibited = PROHIBITED_PACKAGES.some(
      (p) => key === p || key.startsWith(p)
    );
    if (isProhibited) {
      delete devDeps[key];
      issues.push(`Removed prohibited devDependency: ${key}`);
    }
  }

  for (const [key, ver] of Object.entries(CORE_DEPENDENCIES)) {
    if (!deps[key]) {
      deps[key] = ver;
      issues.push(`Added missing dependency: ${key}`);
    }
  }

  for (const [key, ver] of Object.entries(DEV_DEPENDENCIES)) {
    if (!devDeps[key]) {
      devDeps[key] = ver;
      issues.push(`Added missing devDependency: ${key}`);
    }
  }

  pkg.dependencies = deps;
  pkg.devDependencies = devDeps;

  return { sanitized: JSON.stringify(pkg, null, 2), issues };
}

export function getAllTemplateFiles(
  projectName: string,
  architecture: FullArchitecture,
  extractedSpec?: { colors?: Record<string, string>; fonts?: Record<string, string>; borderRadius?: string }
): { path: string; content: string }[] {
  const hasBackend = architecture.requiresBackend;
  const ds = architecture.designSystem;

  const resolvedFonts = {
    heading: extractedSpec?.fonts?.heading && extractedSpec.fonts.heading !== 'auto'
      ? extractedSpec.fonts.heading
      : ds?.fonts?.heading,
    body: extractedSpec?.fonts?.body && extractedSpec.fonts.body !== 'auto'
      ? extractedSpec.fonts.body
      : ds?.fonts?.body,
  };

  const files: { path: string; content: string }[] = [
    { path: 'package.json', content: generatePackageJson(projectName, hasBackend) },
    { path: 'vite.config.ts', content: generateViteConfig() },
    { path: 'tsconfig.json', content: generateTsConfig() },
    { path: 'tsconfig.app.json', content: generateTsConfigApp() },
    { path: 'tsconfig.node.json', content: generateTsConfigNode() },
    { path: 'postcss.config.js', content: generatePostcssConfig() },
    { path: 'tailwind.config.js', content: generateTailwindConfig(ds, extractedSpec) },
    { path: 'index.html', content: generateIndexHtml(projectName, resolvedFonts) },
    { path: 'src/main.tsx', content: generateMainTsx(hasBackend) },
    { path: 'src/index.css', content: generateIndexCss(resolvedFonts) },
    { path: 'src/vite-env.d.ts', content: generateViteEnvDts() },
    { path: '.gitignore', content: generateGitignore() },
  ];

  files.push(
    { path: 'src/components/ScrollToTop.tsx', content: generateScrollToTop() },
  );

  if (hasBackend) {
    files.push(
      { path: '.env.example', content: generateEnvExample() },
      { path: 'src/lib/supabase.ts', content: generateSupabaseClient() },
      { path: 'src/contexts/AuthContext.tsx', content: generateAuthContext() },
      { path: 'src/hooks/useAuth.ts', content: generateUseAuth() },
      { path: 'src/lib/types.ts', content: generateLibTypes(architecture) },
      { path: 'src/lib/api.ts', content: generateLibApi(architecture) },
    );
  }

  return files;
}

function generateScrollToTop(): string {
  return `import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export default function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}`;
}

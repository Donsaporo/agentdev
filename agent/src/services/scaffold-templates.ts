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
  designSystem?: FullArchitecture['designSystem']
): string {
  const colorExtension = designSystem
    ? `
      colors: {
        primary: '${designSystem.primaryColor || '#0F172A'}',
        secondary: '${designSystem.secondaryColor || '#475569'}',
        accent: '${designSystem.accentColor || '#0EA5E9'}',
      },
      fontFamily: {
        heading: ['${designSystem.fonts?.heading || 'Inter'}', 'sans-serif'],
        body: ['${designSystem.fonts?.body || 'Inter'}', 'sans-serif'],
      },`
    : '';

  return `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {${colorExtension}
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
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
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

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.animate-fade-in {
  animation: fadeIn 0.5s ease-out forwards;
}

.animate-slide-up {
  animation: slideUp 0.6s ease-out forwards;
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
  architecture: FullArchitecture
): { path: string; content: string }[] {
  const hasBackend = architecture.requiresBackend;
  const ds = architecture.designSystem;
  const fonts = ds?.fonts;

  const files: { path: string; content: string }[] = [
    { path: 'package.json', content: generatePackageJson(projectName, hasBackend) },
    { path: 'vite.config.ts', content: generateViteConfig() },
    { path: 'tsconfig.json', content: generateTsConfig() },
    { path: 'tsconfig.app.json', content: generateTsConfigApp() },
    { path: 'tsconfig.node.json', content: generateTsConfigNode() },
    { path: 'postcss.config.js', content: generatePostcssConfig() },
    { path: 'tailwind.config.js', content: generateTailwindConfig(ds) },
    { path: 'index.html', content: generateIndexHtml(projectName, fonts) },
    { path: 'src/main.tsx', content: generateMainTsx(hasBackend) },
    { path: 'src/index.css', content: generateIndexCss(fonts) },
    { path: 'src/vite-env.d.ts', content: generateViteEnvDts() },
  ];

  if (hasBackend) {
    files.push({ path: '.env.example', content: generateEnvExample() });
  }

  return files;
}

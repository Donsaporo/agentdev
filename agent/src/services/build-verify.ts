import { exec } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';

const BUILD_DIR = '/tmp/obzide-builds';

interface BuildResult {
  success: boolean;
  output: string;
  errors: string;
  errorType?: 'npm_install' | 'build' | 'clone' | 'unknown';
}

function runCommand(cmd: string, cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
        code: error ? (error.code ?? 1) : 0,
      });
    });
  });
}

const NPM_ERROR_PATTERNS = [
  /ETARGET/i, /ERESOLVE/i, /notarget/i, /E404/i,
  /No matching version found/i, /Could not resolve dependency/i,
  /ENOENT.*package\.json/i,
];

const REACT_NATIVE_PACKAGES = [
  'react-native', 'expo', '@react-native', 'react-native-web',
  '@expo/', 'expo-', 'react-native-',
];

function isNpmError(output: string): boolean {
  return NPM_ERROR_PATTERNS.some((p) => p.test(output));
}

function extractBadPackages(output: string): string[] {
  const badPkgs: string[] = [];

  const notargetMatch = output.match(/notarget\s+No matching version found for ([^\s@]+)/g);
  if (notargetMatch) {
    for (const m of notargetMatch) {
      const pkg = m.match(/for\s+([^\s@]+)/)?.[1];
      if (pkg) badPkgs.push(pkg);
    }
  }

  const e404Match = output.match(/404\s+Not Found.*'([^']+)'/g);
  if (e404Match) {
    for (const m of e404Match) {
      const pkg = m.match(/'([^']+)'/)?.[1];
      if (pkg) badPkgs.push(pkg);
    }
  }

  return [...new Set(badPkgs)];
}

async function autoFixPackageJson(buildDir: string, output: string): Promise<boolean> {
  const pkgPath = join(buildDir, 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    let modified = false;

    const badPackages = extractBadPackages(output);
    for (const bad of badPackages) {
      if (pkg.dependencies?.[bad]) {
        delete pkg.dependencies[bad];
        modified = true;
      }
      if (pkg.devDependencies?.[bad]) {
        delete pkg.devDependencies[bad];
        modified = true;
      }
    }

    for (const rnPkg of REACT_NATIVE_PACKAGES) {
      for (const deps of [pkg.dependencies, pkg.devDependencies]) {
        if (!deps) continue;
        for (const key of Object.keys(deps)) {
          if (key === rnPkg || key.startsWith(rnPkg)) {
            delete deps[key];
            modified = true;
          }
        }
      }
    }

    if (!pkg.scripts?.build) {
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.build = 'vite build';
      modified = true;
    }
    if (!pkg.scripts?.dev) {
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.dev = 'vite';
      modified = true;
    }

    if (modified) {
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export async function verifyBuild(
  repoFullName: string,
  projectId: string,
  files?: { path: string; content: string }[]
): Promise<BuildResult> {
  const buildDir = join(BUILD_DIR, projectId.slice(0, 8));

  try {
    await rm(buildDir, { recursive: true, force: true });
    await mkdir(buildDir, { recursive: true });

    if (files && files.length > 0) {
      for (const file of files) {
        const filePath = join(buildDir, file.path);
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, file.content, 'utf-8');
      }
    } else {
      const token = await getSecretWithFallback('github');
      const cloneUrl = token
        ? `https://${token}@github.com/${repoFullName}.git`
        : `https://github.com/${repoFullName}.git`;
      const { code, stderr } = await runCommand(`git clone --depth 1 ${cloneUrl} .`, buildDir);
      if (code !== 0) {
        return { success: false, output: '', errors: `Git clone failed: ${stderr}`, errorType: 'clone' };
      }
    }

    await logger.info('Installing dependencies...', 'development', projectId);
    let install = await runCommand('npm install --no-audit --no-fund 2>&1', buildDir, 180_000);

    if (install.code !== 0) {
      const combinedOutput = `${install.stdout}\n${install.stderr}`;
      if (isNpmError(combinedOutput)) {
        const fixed = await autoFixPackageJson(buildDir, combinedOutput);
        if (fixed) {
          await logger.info('Auto-fixed package.json (removed bad packages), retrying install...', 'development', projectId);
          install = await runCommand('npm install --no-audit --no-fund 2>&1', buildDir, 180_000);
        }
      }

      if (install.code !== 0) {
        return {
          success: false,
          output: install.stdout,
          errors: `npm install failed: ${install.stderr || install.stdout}`,
          errorType: 'npm_install',
        };
      }
    }

    await logger.info('Running build...', 'development', projectId);
    const build = await runCommand('npm run build 2>&1', buildDir);

    return {
      success: build.code === 0,
      output: build.stdout,
      errors: build.code !== 0 ? (build.stderr || build.stdout) : '',
      errorType: build.code !== 0 ? 'build' : undefined,
    };
  } catch (err) {
    return {
      success: false,
      output: '',
      errors: `Build verification error: ${err instanceof Error ? err.message : String(err)}`,
      errorType: 'unknown',
    };
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function extractBuildErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.includes('error TS') ||
      trimmed.includes('Error:') ||
      trimmed.includes('SyntaxError') ||
      trimmed.includes('TypeError') ||
      trimmed.includes('ReferenceError') ||
      trimmed.includes('Cannot find') ||
      trimmed.includes('Module not found') ||
      trimmed.includes('is not assignable') ||
      trimmed.includes('has no exported member') ||
      trimmed.includes('has no default export') ||
      trimmed.includes('ENOENT') ||
      trimmed.includes('ERR!') ||
      trimmed.includes('FATAL') ||
      trimmed.includes('Could not resolve') ||
      trimmed.includes('Failed to resolve') ||
      trimmed.includes('[vite]') ||
      trimmed.includes('[rollup]') ||
      trimmed.includes('Unexpected token') ||
      trimmed.includes('is not a function') ||
      (trimmed.includes('Property') && trimmed.includes('does not exist'))
    ) {
      errors.push(trimmed);
    }
  }

  if (errors.length === 0 && output.trim().length > 0) {
    const tail = output.trim().split('\n').slice(-30).join('\n');
    errors.push(tail.slice(0, 3000));
  }

  return errors;
}

export function hashErrors(errors: string[]): string {
  const normalized = errors.map((e) =>
    e.replace(/\d+/g, 'N').replace(/[a-f0-9]{8}/gi, 'H').trim()
  ).sort().join('|');

  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export async function validateScaffold(
  files: { path: string; content: string }[],
  architecture?: { pages?: { name: string; route: string }[]; requiresBackend?: boolean }
): Promise<{ valid: boolean; issues: string[]; fixedFiles: { path: string; content: string }[] }> {
  const issues: string[] = [];
  const fixedFiles: { path: string; content: string }[] = [];

  const pkgFile = files.find((f) => f.path === 'package.json');
  if (!pkgFile) {
    issues.push('Missing package.json');
    fixedFiles.push({ path: 'package.json', content: JSON.stringify(generateFallbackPackageJson(architecture?.requiresBackend), null, 2) });
  }

  const pkgContent = pkgFile?.content || fixedFiles.find((f) => f.path === 'package.json')?.content;
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      let modified = false;

      if (!pkg.scripts?.build) {
        pkg.scripts = pkg.scripts || {};
        pkg.scripts.build = 'vite build';
        issues.push('Added missing "build" script');
        modified = true;
      }
      if (!pkg.scripts?.dev) {
        pkg.scripts = pkg.scripts || {};
        pkg.scripts.dev = 'vite';
        issues.push('Added missing "dev" script');
        modified = true;
      }

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const key of Object.keys(allDeps)) {
        for (const rnPkg of REACT_NATIVE_PACKAGES) {
          if (key === rnPkg || key.startsWith(rnPkg)) {
            if (pkg.dependencies?.[key]) delete pkg.dependencies[key];
            if (pkg.devDependencies?.[key]) delete pkg.devDependencies[key];
            issues.push(`Removed React Native package: ${key}`);
            modified = true;
          }
        }
      }

      if (!pkg.dependencies?.react) { pkg.dependencies = pkg.dependencies || {}; pkg.dependencies.react = '^18.3.1'; modified = true; }
      if (!pkg.dependencies?.['react-dom']) { pkg.dependencies['react-dom'] = '^18.3.1'; modified = true; }
      if (!pkg.dependencies?.['react-router-dom']) { pkg.dependencies['react-router-dom'] = '^7.1.0'; modified = true; }
      if (!pkg.dependencies?.['lucide-react']) { pkg.dependencies['lucide-react'] = '^0.344.0'; modified = true; }
      if (!pkg.devDependencies?.vite) { pkg.devDependencies = pkg.devDependencies || {}; pkg.devDependencies.vite = '^5.4.2'; modified = true; }
      if (!pkg.devDependencies?.['@vitejs/plugin-react']) { pkg.devDependencies['@vitejs/plugin-react'] = '^4.3.1'; modified = true; }
      if (!pkg.devDependencies?.typescript) { pkg.devDependencies.typescript = '^5.5.3'; modified = true; }
      if (!pkg.devDependencies?.tailwindcss && !pkg.dependencies?.tailwindcss) { pkg.devDependencies.tailwindcss = '^3.4.1'; modified = true; }

      if (modified) {
        const existing = fixedFiles.findIndex((f) => f.path === 'package.json');
        if (existing >= 0) fixedFiles[existing] = { path: 'package.json', content: JSON.stringify(pkg, null, 2) };
        else fixedFiles.push({ path: 'package.json', content: JSON.stringify(pkg, null, 2) });
      }
    } catch {
      issues.push('Invalid package.json JSON');
    }
  }

  const hasViteConfig = files.some((f) => f.path.includes('vite.config'));
  if (!hasViteConfig) {
    issues.push('Missing vite.config.ts -- auto-generated');
    fixedFiles.push({ path: 'vite.config.ts', content: FALLBACK_VITE_CONFIG });
  }

  const hasIndexHtml = files.some((f) => f.path === 'index.html');
  if (!hasIndexHtml) {
    issues.push('Missing index.html -- auto-generated');
    fixedFiles.push({ path: 'index.html', content: FALLBACK_INDEX_HTML });
  }

  const hasMainTsx = files.some((f) => f.path.includes('src/main.tsx'));
  if (!hasMainTsx) {
    issues.push('Missing src/main.tsx -- auto-generated');
    fixedFiles.push({ path: 'src/main.tsx', content: generateFallbackMain(architecture?.requiresBackend) });
  }

  const hasAppTsx = files.some((f) => f.path.includes('src/App.tsx'));
  if (!hasAppTsx) {
    issues.push('Missing src/App.tsx -- auto-generated');
    fixedFiles.push({ path: 'src/App.tsx', content: generateFallbackApp(architecture?.pages) });
  }

  const hasTsConfig = files.some((f) => f.path === 'tsconfig.json');
  if (!hasTsConfig) {
    issues.push('Missing tsconfig.json -- auto-generated');
    fixedFiles.push({ path: 'tsconfig.json', content: FALLBACK_TSCONFIG });
    fixedFiles.push({ path: 'tsconfig.app.json', content: FALLBACK_TSCONFIG_APP });
    fixedFiles.push({ path: 'tsconfig.node.json', content: FALLBACK_TSCONFIG_NODE });
  }

  const hasTailwindConfig = files.some((f) => f.path.includes('tailwind.config'));
  if (!hasTailwindConfig) {
    issues.push('Missing tailwind.config.js -- auto-generated');
    fixedFiles.push({ path: 'tailwind.config.js', content: FALLBACK_TAILWIND_CONFIG });
  }

  const hasPostcssConfig = files.some((f) => f.path.includes('postcss.config'));
  if (!hasPostcssConfig) {
    fixedFiles.push({ path: 'postcss.config.js', content: FALLBACK_POSTCSS_CONFIG });
  }

  const hasIndexCss = files.some((f) => f.path === 'src/index.css');
  if (!hasIndexCss) {
    fixedFiles.push({ path: 'src/index.css', content: FALLBACK_INDEX_CSS });
  }

  return { valid: issues.length === 0, issues, fixedFiles };
}

function generateFallbackPackageJson(hasBackend?: boolean): Record<string, unknown> {
  const deps: Record<string, string> = {
    'react': '^18.3.1',
    'react-dom': '^18.3.1',
    'react-router-dom': '^7.1.0',
    'lucide-react': '^0.344.0',
  };
  if (hasBackend) deps['@supabase/supabase-js'] = '^2.57.4';
  return {
    name: 'project',
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: deps,
    devDependencies: {
      '@vitejs/plugin-react': '^4.3.1',
      'autoprefixer': '^10.4.18',
      'postcss': '^8.4.35',
      'tailwindcss': '^3.4.1',
      'typescript': '^5.5.3',
      'vite': '^5.4.2',
      '@types/react': '^18.3.5',
      '@types/react-dom': '^18.3.0',
    },
  };
}

function generateFallbackMain(hasBackend?: boolean): string {
  if (hasBackend) {
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

function generateFallbackApp(pages?: { name: string; route: string }[]): string {
  if (!pages || pages.length === 0) {
    return `import { Routes, Route } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<div className="min-h-screen flex items-center justify-center"><h1 className="text-2xl font-bold">Welcome</h1></div>} />
    </Routes>
  );
}`;
  }
  const imports = pages.map((p) => {
    const componentName = p.name.replace(/[^a-zA-Z0-9]/g, '');
    const fileName = componentName;
    return { componentName, fileName, route: p.route };
  });
  const importLines = imports.map((i) => `import ${i.componentName} from './pages/${i.fileName}';`).join('\n');
  const routeLines = imports.map((i) => `      <Route path="${i.route}" element={<${i.componentName} />} />`).join('\n');
  return `import { Routes, Route } from 'react-router-dom';
${importLines}

export default function App() {
  return (
    <Routes>
${routeLines}
    </Routes>
  );
}`;
}

const FALLBACK_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});`;

const FALLBACK_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

const FALLBACK_TSCONFIG = `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}`;

const FALLBACK_TSCONFIG_APP = `{
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

const FALLBACK_TSCONFIG_NODE = `{
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

const FALLBACK_TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};`;

const FALLBACK_POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`;

const FALLBACK_INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

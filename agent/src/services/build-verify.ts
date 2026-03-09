import { exec } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';
import {
  sanitizePackageJson,
  generatePackageJson,
  generateViteConfig,
  generateTsConfig,
  generateTsConfigApp,
  generateTsConfigNode,
  generatePostcssConfig,
  generateTailwindConfig,
  generateIndexHtml,
  generateMainTsx,
  generateIndexCss,
  PROHIBITED_PACKAGES,
} from './scaffold-templates.js';
import type { GeneratedFile } from '../core/types.js';

const BUILD_DIR = '/tmp/obzide-builds';

const NPM_INSTALL_TIMEOUT = 300_000;
const NPM_FORCE_INSTALL_TIMEOUT = 120_000;
const BUILD_TIMEOUT = 180_000;
const GIT_CLONE_TIMEOUT = 180_000;
const DEFAULT_CMD_TIMEOUT = 180_000;

interface BuildResult {
  success: boolean;
  output: string;
  errors: string;
  errorType?: 'npm_install' | 'build' | 'clone' | 'environment' | 'unknown';
  isEnvironmentError?: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

function runCommand(cmd: string, cwd: string, timeoutMs = DEFAULT_CMD_TIMEOUT): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const timedOut = !!(error && 'killed' in error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed);
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
        code: error ? (error.code ?? 1) : 0,
        timedOut,
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
  '@react-native-community/',
];

const DANGEROUS_SCRIPT_PATTERNS = [
  /npm\s+install/i,
  /npm\s+i\b/i,
  /pnpm\s+install/i,
  /yarn\s+install/i,
  /yarn\s+add/i,
  /pnpm\s+add/i,
];

function detectRecursiveInstall(output: string): boolean {
  const lines = output.split('\n');
  const installLines = lines.filter((l) => />\s*.*\binstall\b/.test(l));
  if (installLines.length >= 3) {
    const unique = new Set(installLines.map((l) => l.trim()));
    if (unique.size <= 2) return true;
  }
  return false;
}

async function sanitizePackageJsonOnDisk(buildDir: string): Promise<string[]> {
  const pkgPath = join(buildDir, 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf-8');
    const { sanitized, issues } = sanitizePackageJson(raw);
    if (issues.length > 0) {
      await writeFile(pkgPath, sanitized, 'utf-8');
    }
    return issues;
  } catch {
    return [];
  }
}

function isNpmError(output: string): boolean {
  return NPM_ERROR_PATTERNS.some((p) => p.test(output));
}

function extractBadPackages(output: string): string[] {
  const badPkgs: string[] = [];

  const notargetMatch = output.match(/notarget\s+No matching version found for ((?:@[^\s/]+\/)?[^\s@]+)/g);
  if (notargetMatch) {
    for (const m of notargetMatch) {
      const pkg = m.match(/for\s+((?:@[^\s/]+\/)?[^\s@]+)/)?.[1];
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

  const eresolveMatch = output.match(/Could not resolve dependency.*(?:@[^\s/]+\/)?[^\s@]+/g);
  if (eresolveMatch) {
    for (const m of eresolveMatch) {
      const pkg = m.match(/((?:@[^\s/]+\/)?[^\s@]+)\s*$/)?.[1];
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

    const scripts = (pkg.scripts || {}) as Record<string, string>;
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== 'string') continue;
      const isDangerous = DANGEROUS_SCRIPT_PATTERNS.some((p) => p.test(value));
      if (isDangerous) {
        delete scripts[name];
        modified = true;
      }
    }
    scripts.dev = 'vite';
    scripts.build = 'vite build';
    scripts.preview = 'vite preview';
    pkg.scripts = scripts;

    if (!pkg.type || pkg.type !== 'module') {
      pkg.type = 'module';
      modified = true;
    }

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

    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      if (!deps) continue;
      for (const key of Object.keys(deps)) {
        const isProhibited = PROHIBITED_PACKAGES.some(
          (p) => key === p || key.startsWith(p)
        );
        if (isProhibited) {
          delete deps[key];
          modified = true;
        }
      }
    }

    if (!pkg.devDependencies?.vite) {
      pkg.devDependencies = pkg.devDependencies || {};
      pkg.devDependencies.vite = '^5.4.2';
      modified = true;
    }
    if (!pkg.devDependencies?.['@vitejs/plugin-react']) {
      pkg.devDependencies['@vitejs/plugin-react'] = '^4.3.1';
      modified = true;
    }

    if (modified) {
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
      return true;
    }
  } catch (err) {
    console.error(`[autoFixPackageJson] Failed to repair package.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

const buildDirCache = new Map<string, { pkgHash: string }>();

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < content.length; i++) {
      h = Math.imul(h ^ content.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h.toString(36);
  } catch {
    return '';
  }
}

export async function verifyBuild(
  repoFullName: string,
  projectId: string,
  files?: { path: string; content: string }[]
): Promise<BuildResult> {
  const buildDir = join(BUILD_DIR, projectId.slice(0, 8));
  const isFileMode = files && files.length > 0;

  try {
    let hasNodeModules = !isFileMode && await dirExists(join(buildDir, 'node_modules'));
    const cachedEntry = buildDirCache.get(buildDir);

    if (isFileMode || !hasNodeModules) {
      await rm(buildDir, { recursive: true, force: true });
      await mkdir(buildDir, { recursive: true });
      buildDirCache.delete(buildDir);
      hasNodeModules = false;

      if (isFileMode) {
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
        const { code, stderr } = await runCommand(`git clone --depth 1 ${cloneUrl} .`, buildDir, GIT_CLONE_TIMEOUT);
        if (code !== 0) {
          return { success: false, output: '', errors: `Git clone failed: ${stderr}`, errorType: 'clone' };
        }
      }
    } else {
      const { code } = await runCommand('git fetch origin main && git reset --hard origin/main', buildDir, GIT_CLONE_TIMEOUT);
      if (code !== 0) {
        await rm(buildDir, { recursive: true, force: true });
        await mkdir(buildDir, { recursive: true });
        buildDirCache.delete(buildDir);
        hasNodeModules = false;
        const token = await getSecretWithFallback('github');
        const cloneUrl = token
          ? `https://${token}@github.com/${repoFullName}.git`
          : `https://github.com/${repoFullName}.git`;
        const { code: cloneCode, stderr } = await runCommand(`git clone --depth 1 ${cloneUrl} .`, buildDir, GIT_CLONE_TIMEOUT);
        if (cloneCode !== 0) {
          return { success: false, output: '', errors: `Git clone failed: ${stderr}`, errorType: 'clone' };
        }
      }
    }

    const sanitizeIssues = await sanitizePackageJsonOnDisk(buildDir);
    if (sanitizeIssues.length > 0) {
      await logger.info(`Pre-install package.json sanitization: ${sanitizeIssues.join('; ')}`, 'development', projectId);
    }

    const currentPkgHash = await hashFile(join(buildDir, 'package.json'));
    const needsInstall = !cachedEntry || cachedEntry.pkgHash !== currentPkgHash || !hasNodeModules;

    if (needsInstall) {
      await logger.info('Installing dependencies...', 'development', projectId);
      let install = await runCommand('npm install --no-audit --no-fund --include=dev 2>&1', buildDir, NPM_INSTALL_TIMEOUT);

      if (install.code !== 0) {
        const combinedOutput = `${install.stdout}\n${install.stderr}`;

        if (install.timedOut) {
          await logger.warn(`npm install timed out after ${NPM_INSTALL_TIMEOUT / 1000}s. Server may be slow or resource-constrained.`, 'development', projectId);
        } else if (detectRecursiveInstall(combinedOutput)) {
          await logger.warn('Detected recursive npm install loop, sanitizing package.json...', 'development', projectId);
          await autoFixPackageJson(buildDir, combinedOutput);
          install = await runCommand('npm install --no-audit --no-fund --include=dev 2>&1', buildDir, NPM_INSTALL_TIMEOUT);
        } else if (isNpmError(combinedOutput)) {
          const fixed = await autoFixPackageJson(buildDir, combinedOutput);
          if (fixed) {
            await logger.info('Auto-fixed package.json (removed bad packages), retrying install...', 'development', projectId);
            install = await runCommand('npm install --no-audit --no-fund --include=dev 2>&1', buildDir, NPM_INSTALL_TIMEOUT);
          }
        }

        if (install.code !== 0) {
          const combinedInstallOutput = `${install.stdout}\n${install.stderr}`;
          const reason = install.timedOut ? `npm install timed out after ${NPM_INSTALL_TIMEOUT / 1000}s` : 'npm install failed';
          const isEnv = install.timedOut ||
            /EACCES|permission denied/i.test(combinedInstallOutput) ||
            /ENOSPC|no space left/i.test(combinedInstallOutput) ||
            /command not found.*npm/i.test(combinedInstallOutput);
          return {
            success: false,
            output: install.stdout,
            errors: `${reason}: ${install.stderr || install.stdout}`,
            errorType: 'npm_install',
            isEnvironmentError: isEnv,
          };
        }
      }

      buildDirCache.set(buildDir, { pkgHash: currentPkgHash });
    }

    const viteCheck = await runCommand('test -f node_modules/vite/bin/vite.js && echo VITE_OK || echo VITE_MISSING', buildDir);
    if (!viteCheck.stdout.includes('VITE_OK')) {
      await logger.warn('vite not found after npm install, force-installing critical deps...', 'development', projectId);
      await runCommand('npm install vite@^5.4.2 @vitejs/plugin-react@^4.3.1 --no-audit --no-fund --no-save --include=dev 2>&1', buildDir, NPM_FORCE_INSTALL_TIMEOUT);

      const recheck = await runCommand('test -f node_modules/vite/bin/vite.js && echo VITE_OK || echo VITE_MISSING', buildDir);
      if (!recheck.stdout.includes('VITE_OK')) {
        return {
          success: false,
          output: '',
          errors: 'vite could not be installed in the build environment. npm install may be broken.',
          errorType: 'environment',
          isEnvironmentError: true,
        };
      }
    }

    await logger.info('Running build...', 'development', projectId);
    let build = await runCommand('./node_modules/.bin/vite build 2>&1', buildDir, BUILD_TIMEOUT);

    if (build.timedOut) {
      await logger.warn(`vite build timed out after ${BUILD_TIMEOUT / 1000}s`, 'development', projectId);
    } else if (build.code !== 0) {
      const buildErr = `${build.stderr}\n${build.stdout}`;
      if (buildErr.includes('not found') || buildErr.includes('ENOENT') || buildErr.includes('No such file')) {
        await logger.warn('vite binary not accessible, trying direct node execution...', 'development', projectId);
        build = await runCommand('node ./node_modules/vite/bin/vite.js build 2>&1', buildDir, BUILD_TIMEOUT);

        if (build.code !== 0) {
          const nodeErr = `${build.stderr}\n${build.stdout}`;
          if (nodeErr.includes('not found') || nodeErr.includes('ENOENT') || nodeErr.includes('Cannot find module')) {
            await logger.warn('Direct node execution failed, trying npx vite build...', 'development', projectId);
            build = await runCommand('npx vite build 2>&1', buildDir, BUILD_TIMEOUT);
          }
        }
      }
    }

    const combinedBuildOutput = [build.stderr, build.stdout].filter(Boolean).join('\n');
    const envError = isEnvironmentBuildError(combinedBuildOutput);

    return {
      success: build.code === 0,
      output: build.stdout,
      errors: build.code !== 0 ? combinedBuildOutput : '',
      errorType: build.code !== 0 ? (envError ? 'environment' : 'build') : undefined,
      isEnvironmentError: build.code !== 0 ? envError : false,
    };
  } catch (err) {
    return {
      success: false,
      output: '',
      errors: `Build verification error: ${err instanceof Error ? err.message : String(err)}`,
      errorType: 'unknown',
    };
  }
}

export async function cleanupBuildDir(projectId: string): Promise<void> {
  const buildDir = join(BUILD_DIR, projectId.slice(0, 8));
  buildDirCache.delete(buildDir);
  await rm(buildDir, { recursive: true, force: true }).catch(() => {});
}

const ENVIRONMENT_ERROR_PATTERNS = [
  /EACCES.*permission denied/i,
  /ENOSPC.*no space left/i,
  /command not found/i,
  /Cannot allocate memory/i,
  /ENOMEM/i,
];

const CONFIG_ERROR_PATTERNS = [
  /failed to load config from.*vite\.config/i,
  /Loading PostCSS Plugin failed/i,
  /\[vite:css\].*Failed to load PostCSS config/i,
  /tailwind\.config.*Error/i,
  /config must export or return an object/i,
  /Cannot find package '(vite|@vitejs|tailwindcss|postcss|autoprefixer)'/i,
  /Cannot find module '(vite|@vitejs|tailwindcss|postcss|autoprefixer)'/i,
  /ERR_MODULE_NOT_FOUND.*node_modules/i,
];

export type BuildErrorCategory = 'environment' | 'config' | 'code';

export function classifyBuildError(errors: string[]): BuildErrorCategory {
  const combined = errors.join('\n');

  if (ENVIRONMENT_ERROR_PATTERNS.some((p) => p.test(combined))) {
    return 'environment';
  }

  if (CONFIG_ERROR_PATTERNS.some((p) => p.test(combined))) {
    return 'config';
  }

  return 'code';
}

function isEnvironmentBuildError(output: string): boolean {
  return ENVIRONMENT_ERROR_PATTERNS.some((p) => p.test(output));
}

const WARNING_PATTERNS = [
  /\(!\)\s/,
  /warning:/i,
  /deprecated/i,
  /experimental/i,
  /hmr\s+update/i,
  /chunks?\s+are\s+larger/i,
  /sourcemap/i,
  /Use of eval/i,
  /CommonJS or AMD dependencies/i,
];

function isWarningLine(line: string): boolean {
  return WARNING_PATTERNS.some((p) => p.test(line));
}

export function extractBuildErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (isWarningLine(trimmed)) continue;

    const isDefiniteError =
      trimmed.includes('error TS') ||
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
      trimmed.includes('Unexpected token') ||
      trimmed.includes('is not a function') ||
      (trimmed.includes('Property') && trimmed.includes('does not exist'));

    if (isDefiniteError) {
      errors.push(trimmed);
      continue;
    }

    if (trimmed.includes('Error:') && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      errors.push(trimmed);
      continue;
    }

    const isViteError =
      (trimmed.includes('[vite]') || trimmed.includes('[rollup]') || trimmed.includes('[vite:')) &&
      (/error/i.test(trimmed) || /fail/i.test(trimmed) || /cannot/i.test(trimmed) || /not found/i.test(trimmed));

    if (isViteError) {
      const contextLines = [trimmed];
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('at ') || next.startsWith('✓') || next.startsWith('x ')) break;
        contextLines.push(next);
      }
      errors.push(contextLines.join(' | '));
      continue;
    }
  }

  if (errors.length === 0 && output.trim().length > 0) {
    const head = output.trim().split('\n').slice(0, 30).join('\n');
    errors.push(head.slice(0, 3000));
  }

  return errors;
}

export function hashErrors(errors: string[]): string {
  const normalized = errors.map((e) =>
    e
      .replace(/\(\d+,\d+\)/g, '(N,N)')
      .replace(/line \d+/gi, 'line N')
      .replace(/:\d+:\d+/g, ':N:N')
      .replace(/[a-f0-9]{8,}/gi, 'H')
      .replace(/\[repeated \d+x in:.*?\]/g, '')
      .trim()
  ).sort().join('|');

  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ char, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ char, 0x811c9dc5) >>> 0;
  }
  return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36);
}

export async function validateScaffold(
  files: { path: string; content: string }[],
  architecture?: { pages?: { name: string; route: string }[]; requiresBackend?: boolean }
): Promise<{ valid: boolean; issues: string[]; fixedFiles: { path: string; content: string }[] }> {
  const issues: string[] = [];
  const fixedFiles: { path: string; content: string }[] = [];
  const hasBackend = architecture?.requiresBackend || false;

  const pkgFile = files.find((f) => f.path === 'package.json');
  if (!pkgFile) {
    issues.push('Missing package.json -- replaced with template');
    fixedFiles.push({ path: 'package.json', content: generatePackageJson('project', hasBackend) });
  } else {
    const { sanitized, issues: pkgIssues } = sanitizePackageJson(pkgFile.content);
    if (pkgIssues.length > 0) {
      issues.push(...pkgIssues);
      const existing = fixedFiles.findIndex((f) => f.path === 'package.json');
      if (existing >= 0) fixedFiles[existing] = { path: 'package.json', content: sanitized };
      else fixedFiles.push({ path: 'package.json', content: sanitized });
    }
  }

  const viteConfigFile = files.find((f) => f.path.includes('vite.config'));
  if (!viteConfigFile) {
    issues.push('Missing vite.config.ts -- replaced with template');
    fixedFiles.push({ path: 'vite.config.ts', content: generateViteConfig() });
  } else {
    const vc = viteConfigFile.content;
    if (vc.includes('module.exports') || vc.includes('require(') ||
        !vc.includes('@vitejs/plugin-react') || !vc.includes('react()')) {
      issues.push('vite.config invalid -- replaced with template');
      fixedFiles.push({ path: viteConfigFile.path, content: generateViteConfig() });
    }
  }

  if (!files.some((f) => f.path === 'index.html')) {
    issues.push('Missing index.html -- replaced with template');
    fixedFiles.push({ path: 'index.html', content: generateIndexHtml('App') });
  }

  if (!files.some((f) => f.path.includes('src/main.tsx'))) {
    issues.push('Missing src/main.tsx -- replaced with template');
    fixedFiles.push({ path: 'src/main.tsx', content: generateMainTsx(hasBackend) });
  }

  if (!files.some((f) => f.path.includes('src/App.tsx'))) {
    issues.push('Missing src/App.tsx -- auto-generated');
    const scaffoldFilePaths = files.map((f) => f.path);
    fixedFiles.push({ path: 'src/App.tsx', content: generateFallbackApp(architecture?.pages, scaffoldFilePaths) });
  }

  if (!files.some((f) => f.path === 'tsconfig.json')) {
    issues.push('Missing tsconfig.json -- replaced with template');
    fixedFiles.push({ path: 'tsconfig.json', content: generateTsConfig() });
    fixedFiles.push({ path: 'tsconfig.app.json', content: generateTsConfigApp() });
    fixedFiles.push({ path: 'tsconfig.node.json', content: generateTsConfigNode() });
  }

  const tailwindFile = files.find((f) => f.path.includes('tailwind.config'));
  if (!tailwindFile) {
    issues.push('Missing tailwind.config.js -- replaced with template');
    fixedFiles.push({ path: 'tailwind.config.js', content: generateTailwindConfig() });
  } else if (tailwindFile.content.includes('module.exports') || tailwindFile.content.includes('require(')) {
    issues.push('tailwind.config uses CJS syntax -- replaced with template');
    fixedFiles.push({ path: tailwindFile.path, content: generateTailwindConfig() });
  }

  const postcssFile = files.find((f) => f.path.includes('postcss.config'));
  if (!postcssFile) {
    fixedFiles.push({ path: 'postcss.config.js', content: generatePostcssConfig() });
  } else if (postcssFile.content.includes('module.exports') || postcssFile.content.includes('require(')) {
    issues.push('postcss.config uses CJS syntax -- replaced with template');
    fixedFiles.push({ path: postcssFile.path, content: generatePostcssConfig() });
  }

  if (!files.some((f) => f.path === 'src/index.css')) {
    fixedFiles.push({ path: 'src/index.css', content: generateIndexCss() });
  }

  return { valid: issues.length === 0, issues, fixedFiles };
}

export function preFlightCheck(
  files: GeneratedFile[],
  allFilePaths?: string[]
): { passed: boolean; issues: string[]; fixes: GeneratedFile[] } {
  const issues: string[] = [];
  const fixes: GeneratedFile[] = [];
  const filePaths = allFilePaths || files.map((f) => f.path);

  const pkgFile = files.find((f) => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content);
      const scripts = pkg.scripts || {};
      for (const [name, value] of Object.entries(scripts)) {
        if (typeof value === 'string' && DANGEROUS_SCRIPT_PATTERNS.some((p) => p.test(value))) {
          issues.push(`Dangerous script "${name}": "${value}"`);
        }
      }
      if (scripts.build && scripts.build !== 'vite build') {
        issues.push(`Build script is "${scripts.build}" instead of "vite build"`);
      }
      if (!pkg.devDependencies?.vite) {
        issues.push('vite missing from devDependencies');
      }
    } catch {
      issues.push('Invalid package.json');
    }
  }

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file.path)) continue;

    const importRegex = /(?:import|from)\s+['"](\.\/?[^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(file.content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith('.')) {
        const fileDir = file.path.substring(0, file.path.lastIndexOf('/')) || 'src';
        const parts = fileDir.split('/');
        const importParts = importPath.split('/');
        const baseParts = [...parts];
        for (const part of importParts) {
          if (part === '.') continue;
          else if (part === '..') baseParts.pop();
          else baseParts.push(part);
        }
        const resolved = baseParts.join('/');
        const candidates = [
          resolved, resolved + '.tsx', resolved + '.ts',
          resolved + '/index.tsx', resolved + '/index.ts',
        ];
        const found = candidates.some((c) => filePaths.includes(c));
        if (!found) {
          const stubPath = resolved.endsWith('.tsx') || resolved.endsWith('.ts')
            ? resolved : resolved + '.tsx';
          if (!fixes.some((f) => f.path === stubPath)) {
            const name = stubPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Stub';
            fixes.push({
              path: stubPath,
              content: `export default function ${name}() {\n  return <div className="min-h-screen flex items-center justify-center"><p>${name}</p></div>;\n}`,
            });
          }
        }
      }
    }
  }

  if (issues.length > 0 && pkgFile) {
    const { sanitized } = sanitizePackageJson(pkgFile.content);
    fixes.push({ path: 'package.json', content: sanitized });
  }

  return { passed: issues.length === 0, issues, fixes };
}

function generateFallbackApp(pages?: { name: string; route: string }[], existingFiles?: string[]): string {
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

  const fileSet = new Set(existingFiles || []);
  const imports = pages
    .map((p) => {
      let componentName = p.name.replace(/[^a-zA-Z0-9]/g, '');
      const fileName = componentName;
      if (!componentName || /^\d/.test(componentName)) {
        componentName = 'Page' + (componentName || 'Unknown');
      }
      return { componentName, fileName, route: p.route };
    })
    .filter((i) => {
      if (fileSet.size === 0) return true;
      return fileSet.has(`src/pages/${i.fileName}.tsx`) || fileSet.has(`src/pages/${i.fileName}/index.tsx`);
    });

  if (imports.length === 0) {
    return `import { Routes, Route } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<div className="min-h-screen flex items-center justify-center"><h1 className="text-2xl font-bold">Loading...</h1></div>} />
    </Routes>
  );
}`;
  }

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


export function areAllErrorsTypeOnly(errors: string[]): boolean {
  const runtimePatterns = [
    /SyntaxError/i,
    /Cannot find module/i,
    /Failed to resolve/i,
    /Could not resolve/i,
    /Module not found/i,
    /Unexpected token/i,
    /ENOENT/i,
    /is not a function/i,
    /ERR!/i,
    /FATAL/i,
  ];

  const viteTypeErrorPattern = /\[vite\].*(?:error TS|Type error)/i;
  const rollupTypeErrorPattern = /\[rollup\].*(?:error TS|Type error)/i;

  return errors.length > 0 && errors.every((e) => {
    if (viteTypeErrorPattern.test(e) || rollupTypeErrorPattern.test(e)) return true;
    if (/\[vite\]/i.test(e) || /\[rollup\]/i.test(e)) return false;
    return !runtimePatterns.some((p) => p.test(e));
  });
}

export function generateTsNoCheckFiles(
  errors: string[],
  existingFiles: { path: string; content: string }[]
): { path: string; content: string }[] {
  const errorFiles = new Set<string>();
  for (const error of errors) {
    const fileMatches = error.matchAll(/([^\s:'",()+]*\.(?:tsx?|jsx?))\b/g);
    for (const fm of fileMatches) {
      const cleaned = fm[1].replace(/^[./]+/, '');
      if (cleaned.length > 0 && !cleaned.startsWith('node_modules')) {
        errorFiles.add(cleaned);
      }
    }
  }

  const fixes: { path: string; content: string }[] = [];
  for (const filePath of errorFiles) {
    const existing = existingFiles.find((f) => f.path === filePath);
    if (existing && !existing.content.startsWith('// @ts-nocheck')) {
      fixes.push({
        path: filePath,
        content: '// @ts-nocheck\n' + existing.content,
      });
    }
  }
  return fixes;
}


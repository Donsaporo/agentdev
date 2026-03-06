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
  files: { path: string; content: string }[]
): Promise<{ valid: boolean; issues: string[]; fixedFiles: { path: string; content: string }[] }> {
  const issues: string[] = [];
  const fixedFiles: { path: string; content: string }[] = [];

  const pkgFile = files.find((f) => f.path === 'package.json');
  if (!pkgFile) {
    issues.push('Missing package.json');
    return { valid: false, issues, fixedFiles };
  }

  try {
    const pkg = JSON.parse(pkgFile.content);

    if (!pkg.scripts?.build) {
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.build = 'vite build';
      issues.push('Added missing "build" script');
    }
    if (!pkg.scripts?.dev) {
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.dev = 'vite';
      issues.push('Added missing "dev" script');
    }

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const key of Object.keys(allDeps)) {
      for (const rnPkg of REACT_NATIVE_PACKAGES) {
        if (key === rnPkg || key.startsWith(rnPkg)) {
          if (pkg.dependencies?.[key]) delete pkg.dependencies[key];
          if (pkg.devDependencies?.[key]) delete pkg.devDependencies[key];
          issues.push(`Removed React Native package: ${key}`);
        }
      }
    }

    if (issues.length > 0) {
      fixedFiles.push({ path: 'package.json', content: JSON.stringify(pkg, null, 2) });
    }
  } catch {
    issues.push('Invalid package.json JSON');
  }

  const hasViteConfig = files.some((f) => f.path.includes('vite.config'));
  if (!hasViteConfig) issues.push('Missing vite.config.ts');

  const hasIndexHtml = files.some((f) => f.path === 'index.html');
  if (!hasIndexHtml) issues.push('Missing index.html');

  const hasMainTsx = files.some((f) => f.path.includes('src/main.tsx'));
  if (!hasMainTsx) issues.push('Missing src/main.tsx');

  const hasAppTsx = files.some((f) => f.path.includes('src/App.tsx'));
  if (!hasAppTsx) issues.push('Missing src/App.tsx');

  return { valid: issues.length === 0, issues, fixedFiles };
}

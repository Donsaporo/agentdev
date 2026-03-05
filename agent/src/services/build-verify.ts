import { exec } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

const BUILD_DIR = '/tmp/obzide-builds';

interface BuildResult {
  success: boolean;
  output: string;
  errors: string;
}

function runCommand(cmd: string, cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
        code: error?.code ?? (proc.exitCode ?? 0),
      });
    });
  });
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
      const cloneUrl = `https://github.com/${repoFullName}.git`;
      const { code, stderr } = await runCommand(`git clone --depth 1 ${cloneUrl} .`, buildDir);
      if (code !== 0) {
        return { success: false, output: '', errors: `Git clone failed: ${stderr}` };
      }
    }

    await logger.info('Installing dependencies...', 'development', projectId);
    const install = await runCommand('npm install --no-audit --no-fund 2>&1', buildDir, 180_000);
    if (install.code !== 0) {
      return { success: false, output: install.stdout, errors: `npm install failed: ${install.stderr || install.stdout}` };
    }

    await logger.info('Running build...', 'development', projectId);
    const build = await runCommand('npm run build 2>&1', buildDir);

    return {
      success: build.code === 0,
      output: build.stdout,
      errors: build.code !== 0 ? (build.stderr || build.stdout) : '',
    };
  } catch (err) {
    return {
      success: false,
      output: '',
      errors: `Build verification error: ${err instanceof Error ? err.message : String(err)}`,
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
      trimmed.includes('Cannot find') ||
      trimmed.includes('Module not found') ||
      trimmed.includes('is not assignable') ||
      trimmed.includes('has no exported member')
    ) {
      errors.push(trimmed);
    }
  }

  return errors;
}

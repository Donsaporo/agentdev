import { Octokit } from 'octokit';
import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';
import type { GeneratedFile } from '../core/types.js';

let octokit: Octokit | null = null;
let cachedToken: string = '';

async function getClient(): Promise<Octokit> {
  const token = await getSecretWithFallback('github');
  if (!token) throw new Error('GitHub token not configured');
  if (!octokit || cachedToken !== token) {
    cachedToken = token;
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

export async function createRepo(
  name: string,
  description: string,
  projectId: string
): Promise<{ repoUrl: string; fullName: string }> {
  const gh = await getClient();
  const org = (await getSecretWithFallback('github_org')) || env.GITHUB_ORG;

  const { data } = await gh.rest.repos.createInOrg({
    org,
    name,
    description,
    private: true,
    auto_init: true,
  });

  await logger.success(`Created repo ${data.full_name}`, 'github', projectId);

  return { repoUrl: data.html_url, fullName: data.full_name };
}

export async function pushFiles(
  repoFullName: string,
  files: GeneratedFile[],
  commitMessage: string,
  projectId: string
): Promise<string> {
  const gh = await getClient();
  const [owner, repo] = repoFullName.split('/');

  const { data: ref } = await gh.rest.git.getRef({ owner, repo, ref: 'heads/main' });
  const latestCommitSha = ref.object.sha;

  const { data: baseCommit } = await gh.rest.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
  const baseTreeSha = baseCommit.tree.sha;

  const tree = await Promise.all(
    files.map(async (file) => {
      const { data: blob } = await gh.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      });
      return {
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.sha,
      };
    })
  );

  const { data: newTree } = await gh.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree,
  });

  const { data: newCommit } = await gh.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [latestCommitSha],
  });

  await gh.rest.git.updateRef({
    owner,
    repo,
    ref: 'heads/main',
    sha: newCommit.sha,
  });

  await logger.info(`Pushed ${files.length} files: ${commitMessage}`, 'github', projectId);

  return newCommit.sha;
}

export async function getFileContent(
  repoFullName: string,
  filePath: string
): Promise<string | null> {
  const gh = await getClient();
  const [owner, repo] = repoFullName.split('/');

  try {
    const { data } = await gh.rest.repos.getContent({ owner, repo, path: filePath });

    if ('content' in data && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

export async function getRepoFiles(
  repoFullName: string,
  path: string = ''
): Promise<{ path: string; type: string }[]> {
  const gh = await getClient();
  const [owner, repo] = repoFullName.split('/');

  try {
    const { data } = await gh.rest.repos.getContent({ owner, repo, path });

    if (Array.isArray(data)) {
      const results: { path: string; type: string }[] = [];
      for (const item of data) {
        if (item.type === 'file') {
          results.push({ path: item.path, type: 'file' });
        } else if (item.type === 'dir') {
          results.push({ path: item.path, type: 'dir' });
          const subFiles = await getRepoFiles(repoFullName, item.path);
          results.push(...subFiles);
        }
      }
      return results;
    }
    return [];
  } catch {
    return [];
  }
}

export async function getMultipleFileContents(
  repoFullName: string,
  filePaths: string[]
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];

  for (const filePath of filePaths) {
    const content = await getFileContent(repoFullName, filePath);
    if (content !== null) {
      results.push({ path: filePath, content });
    }
  }

  return results;
}

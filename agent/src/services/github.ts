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

  try {
    const { data: existing } = await gh.rest.repos.get({ owner: org, repo: name });
    await logger.info(`Repo ${existing.full_name} already exists, reusing`, 'github', projectId);
    return { repoUrl: existing.html_url, fullName: existing.full_name };
  } catch {
    // repo does not exist, create it
  }

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
  const BATCH_SIZE = 15;

  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        const content = await getFileContent(repoFullName, filePath);
        return content !== null ? { path: filePath, content } : null;
      })
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  return results;
}

export async function getRepoTree(
  repoFullName: string
): Promise<{ path: string; type: string; size: number }[]> {
  const gh = await getClient();
  const [owner, repo] = repoFullName.split('/');

  try {
    const { data } = await gh.rest.git.getTree({ owner, repo, tree_sha: 'main', recursive: '1' });
    return (data.tree || [])
      .filter((item): item is typeof item & { path: string } => !!item.path)
      .map((item) => ({
        path: item.path,
        type: item.type === 'blob' ? 'file' : 'dir',
        size: item.size || 0,
      }));
  } catch {
    return getRepoFiles(repoFullName);
  }
}

export async function deleteRepo(
  repoFullName: string,
  projectId: string
): Promise<boolean> {
  const gh = await getClient();
  const [owner, repo] = repoFullName.split('/');

  try {
    await gh.rest.repos.delete({ owner, repo });
    await logger.success(`Deleted repo ${repoFullName}`, 'github', projectId);
    return true;
  } catch (err) {
    await logger.error(
      `Failed to delete repo ${repoFullName}: ${err instanceof Error ? err.message : String(err)}`,
      'github',
      projectId
    );
    return false;
  }
}

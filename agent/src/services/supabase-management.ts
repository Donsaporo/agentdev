import { logger } from '../core/logger.js';
import { getSecretWithFallback } from '../core/secrets.js';

const API_BASE = 'https://api.supabase.com';

async function supabaseFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getSecretWithFallback('supabase_management');
  if (!token) throw new Error('Supabase Management API token not configured');

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

export async function createSupabaseProject(
  name: string,
  orgId: string,
  region: string = 'us-east-1',
  projectId: string
): Promise<{ ref: string; id: string; dbPassword: string }> {
  const dbPass = generateDbPassword();

  const res = await supabaseFetch('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: name.slice(0, 40),
      organization_id: orgId,
      region,
      plan: 'free',
      db_pass: dbPass,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Supabase createProject failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  await logger.success(`Created Supabase project: ${data.name} (${data.id})`, 'supabase', projectId);

  return { ref: data.id, id: data.id, dbPassword: dbPass };
}

export async function waitForProjectReady(
  projectRef: string,
  projectId: string,
  maxWaitMs: number = 300_000
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const res = await supabaseFetch(`/v1/projects/${projectRef}`);
    if (!res.ok) {
      await logger.warn(`Failed to check Supabase project status: ${res.status}`, 'supabase', projectId);
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    const data = await res.json();
    if (data.status === 'ACTIVE_HEALTHY') {
      await logger.success(`Supabase project ${projectRef} is ready`, 'supabase', projectId);
      return true;
    }

    if (data.status === 'INACTIVE' || data.status === 'REMOVED') {
      throw new Error(`Supabase project ${projectRef} is ${data.status}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Supabase project ${projectRef} timed out waiting for ready state`);
}

export async function getProjectApiKeys(
  projectRef: string,
  projectId: string
): Promise<{ anonKey: string; serviceRoleKey: string }> {
  const res = await supabaseFetch(`/v1/projects/${projectRef}/api-keys`);

  if (!res.ok) {
    throw new Error(`Failed to get API keys for project ${projectRef}: ${res.status}`);
  }

  const keys = await res.json();
  let anonKey = '';
  let serviceRoleKey = '';

  for (const key of keys) {
    if (key.name === 'anon') anonKey = key.api_key;
    if (key.name === 'service_role') serviceRoleKey = key.api_key;
  }

  if (!anonKey || !serviceRoleKey) {
    throw new Error('Could not find API keys for Supabase project');
  }

  await logger.info(`Retrieved API keys for Supabase project ${projectRef}`, 'supabase', projectId);
  return { anonKey, serviceRoleKey };
}

export function getProjectUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}

export async function executeSqlOnProject(
  projectRef: string,
  sql: string,
  projectId: string
): Promise<void> {
  const res = await supabaseFetch(`/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const status = res.status;
    const err = await res.text().catch(() => '');
    const error = new Error(`SQL execution failed on ${projectRef}: ${err.slice(0, 500)}`);
    (error as SqlExecutionError).httpStatus = status;
    (error as SqlExecutionError).isRateLimit = status === 429 || err.includes('ThrottlerException') || err.includes('Too Many Requests');
    (error as SqlExecutionError).isBadSql = status === 400 && !err.includes('ThrottlerException');
    throw error;
  }

  await logger.info('SQL migration executed on project database', 'supabase', projectId);
}

interface SqlExecutionError extends Error {
  httpStatus?: number;
  isRateLimit?: boolean;
  isBadSql?: boolean;
}

export async function isManagementAvailable(): Promise<boolean> {
  const token = await getSecretWithFallback('supabase_management');
  return !!token;
}

export async function listProjects(
  projectId?: string
): Promise<{ id: string; name: string; ref: string; status: string }[]> {
  const res = await supabaseFetch('/v1/projects');
  if (!res.ok) {
    if (projectId) await logger.warn(`Failed to list Supabase projects: ${res.status}`, 'supabase', projectId);
    return [];
  }
  const data = await res.json();
  return (data as { id: string; name: string; ref?: string; status: string }[]).map((p) => ({
    id: p.id,
    name: p.name,
    ref: p.ref || p.id,
    status: p.status,
  }));
}

export async function findExistingProject(
  namePrefix: string,
  projectId: string
): Promise<{ ref: string; name: string; status: string } | null> {
  const projects = await listProjects(projectId);
  const match = projects.find((p) => p.name.startsWith(namePrefix));
  if (match) {
    await logger.info(`Found existing Supabase project: ${match.name} (${match.ref})`, 'supabase', projectId);
    return { ref: match.ref, name: match.name, status: match.status };
  }
  return null;
}

const SQL_RATE_LIMIT_BASE_WAIT_MS = 3000;
const SQL_MAX_RETRIES = 3;
const SQL_MAX_TOTAL_TIME_MS = 5 * 60 * 1000;
const SQL_INTER_BATCH_DELAY_MS = 500;

export interface SqlExecutionResult {
  succeeded: number;
  failed: number;
  errors: string[];
  failedStatements: { sql: string; error: string }[];
}

interface SqlCategory {
  name: string;
  statements: string[];
}

function categorizeStatements(statements: string[]): SqlCategory[] {
  const createExtensions: string[] = [];
  const createTypes: string[] = [];
  const createFunctions: string[] = [];
  const createTables: string[] = [];
  const alterTables: string[] = [];
  const createIndexes: string[] = [];
  const createPolicies: string[] = [];
  const alterOthers: string[] = [];
  const inserts: string[] = [];
  const others: string[] = [];

  for (const stmt of statements) {
    const upper = stmt.toUpperCase().trimStart();
    if (upper.startsWith('CREATE TYPE') || (upper.startsWith('DO $$') && stmt.includes('CREATE TYPE'))) {
      createTypes.push(stmt);
    } else if (upper.startsWith('CREATE EXTENSION')) {
      createExtensions.push(stmt);
    } else if (upper.startsWith('CREATE FUNCTION') || upper.startsWith('CREATE OR REPLACE FUNCTION')) {
      createFunctions.push(stmt);
    } else if (upper.startsWith('CREATE TABLE')) {
      createTables.push(stmt);
    } else if (upper.startsWith('ALTER TABLE')) {
      if (upper.includes('ENABLE ROW LEVEL SECURITY')) {
        alterTables.push(stmt);
      } else {
        alterOthers.push(stmt);
      }
    } else if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) {
      createIndexes.push(stmt);
    } else if (upper.startsWith('CREATE POLICY')) {
      createPolicies.push(stmt);
    } else if (upper.startsWith('INSERT') || (upper.startsWith('DO $$') && stmt.toUpperCase().includes('INSERT'))) {
      inserts.push(stmt);
    } else {
      others.push(stmt);
    }
  }

  const sortedTables = sortTablesByDependency(createTables);

  const categories: SqlCategory[] = [];
  if (createExtensions.length > 0) categories.push({ name: 'extensions', statements: createExtensions });
  if (createTypes.length > 0) categories.push({ name: 'types', statements: createTypes });
  if (createFunctions.length > 0) categories.push({ name: 'functions', statements: createFunctions });
  if (sortedTables.length > 0) categories.push({ name: 'tables', statements: sortedTables });
  if (alterTables.length > 0) categories.push({ name: 'rls', statements: alterTables });
  if (createIndexes.length > 0) categories.push({ name: 'indexes', statements: createIndexes });
  if (createPolicies.length > 0) categories.push({ name: 'policies', statements: createPolicies });
  if (alterOthers.length > 0) categories.push({ name: 'alter_other', statements: alterOthers });
  if (others.length > 0) categories.push({ name: 'other', statements: others });
  if (inserts.length > 0) categories.push({ name: 'inserts', statements: inserts });

  return categories;
}

function sortTablesByDependency(tables: string[]): string[] {
  const tableNames = new Map<string, string>();
  const deps = new Map<string, Set<string>>();

  for (const stmt of tables) {
    const nameMatch = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/i);
    if (nameMatch) {
      const name = nameMatch[1].toLowerCase();
      tableNames.set(name, stmt);

      const refMatches = stmt.matchAll(/REFERENCES\s+(?:public\.)?(\w+)/gi);
      const tableDeps = new Set<string>();
      for (const ref of refMatches) {
        const refName = ref[1].toLowerCase();
        if (refName !== name) {
          tableDeps.add(refName);
        }
      }
      deps.set(name, tableDeps);
    }
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      visited.add(name);
      return;
    }
    visiting.add(name);
    const tableDeps = deps.get(name);
    if (tableDeps) {
      for (const dep of tableDeps) {
        if (tableNames.has(dep)) {
          visit(dep);
        }
      }
    }
    visiting.delete(name);
    visited.add(name);
    const stmt = tableNames.get(name);
    if (stmt) sorted.push(stmt);
  }

  for (const name of tableNames.keys()) {
    visit(name);
  }

  for (const stmt of tables) {
    if (!sorted.includes(stmt)) {
      sorted.push(stmt);
    }
  }

  return sorted;
}

async function executeBatchWithRetry(
  projectRef: string,
  batchSql: string,
  projectId: string,
  categoryName: string,
  stmtCount: number,
): Promise<{ succeeded: number; failed: number; errors: string[]; failedStatements: { sql: string; error: string }[] }> {
  for (let retry = 0; retry < SQL_MAX_RETRIES; retry++) {
    try {
      await executeSqlOnProject(projectRef, batchSql, projectId);
      return { succeeded: stmtCount, failed: 0, errors: [], failedStatements: [] };
    } catch (err) {
      const sqlErr = err as SqlExecutionError;
      const errMsg = sqlErr.message || String(err);

      if (errMsg.includes('already exists')) {
        return { succeeded: stmtCount, failed: 0, errors: [], failedStatements: [] };
      }

      if (sqlErr.isRateLimit) {
        const backoffMs = SQL_RATE_LIMIT_BASE_WAIT_MS * Math.pow(2, Math.min(retry, 3));
        await logger.warn(`Rate limited on ${categoryName} batch (attempt ${retry + 1}/${SQL_MAX_RETRIES}), waiting ${backoffMs}ms...`, 'supabase', projectId);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (sqlErr.isBadSql && stmtCount > 1) {
        return { succeeded: 0, failed: stmtCount, errors: [errMsg.slice(0, 300)], failedStatements: [{ sql: batchSql.slice(0, 500), error: 'BATCH_FALLBACK: ' + errMsg.slice(0, 200) }] };
      }

      if (retry === SQL_MAX_RETRIES - 1 || sqlErr.isBadSql) {
        return {
          succeeded: 0,
          failed: stmtCount,
          errors: [errMsg.slice(0, 300)],
          failedStatements: [{ sql: batchSql.slice(0, 500), error: errMsg.slice(0, 300) }],
        };
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return { succeeded: 0, failed: stmtCount, errors: ['Max retries exceeded'], failedStatements: [{ sql: batchSql.slice(0, 500), error: 'Max retries exceeded' }] };
}

export async function executeSqlStatements(
  projectRef: string,
  sql: string,
  projectId: string
): Promise<SqlExecutionResult> {
  const rawStatements = splitSqlStatements(sql).filter((s) => s.trim().length >= 5);
  const categories = categorizeStatements(rawStatements);
  let totalSucceeded = 0;
  let totalFailed = 0;
  const allErrors: string[] = [];
  const allFailedStatements: { sql: string; error: string }[] = [];
  const startTime = Date.now();

  for (const category of categories) {
    if (Date.now() - startTime > SQL_MAX_TOTAL_TIME_MS) {
      await logger.warn(`SQL execution timed out after 5 minutes`, 'supabase', projectId);
      for (const stmt of category.statements) {
        totalFailed++;
        allFailedStatements.push({ sql: stmt.slice(0, 200), error: 'Timed out' });
      }
      continue;
    }

    const batchSql = category.statements.join(';\n') + ';';

    const result = await executeBatchWithRetry(
      projectRef, batchSql, projectId, category.name, category.statements.length,
    );

    const needsFallback = result.failed > 0 && category.statements.length > 1 &&
      result.failedStatements.some((f) => f.error.startsWith('BATCH_FALLBACK:'));

    if (result.failed === 0) {
      totalSucceeded += result.succeeded;
    } else if (needsFallback) {
      await logger.info(`Batch ${category.name} failed, falling back to individual execution (${category.statements.length} statements)`, 'supabase', projectId);

      for (const stmt of category.statements) {
        if (Date.now() - startTime > SQL_MAX_TOTAL_TIME_MS) {
          totalFailed++;
          allFailedStatements.push({ sql: stmt.slice(0, 200), error: 'Timed out' });
          continue;
        }

        const singleResult = await executeBatchWithRetry(projectRef, stmt, projectId, category.name, 1);
        totalSucceeded += singleResult.succeeded;
        totalFailed += singleResult.failed;
        allErrors.push(...singleResult.errors);
        allFailedStatements.push(...singleResult.failedStatements);

        await new Promise((r) => setTimeout(r, 250));
      }
    } else {
      totalFailed += result.failed;
      allErrors.push(...result.errors);
      allFailedStatements.push(...result.failedStatements);
    }

    if (category.statements.length > 0) {
      await new Promise((r) => setTimeout(r, SQL_INTER_BATCH_DELAY_MS));
    }
  }

  return { succeeded: totalSucceeded, failed: totalFailed, errors: allErrors, failedStatements: allFailedStatements };
}

function splitSqlStatements(sql: string): string[] {
  let cleaned = sql;
  cleaned = cleaned.replace(/^\s*BEGIN\s*;\s*$/gim, '');
  cleaned = cleaned.replace(/^\s*COMMIT\s*;\s*$/gim, '');
  cleaned = cleaned.replace(/^\s*ROLLBACK\s*;\s*$/gim, '');

  const statements: string[] = [];
  let current = '';
  let inDollarBlock = false;
  const lines = cleaned.split('\n');

  for (const line of lines) {
    if (line.includes('$$') && !inDollarBlock) {
      inDollarBlock = true;
      current += line + '\n';
      if ((line.match(/\$\$/g) || []).length >= 2) {
        inDollarBlock = false;
      }
      continue;
    }

    if (inDollarBlock) {
      current += line + '\n';
      if (line.includes('$$')) {
        inDollarBlock = false;
      }
      continue;
    }

    current += line + '\n';

    if (line.trim().endsWith(';') && !inDollarBlock) {
      const trimmed = current.trim();
      if (trimmed.length >= 5 && !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(trimmed)) {
        statements.push(trimmed);
      }
      current = '';
    }
  }

  if (current.trim() && current.trim().length >= 5) {
    statements.push(current.trim());
  }

  return statements;
}

function generateDbPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  for (const byte of array) {
    result += chars[byte % chars.length];
  }
  return result;
}

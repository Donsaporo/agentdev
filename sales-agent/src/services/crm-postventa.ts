import { getCrmSupabase } from '../core/supabase.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('crm-postventa');

function isAvailable(): boolean {
  return !!getCrmSupabase();
}

export interface CrmProject {
  id: string;
  name: string;
  description: string;
  status: string;
  project_type: string;
  current_stage: string;
  priority: string;
  start_date: string | null;
  end_date: string | null;
  deadline: string | null;
  delivered_at: string | null;
  total_value: number;
  notes: string;
}

export interface CrmProjectUpdate {
  update_type: string;
  title: string;
  description: string;
  created_at: string;
}

export interface CrmMilestone {
  title: string;
  description: string;
  due_date: string | null;
  completed_at: string | null;
  status: string;
  order_index: number;
}

export interface CrmQuotation {
  quotation_display: string;
  status: string;
  quote_date: string;
  expiration_date: string | null;
  total: number;
  notes: string;
}

export interface CrmInvoice {
  invoice_display: string;
  payment_status: string;
  total: number;
  amount_paid: number;
  amount_pending: number;
  due_date: string;
  paid_date: string | null;
  issue_date: string;
}

export interface CrmHosting {
  name: string;
  hosting_type: string;
  domain: string | null;
  status: string;
  server: string;
  go_live_date: string;
  technologies: string[] | null;
  billing_amount: number | null;
  billing_frequency: string | null;
}

export interface CrmRecurringBilling {
  service_name: string;
  amount: number;
  frequency: string;
  next_billing_date: string;
  status: string;
}

export interface CrmTask {
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  assigned_to: string | null;
}

export interface CrmInsight {
  source_type: string;
  insight_type: string;
  title: string;
  content: string;
  confidence: number;
  created_at: string;
}

export interface PostVentaData {
  projects: CrmProject[];
  projectUpdates: Map<string, CrmProjectUpdate[]>;
  projectMilestones: Map<string, CrmMilestone[]>;
  quotations: CrmQuotation[];
  invoices: CrmInvoice[];
  hosting: CrmHosting[];
  recurringBilling: CrmRecurringBilling[];
  tasks: CrmTask[];
  crmInsights: CrmInsight[];
}

export async function getClientProjects(clientId: string): Promise<CrmProject[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_projects')
      .select('id, name, description, status, project_type, current_stage, priority, start_date, end_date, deadline, delivered_at, total_value, notes')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      log.error('Failed to fetch projects', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getClientProjects error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getProjectUpdates(projectIds: string[]): Promise<Map<string, CrmProjectUpdate[]>> {
  if (!isAvailable() || projectIds.length === 0) return new Map();
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_project_updates')
      .select('project_id, update_type, title, description, created_at')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      log.error('Failed to fetch project updates', { error: error.message });
      return new Map();
    }

    const map = new Map<string, CrmProjectUpdate[]>();
    for (const row of data || []) {
      const pid = row.project_id as string;
      if (!map.has(pid)) map.set(pid, []);
      const list = map.get(pid)!;
      if (list.length < 5) {
        list.push({
          update_type: row.update_type,
          title: row.title,
          description: row.description || '',
          created_at: row.created_at,
        });
      }
    }
    return map;
  } catch (err) {
    log.error('getProjectUpdates error', { error: err instanceof Error ? err.message : String(err) });
    return new Map();
  }
}

export async function getProjectMilestones(projectIds: string[]): Promise<Map<string, CrmMilestone[]>> {
  if (!isAvailable() || projectIds.length === 0) return new Map();
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_project_milestones')
      .select('project_id, title, description, due_date, completed_at, status, order_index')
      .in('project_id', projectIds)
      .order('order_index', { ascending: true });

    if (error) {
      log.error('Failed to fetch milestones', { error: error.message });
      return new Map();
    }

    const map = new Map<string, CrmMilestone[]>();
    for (const row of data || []) {
      const pid = row.project_id as string;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push({
        title: row.title,
        description: row.description || '',
        due_date: row.due_date,
        completed_at: row.completed_at,
        status: row.status,
        order_index: row.order_index,
      });
    }
    return map;
  } catch (err) {
    log.error('getProjectMilestones error', { error: err instanceof Error ? err.message : String(err) });
    return new Map();
  }
}

export async function getClientQuotations(clientId: string): Promise<CrmQuotation[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_quotations')
      .select('quotation_display, status, quote_date, expiration_date, total, notes')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      log.error('Failed to fetch quotations', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getClientQuotations error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getClientInvoices(clientId: string): Promise<CrmInvoice[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_invoices')
      .select('invoice_display, payment_status, total, amount_paid, amount_pending, due_date, paid_date, issue_date')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      log.error('Failed to fetch invoices', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getClientInvoices error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getClientHosting(clientId: string): Promise<CrmHosting[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_hosting')
      .select('name, hosting_type, domain, status, server, go_live_date, technologies, billing_amount, billing_frequency')
      .eq('client_id', clientId)
      .limit(5);

    if (error) {
      log.error('Failed to fetch hosting', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getClientHosting error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getClientRecurringBilling(clientId: string): Promise<CrmRecurringBilling[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_recurring_billing')
      .select('service_name, amount, frequency, next_billing_date, status')
      .eq('client_id', clientId)
      .eq('status', 'Activa')
      .limit(5);

    if (error) {
      log.error('Failed to fetch recurring billing', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getClientRecurringBilling error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getClientTasks(clientId: string): Promise<CrmTask[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('tech_tasks')
      .select('title, description, status, priority, due_date, assigned_to')
      .eq('client_id', clientId)
      .neq('status', 'cancelada')
      .order('priority', { ascending: true })
      .order('due_date', { ascending: true })
      .limit(10);

    if (error) {
      log.error('Failed to fetch tasks', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getClientTasks error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getCrmClientInsights(clientId: string): Promise<CrmInsight[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm
      .from('client_insights')
      .select('source_type, insight_type, title, content, confidence, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      log.error('Failed to fetch CRM insights', { clientId, error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    log.error('getCrmClientInsights error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function loadPostVentaData(clientId: string): Promise<PostVentaData> {
  const [projects, quotations, invoices, hosting, recurringBilling, tasks, crmInsights] = await Promise.all([
    getClientProjects(clientId),
    getClientQuotations(clientId),
    getClientInvoices(clientId),
    getClientHosting(clientId),
    getClientRecurringBilling(clientId),
    getClientTasks(clientId),
    getCrmClientInsights(clientId),
  ]);

  const projectIds = projects.map((p) => p.id);
  const [projectUpdates, projectMilestones] = await Promise.all([
    getProjectUpdates(projectIds),
    getProjectMilestones(projectIds),
  ]);

  return {
    projects,
    projectUpdates,
    projectMilestones,
    quotations,
    invoices,
    hosting,
    recurringBilling,
    tasks,
    crmInsights,
  };
}

export async function addCrmClientInsight(
  clientId: string,
  params: { sourceType: string; insightType: string; title: string; content: string; confidence?: number }
): Promise<boolean> {
  if (!isAvailable()) return false;
  const crm = getCrmSupabase()!;

  try {
    const { error } = await crm.from('client_insights').insert({
      client_id: clientId,
      source_type: params.sourceType,
      insight_type: params.insightType,
      title: params.title,
      content: params.content,
      confidence: params.confidence ?? 0.8,
    });

    if (error) {
      log.error('Failed to add CRM insight', { clientId, error: error.message });
      return false;
    }
    return true;
  } catch (err) {
    log.error('addCrmClientInsight error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

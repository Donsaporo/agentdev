import type { PostVentaData, CrmProject } from './crm-postventa.js';

const STAGE_PIPELINE = [
  'planificacion', 'en_desarrollo', 'revision_cliente', 'ajustes', 'entregado', 'cerrado',
];

const STAGE_LABELS: Record<string, string> = {
  planificacion: 'Planificacion',
  en_desarrollo: 'En Desarrollo',
  revision_cliente: 'Revision del Cliente',
  ajustes: 'Ajustes',
  entregado: 'Entregado',
  cerrado: 'Cerrado',
};

const TYPE_LABELS: Record<string, string> = {
  pagina_web: 'Pagina Web',
  crm: 'CRM',
  erp: 'ERP',
  app_movil: 'App Movil',
  otro: 'Otro',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('es-PA', { day: '2-digit', month: '2-digit', year: '2-digit' });
  } catch {
    return iso;
  }
}

function buildPipelineIndicator(currentStage: string): string {
  return STAGE_PIPELINE.map((s) => {
    const label = STAGE_LABELS[s] || s;
    return s === currentStage ? `[${label}] <-- AQUI` : label;
  }).join(' > ');
}

function formatProject(project: CrmProject, data: PostVentaData): string {
  const lines: string[] = [];

  lines.push(`PROYECTO: ${project.name}`);
  lines.push(`  Tipo: ${TYPE_LABELS[project.project_type] || project.project_type}`);
  lines.push(`  Fase actual: ${STAGE_LABELS[project.current_stage] || project.current_stage}`);
  lines.push(`  Pipeline: ${buildPipelineIndicator(project.current_stage)}`);

  if (project.deadline) lines.push(`  Fecha limite: ${fmtDate(project.deadline)}`);
  if (project.start_date) lines.push(`  Inicio: ${fmtDate(project.start_date)}`);
  if (project.delivered_at) lines.push(`  Entregado: ${fmtDate(project.delivered_at)}`);
  if (project.notes) lines.push(`  Notas del equipo: ${project.notes.slice(0, 300)}`);

  const updates = data.projectUpdates.get(project.id) || [];
  if (updates.length > 0) {
    lines.push('  Ultimos avances:');
    for (const u of updates) {
      const date = fmtDate(u.created_at);
      lines.push(`    - [${date}] (${u.update_type}) ${u.title}${u.description ? ': ' + u.description.slice(0, 150) : ''}`);
    }
  }

  const milestones = data.projectMilestones.get(project.id) || [];
  if (milestones.length > 0) {
    const completed = milestones.filter((m) => m.status === 'completado').length;
    lines.push(`  Milestones: ${completed}/${milestones.length} completados`);
    for (const m of milestones) {
      const icon = m.status === 'completado' ? '[OK]' : m.status === 'en_progreso' ? '[EN CURSO]' : '[PENDIENTE]';
      const due = m.due_date ? ` (limite: ${fmtDate(m.due_date)})` : '';
      lines.push(`    ${icon} ${m.title}${due}`);
    }
  }

  return lines.join('\n');
}

export function formatPostVentaContext(data: PostVentaData): string {
  const sections: string[] = [];

  if (data.projects.length > 0) {
    const projectLines = ['=== ESTADO DE PROYECTOS ==='];
    for (const project of data.projects) {
      projectLines.push(formatProject(project, data));
      projectLines.push('');
    }
    sections.push(projectLines.join('\n'));
  }

  if (data.tasks.length > 0) {
    const activeTasks = data.tasks.filter((t) => t.status !== 'completada');
    if (activeTasks.length > 0) {
      const taskLines = ['=== TAREAS ACTIVAS ==='];
      for (const t of activeTasks.slice(0, 8)) {
        const due = t.due_date ? ` | limite: ${fmtDate(t.due_date)}` : '';
        const who = t.assigned_to ? ` | asignada a: ${t.assigned_to}` : '';
        taskLines.push(`  - [${t.priority.toUpperCase()}] ${t.title} (${t.status})${due}${who}`);
      }
      sections.push(taskLines.join('\n'));
    }
  }

  const invoiceSections = formatInvoicesAndBilling(data);
  if (invoiceSections) sections.push(invoiceSections);

  const quotationSection = formatQuotations(data);
  if (quotationSection) sections.push(quotationSection);

  const hostingSection = formatHosting(data);
  if (hostingSection) sections.push(hostingSection);

  const insightSection = formatCrmInsights(data);
  if (insightSection) sections.push(insightSection);

  return sections.join('\n\n');
}

function formatInvoicesAndBilling(data: PostVentaData): string {
  const lines: string[] = [];

  const pendingInvoices = data.invoices.filter((i) =>
    i.payment_status === 'Pendiente' || i.payment_status === 'Pagado Parcial' || i.payment_status === 'Vencido' || i.payment_status === 'Moroso'
  );
  const paidInvoices = data.invoices.filter((i) => i.payment_status === 'Pagado');

  if (pendingInvoices.length > 0 || paidInvoices.length > 0 || data.recurringBilling.length > 0) {
    lines.push('=== FACTURACION ===');
  }

  if (pendingInvoices.length > 0) {
    lines.push('Facturas pendientes:');
    for (const inv of pendingInvoices) {
      const overdue = inv.payment_status === 'Vencido' || inv.payment_status === 'Moroso' ? ' ** VENCIDA **' : '';
      lines.push(`  - ${inv.invoice_display}: $${inv.total} | Pagado: $${inv.amount_paid} | Pendiente: $${inv.amount_pending} | Vence: ${fmtDate(inv.due_date)}${overdue}`);
    }
  }

  if (paidInvoices.length > 0) {
    lines.push(`Facturas pagadas recientes: ${paidInvoices.slice(0, 3).map((i) => `${i.invoice_display} ($${i.total}, pagada ${fmtDate(i.paid_date)})`).join('; ')}`);
  }

  if (data.recurringBilling.length > 0) {
    lines.push('Servicios recurrentes activos:');
    for (const rb of data.recurringBilling) {
      lines.push(`  - ${rb.service_name}: $${rb.amount} ${rb.frequency} | Proxima factura: ${fmtDate(rb.next_billing_date)}`);
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

function formatQuotations(data: PostVentaData): string {
  const relevant = data.quotations.filter((q) => q.status !== 'Expired' && q.status !== 'Rejected');
  if (relevant.length === 0) return '';

  const lines = ['=== COTIZACIONES ==='];
  for (const q of relevant) {
    const expiry = q.expiration_date ? ` | Vence: ${fmtDate(q.expiration_date)}` : '';
    lines.push(`  - ${q.quotation_display}: $${q.total} [${q.status}]${expiry}`);
  }
  return lines.join('\n');
}

function formatHosting(data: PostVentaData): string {
  if (data.hosting.length === 0) return '';

  const lines = ['=== HOSTING Y SERVICIOS ==='];
  for (const h of data.hosting) {
    const domain = h.domain ? ` | Dominio: ${h.domain}` : '';
    const techs = h.technologies?.length ? ` | Tech: ${h.technologies.join(', ')}` : '';
    const billing = h.billing_amount ? ` | $${h.billing_amount} ${h.billing_frequency || ''}` : '';
    lines.push(`  - ${h.name} (${h.hosting_type}) [${h.status}]${domain}${techs}${billing}`);
  }
  return lines.join('\n');
}

function formatCrmInsights(data: PostVentaData): string {
  if (data.crmInsights.length === 0) return '';

  const lines = ['=== INSIGHTS DEL CRM ==='];
  for (const i of data.crmInsights.slice(0, 5)) {
    lines.push(`  - [${i.insight_type}] ${i.title}: ${i.content.slice(0, 200)}`);
  }
  return lines.join('\n');
}

export function formatPreVentaQuotations(data: Pick<PostVentaData, 'quotations'>): string {
  if (data.quotations.length === 0) return '';

  const pending = data.quotations.filter((q) => q.status === 'Sent' || q.status === 'Draft');
  if (pending.length === 0) return '';

  const lines = ['=== COTIZACIONES PENDIENTES ==='];
  for (const q of pending) {
    const expiry = q.expiration_date ? ` | Vence: ${fmtDate(q.expiration_date)}` : '';
    lines.push(`  - ${q.quotation_display}: $${q.total} [${q.status}]${expiry}`);
  }
  return lines.join('\n');
}

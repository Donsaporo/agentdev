import { useEffect, useState } from 'react';
import {
  Server, Database, Globe, ExternalLink, RefreshCw, Pause,
  CheckCircle2, XCircle, Loader2, Rocket,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { Project, Deployment } from '../lib/types';
import { formatDistanceToNow } from 'date-fns';

interface ProjectInfra extends Project {
  latestDeployment?: Deployment;
  deploymentCount: number;
}

export default function InfrastructurePage() {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectInfra[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'deployments' | 'databases'>('overview');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const [projRes, deplRes] = await Promise.all([
      supabase.from('projects').select('*, clients(name)').order('updated_at', { ascending: false }),
      supabase.from('deployments').select('*, projects(name)').order('created_at', { ascending: false }).limit(50),
    ]);

    if (projRes.error) toast.error('Failed to load projects');
    if (deplRes.error) toast.error('Failed to load deployments');

    const projs = (projRes.data || []) as Project[];
    const deps = (deplRes.data || []) as Deployment[];

    const projectsWithInfra: ProjectInfra[] = projs
      .filter((p) => p.vercel_project_id || p.demo_url || p.supabase_project_ref)
      .map((p) => {
        const projDeps = deps.filter((d) => d.project_id === p.id);
        return {
          ...p,
          latestDeployment: projDeps[0],
          deploymentCount: projDeps.length,
        };
      });

    setProjects(projectsWithInfra);
    setDeployments(deps);
    setLoading(false);
  }

  const liveProjects = projects.filter((p) => p.demo_url || p.production_url);
  const withBackend = projects.filter((p) => p.supabase_project_ref);
  const totalDeploys = deployments.length;
  const successDeploys = deployments.filter((d) => d.status === 'ready').length;

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="skeleton h-7 w-48 mb-2" />
        <div className="skeleton h-4 w-64 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-28 rounded-2xl" />)}
        </div>
        <div className="skeleton h-96 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Infrastructure</h1>
          <p className="text-slate-400 mt-1 text-sm">Manage deployed projects, databases, and domains</p>
        </div>
        <button onClick={() => { setLoading(true); loadData(); }} className="btn-ghost flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatMini label="Live Projects" value={liveProjects.length} icon={Rocket} color="emerald" />
        <StatMini label="Databases" value={withBackend.length} icon={Database} color="sky" />
        <StatMini label="Total Deploys" value={totalDeploys} icon={Server} color="amber" />
        <StatMini label="Success Rate" value={totalDeploys > 0 ? `${Math.round((successDeploys / totalDeploys) * 100)}%` : '-'} icon={CheckCircle2} color="teal" />
      </div>

      <div className="flex gap-1 p-1 bg-white/[0.03] rounded-xl border border-white/[0.06] w-fit">
        {(['overview', 'deployments', 'databases'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-[13px] font-medium rounded-lg transition-all ${
              activeTab === tab
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab === 'overview' ? 'All Projects' : tab === 'deployments' ? 'Deploy History' : 'Databases'}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && <OverviewTab projects={projects} />}
      {activeTab === 'deployments' && <DeploymentsTab deployments={deployments} />}
      {activeTab === 'databases' && <DatabasesTab projects={withBackend} />}
    </div>
  );
}

function StatMini({ label, value, icon: Icon, color }: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: 'text-emerald-400 bg-emerald-500/10',
    sky: 'text-sky-400 bg-sky-500/10',
    amber: 'text-amber-400 bg-amber-500/10',
    teal: 'text-teal-400 bg-teal-500/10',
  };
  const cls = colorMap[color] || colorMap.emerald;

  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${cls}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-white">{value}</p>
          <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">{label}</p>
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ projects }: { projects: ProjectInfra[] }) {
  if (projects.length === 0) {
    return (
      <div className="glass-card p-16 text-center border-dashed">
        <Server className="w-10 h-10 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-300 font-medium">No deployed projects yet</p>
        <p className="text-sm text-slate-500 mt-1">Projects will appear here once deployed</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {projects.map((project) => (
        <ProjectInfraCard key={project.id} project={project} />
      ))}
    </div>
  );
}

function ProjectInfraCard({ project }: { project: ProjectInfra }) {
  const statusColor = project.demo_url
    ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
    : 'bg-slate-600';

  return (
    <div className="glass-card-hover p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0 flex-1">
          <div className="relative flex-shrink-0">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center ring-1 ring-white/[0.06]">
              <Server className="w-5 h-5 text-slate-300" />
            </div>
            <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0f1419] ${statusColor}`} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white truncate">{project.name}</h3>
              {project.has_backend && (
                <span className="text-[10px] font-semibold bg-sky-500/10 text-sky-400 px-1.5 py-0.5 rounded ring-1 ring-sky-500/20">DB</span>
              )}
            </div>
            <p className="text-[12px] text-slate-500 mt-0.5">{project.clients?.name || 'No client'}</p>

            <div className="flex flex-wrap gap-3 mt-3">
              {project.demo_url && (
                <a href={project.demo_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400 hover:text-emerald-300 transition-colors">
                  <Globe className="w-3 h-3" />
                  {project.demo_url.replace('https://', '')}
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              )}
              {project.production_url && (
                <a href={project.production_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12px] text-sky-400 hover:text-sky-300 transition-colors">
                  <Globe className="w-3 h-3" />
                  {project.production_url.replace('https://', '')}
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              )}
              {project.git_repo_url && (
                <a href={project.git_repo_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-slate-300 transition-colors">
                  GitHub
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            {project.latestDeployment && (
              <DeployStatusBadge status={project.latestDeployment.status} />
            )}
          </div>
          <div className="text-[11px] text-slate-600">
            {project.deploymentCount} deploy{project.deploymentCount !== 1 ? 's' : ''}
          </div>
          {project.latestDeployment && (
            <div className="text-[11px] text-slate-600">
              {formatDistanceToNow(new Date(project.latestDeployment.created_at), { addSuffix: true })}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-white/[0.04] grid grid-cols-2 sm:grid-cols-4 gap-3">
        {project.vercel_project_id && (
          <InfraDetail label="Vercel" value={project.vercel_project_id.slice(0, 12) + '...'} />
        )}
        {project.supabase_project_ref && (
          <InfraDetail label="Supabase" value={project.supabase_project_ref} />
        )}
        <InfraDetail label="Backend" value={project.has_backend ? 'Yes' : 'No'} />
        <InfraDetail label="Status" value={project.status} />
      </div>
    </div>
  );
}

function InfraDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-600 font-medium">{label}</p>
      <p className="text-[12px] text-slate-300 mt-0.5 truncate capitalize">{value}</p>
    </div>
  );
}

function DeployStatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: React.ElementType; color: string; label: string }> = {
    ready: { icon: CheckCircle2, color: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20', label: 'Live' },
    building: { icon: Loader2, color: 'text-amber-400 bg-amber-500/10 ring-amber-500/20', label: 'Building' },
    error: { icon: XCircle, color: 'text-red-400 bg-red-500/10 ring-red-500/20', label: 'Failed' },
    cancelled: { icon: Pause, color: 'text-slate-400 bg-slate-500/10 ring-slate-500/20', label: 'Cancelled' },
  };

  const c = config[status] || config.error;
  const Icon = c.icon;

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md ring-1 ${c.color}`}>
      <Icon className={`w-3 h-3 ${status === 'building' ? 'animate-spin' : ''}`} />
      {c.label}
    </span>
  );
}

function DeploymentsTab({ deployments }: { deployments: Deployment[] }) {
  if (deployments.length === 0) {
    return (
      <div className="glass-card p-16 text-center border-dashed">
        <Rocket className="w-10 h-10 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-300 font-medium">No deployments recorded yet</p>
      </div>
    );
  }

  return (
    <div className="glass-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Project</th>
              <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
              <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">URL</th>
              <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Trigger</th>
              <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Duration</th>
              <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {deployments.map((dep) => (
              <tr key={dep.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="px-5 py-3.5 text-[13px] text-slate-200 font-medium">
                  {dep.projects?.name || dep.project_id.slice(0, 8)}
                </td>
                <td className="px-5 py-3.5">
                  <DeployStatusBadge status={dep.status} />
                </td>
                <td className="px-5 py-3.5">
                  {dep.url ? (
                    <a href={dep.url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                      {dep.url.replace('https://', '').slice(0, 40)}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-[12px] text-slate-600">-</span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-[12px] text-slate-400 capitalize">{dep.triggered_by}</td>
                <td className="px-5 py-3.5 text-[12px] text-slate-400">
                  {dep.build_duration_seconds > 0 ? `${dep.build_duration_seconds}s` : '-'}
                </td>
                <td className="px-5 py-3.5 text-[12px] text-slate-500">
                  {formatDistanceToNow(new Date(dep.created_at), { addSuffix: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DatabasesTab({ projects }: { projects: ProjectInfra[] }) {
  if (projects.length === 0) {
    return (
      <div className="glass-card p-16 text-center border-dashed">
        <Database className="w-10 h-10 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-300 font-medium">No project databases created yet</p>
        <p className="text-sm text-slate-500 mt-1">Projects with backend requirements will auto-provision databases</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {projects.map((project) => (
        <DatabaseCard key={project.id} project={project} />
      ))}
    </div>
  );
}

function DatabaseCard({ project }: { project: ProjectInfra }) {
  return (
    <div className="glass-card-hover p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-sky-500/10 flex items-center justify-center">
            <Database className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">{project.name}</h3>
            <p className="text-[11px] text-slate-500">{project.clients?.name}</p>
          </div>
        </div>
        <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded ring-1 ring-emerald-500/20">
          Active
        </span>
      </div>

      <div className="space-y-2.5 mt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Ref</span>
          <code className="text-slate-300 text-[11px] font-mono bg-white/[0.04] px-1.5 py-0.5 rounded">
            {project.supabase_project_ref}
          </code>
        </div>
        {project.supabase_url && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">URL</span>
            <a href={project.supabase_url} target="_blank" rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300 text-[11px] flex items-center gap-1">
              {project.supabase_url.replace('https://', '').slice(0, 30)}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Dashboard</span>
          {project.supabase_project_ref && (
            <a
              href={`https://supabase.com/dashboard/project/${project.supabase_project_ref}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300 text-[11px] flex items-center gap-1"
            >
              Open
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-white/[0.04] flex items-center justify-between">
        <span className="text-[11px] text-slate-600">Created {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}</span>
      </div>
    </div>
  );
}

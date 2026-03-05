import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Users, Globe, Activity, ArrowRight, Clock, Bot, Zap, DollarSign, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { Project, AgentLog } from '../lib/types';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import AgentStatusIndicator from '../components/AgentStatusIndicator';
import PhaseIndicator from '../components/PhaseIndicator';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import { formatDistanceToNow } from 'date-fns';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage() {
  const { teamMember } = useAuth();
  const [stats, setStats] = useState({ projects: 0, clients: 0, domains: 0, activeTasks: 0, aiSpend: 0 });
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [recentLogs, setRecentLogs] = useState<AgentLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    const [projectsRes, clientsRes, domainsRes, tasksRes, recentProjRes, logsRes, usageRes] = await Promise.all([
      supabase.from('projects').select('id', { count: 'exact', head: true }),
      supabase.from('clients').select('id', { count: 'exact', head: true }),
      supabase.from('domains').select('id', { count: 'exact', head: true }),
      supabase.from('project_tasks').select('id', { count: 'exact', head: true }).in('status', ['in_progress', 'pending']),
      supabase.from('projects').select('*, clients(name)').order('updated_at', { ascending: false }).limit(5),
      supabase.from('agent_logs').select('*, projects(name)').order('created_at', { ascending: false }).limit(8),
      supabase.from('token_usage').select('cost_estimate'),
    ]);

    const totalSpend = (usageRes.data || []).reduce((sum: number, r: { cost_estimate: number }) => sum + (r.cost_estimate || 0), 0);

    setStats({
      projects: projectsRes.count || 0,
      clients: clientsRes.count || 0,
      domains: domainsRes.count || 0,
      activeTasks: tasksRes.count || 0,
      aiSpend: totalSpend,
    });
    setRecentProjects(recentProjRes.data || []);
    setRecentLogs(logsRes.data || []);
    setLoading(false);
  }

  useRealtimeSubscription({
    table: 'agent_logs',
    event: 'INSERT',
    onInsert: (payload) => {
      const log = payload.new as unknown as AgentLog;
      setRecentLogs(prev => [log, ...prev.slice(0, 7)]);
    },
    enabled: !loading,
  });

  useRealtimeSubscription({
    table: 'projects',
    event: 'UPDATE',
    onUpdate: (payload) => {
      const updated = payload.new as unknown as Project;
      setRecentProjects(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
    },
    enabled: !loading,
  });

  const severityColor: Record<string, string> = {
    info: 'bg-slate-500/10 text-slate-400',
    success: 'bg-emerald-500/10 text-emerald-400',
    warning: 'bg-amber-500/10 text-amber-400',
    error: 'bg-red-500/10 text-red-400',
  };

  if (loading) {
    return (
      <div className="space-y-8 animate-fade-in">
        <div><div className="skeleton h-8 w-64 mb-2" /><div className="skeleton h-4 w-48" /></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton h-[100px] rounded-2xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="skeleton h-80 rounded-2xl" />
          <div className="skeleton h-80 rounded-2xl" />
        </div>
      </div>
    );
  }

  const workingProjects = recentProjects.filter(p => p.agent_status === 'working');

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            {getGreeting()}{teamMember?.full_name ? `, ${teamMember.full_name.split(' ')[0]}` : ''}
          </h1>
          <p className="text-slate-400 mt-1 text-sm">Here is what is happening with your projects</p>
        </div>
        {workingProjects.length > 0 && (
          <div className="hidden sm:flex items-center gap-2 px-4 py-2 glass-card animate-pulse-glow">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-semibold text-emerald-400">{workingProjects.length} active build{workingProjects.length > 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {workingProjects.length > 0 && (
        <div className="glass-card p-5 bg-gradient-to-r from-emerald-500/[0.04] to-teal-500/[0.04]">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Bot className="w-4 h-4 text-emerald-400" />
            </div>
            <span className="text-sm font-semibold text-emerald-400">Agent Working</span>
          </div>
          <div className="space-y-2">
            {workingProjects.map(p => (
              <Link key={p.id} to={`/chat/${p.id}`} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/[0.03] transition-colors">
                <AgentStatusIndicator status={p.agent_status} size="md" />
                <span className="text-sm text-white font-medium">{p.name}</span>
                <PhaseIndicator currentPhase={p.current_phase} compact />
                <div className="ml-auto flex items-center gap-3">
                  <div className="w-20 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all" style={{ width: `${p.progress}%` }} />
                  </div>
                  <span className="text-xs text-slate-400 w-8 text-right">{p.progress}%</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Projects" value={stats.projects} icon={FolderKanban} color="emerald" />
        <StatCard label="Clients" value={stats.clients} icon={Users} color="cyan" />
        <StatCard label="Domains" value={stats.domains} icon={Globe} color="amber" />
        <StatCard label="Pending Tasks" value={stats.activeTasks} icon={Activity} color="rose" />
        <StatCard label="AI Spend" value={`$${stats.aiSpend.toFixed(2)}`} icon={DollarSign} color="emerald" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.04]">
            <div className="flex items-center gap-2.5">
              <FolderKanban className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Recent Projects</h2>
            </div>
            <Link to="/projects" className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors font-medium">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentProjects.length === 0 ? (
            <div className="p-10 text-center">
              <div className="w-12 h-12 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <Sparkles className="w-5 h-5 text-slate-600" />
              </div>
              <p className="text-sm text-slate-400">No projects yet</p>
              <Link to="/projects" className="text-xs text-emerald-400 hover:text-emerald-300 mt-2 inline-block">Create your first project</Link>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.03]">
              {recentProjects.map(project => (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="flex items-center justify-between px-6 py-3.5 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <AgentStatusIndicator status={project.agent_status} />
                      <p className="text-sm font-medium text-slate-200 truncate">{project.name}</p>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5 ml-[22px]">{project.clients?.name || 'No client'}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                    <div className="hidden sm:flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all"
                          style={{ width: `${project.progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-500 w-8 text-right">{project.progress}%</span>
                    </div>
                    <StatusBadge status={project.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="glass-card overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.04]">
            <div className="flex items-center gap-2.5">
              <Activity className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Agent Activity</h2>
            </div>
            <Link to="/activity" className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors font-medium">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentLogs.length === 0 ? (
            <div className="p-10 text-center">
              <div className="w-12 h-12 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <Bot className="w-5 h-5 text-slate-600" />
              </div>
              <p className="text-sm text-slate-400">No activity yet</p>
              <p className="text-xs text-slate-500 mt-1">Activity will appear once the agent starts working</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.03]">
              {recentLogs.map(log => (
                <div key={log.id} className="flex items-start gap-3 px-6 py-3.5 hover:bg-white/[0.02] transition-colors">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${severityColor[log.severity] || severityColor.info}`}>
                    <Activity className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-300 truncate">{log.action}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {log.projects?.name && (
                        <span className="text-xs text-slate-500 truncate">{log.projects.name}</span>
                      )}
                      <span className="text-xs text-slate-600 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

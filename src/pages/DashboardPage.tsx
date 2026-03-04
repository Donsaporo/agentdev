import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Users, Globe, Activity, ArrowRight, Clock, Bot } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Project, AgentLog } from '../lib/types';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import AgentStatusIndicator from '../components/AgentStatusIndicator';
import PhaseIndicator from '../components/PhaseIndicator';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import { formatDistanceToNow } from 'date-fns';

export default function DashboardPage() {
  const [stats, setStats] = useState({ projects: 0, clients: 0, domains: 0, activeTasks: 0 });
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [recentLogs, setRecentLogs] = useState<AgentLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    const [projectsRes, clientsRes, domainsRes, tasksRes, recentProjRes, logsRes] = await Promise.all([
      supabase.from('projects').select('id', { count: 'exact', head: true }),
      supabase.from('clients').select('id', { count: 'exact', head: true }),
      supabase.from('domains').select('id', { count: 'exact', head: true }),
      supabase.from('project_tasks').select('id', { count: 'exact', head: true }).in('status', ['in_progress', 'pending']),
      supabase.from('projects').select('*, clients(name)').order('updated_at', { ascending: false }).limit(5),
      supabase.from('agent_logs').select('*, projects(name)').order('created_at', { ascending: false }).limit(8),
    ]);

    setStats({
      projects: projectsRes.count || 0,
      clients: clientsRes.count || 0,
      domains: domainsRes.count || 0,
      activeTasks: tasksRes.count || 0,
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

  const severityIcon: Record<string, string> = {
    info: 'bg-slate-500/20 text-slate-400',
    success: 'bg-emerald-500/20 text-emerald-400',
    warning: 'bg-amber-500/20 text-amber-400',
    error: 'bg-red-500/20 text-red-400',
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  const workingProjects = recentProjects.filter(p => p.agent_status === 'working');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-slate-400 mt-1">Overview of your development projects and agent activity</p>
      </div>

      {workingProjects.length > 0 && (
        <div className="bg-gradient-to-r from-emerald-500/5 to-cyan-500/5 border border-emerald-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bot className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-medium text-emerald-400">Agent Working</span>
          </div>
          <div className="space-y-2">
            {workingProjects.map(p => (
              <Link key={p.id} to={`/chat/${p.id}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/20 transition-colors">
                <AgentStatusIndicator status={p.agent_status} size="md" />
                <span className="text-sm text-white font-medium">{p.name}</span>
                <PhaseIndicator currentPhase={p.current_phase} compact />
                <div className="ml-auto flex items-center gap-2">
                  <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all" style={{ width: `${p.progress}%` }} />
                  </div>
                  <span className="text-xs text-slate-400">{p.progress}%</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Projects" value={stats.projects} icon={FolderKanban} color="emerald" />
        <StatCard label="Clients" value={stats.clients} icon={Users} color="cyan" />
        <StatCard label="Active Domains" value={stats.domains} icon={Globe} color="amber" />
        <StatCard label="Pending Tasks" value={stats.activeTasks} icon={Activity} color="rose" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/40">
            <h2 className="text-sm font-semibold text-white">Recent Projects</h2>
            <Link to="/projects" className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentProjects.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">No projects yet</div>
          ) : (
            <div className="divide-y divide-slate-800/40">
              {recentProjects.map(project => (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-800/20 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <AgentStatusIndicator status={project.agent_status} />
                      <p className="text-sm font-medium text-slate-200 truncate">{project.name}</p>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5 ml-3.5">{project.clients?.name || 'No client'}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                    <div className="hidden sm:flex items-center gap-1.5">
                      <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all"
                          style={{ width: `${project.progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-500">{project.progress}%</span>
                    </div>
                    <StatusBadge status={project.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/40">
            <h2 className="text-sm font-semibold text-white">Agent Activity</h2>
            <Link to="/activity" className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentLogs.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">No activity yet</div>
          ) : (
            <div className="divide-y divide-slate-800/40">
              {recentLogs.map(log => (
                <div key={log.id} className="flex items-start gap-3 px-5 py-3.5">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${severityIcon[log.severity] || severityIcon.info}`}>
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

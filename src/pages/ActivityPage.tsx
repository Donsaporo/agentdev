import { useEffect, useState } from 'react';
import { Activity, Search, Filter, Clock, Cpu, Rocket, Globe, AlertTriangle, CheckCircle2, Info, AlertCircle, Bot } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { AgentLog } from '../lib/types';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import { formatDistanceToNow, format } from 'date-fns';

const categories = [
  { value: '', label: 'All categories' },
  { value: 'development', label: 'Development' },
  { value: 'deployment', label: 'Deployment' },
  { value: 'dns', label: 'DNS' },
  { value: 'qa', label: 'QA' },
  { value: 'system', label: 'System' },
  { value: 'error', label: 'Errors' },
];

const severityConfig: Record<string, { icon: typeof Info; color: string; bg: string }> = {
  info: { icon: Info, color: 'text-slate-400', bg: 'bg-slate-500/10' },
  success: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  warning: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10' },
  error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
};

const categoryIcon: Record<string, typeof Cpu> = {
  development: Cpu,
  deployment: Rocket,
  dns: Globe,
  qa: CheckCircle2,
  system: Bot,
  error: AlertCircle,
};

export default function ActivityPage() {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  useEffect(() => {
    loadLogs();
  }, [filterCategory, page]);

  async function loadLogs() {
    let query = supabase
      .from('agent_logs')
      .select('*, projects(name)')
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (filterCategory) {
      query = query.eq('category', filterCategory);
    }

    const { data } = await query;
    setLogs(data || []);
    setLoading(false);
  }

  useRealtimeSubscription({
    table: 'agent_logs',
    event: 'INSERT',
    onInsert: (payload) => {
      if (page === 0) {
        const log = payload.new as unknown as AgentLog;
        if (!filterCategory || log.category === filterCategory) {
          setLogs(prev => [log, ...prev.slice(0, pageSize - 1)]);
        }
      }
    },
    enabled: !loading,
  });

  const filtered = logs.filter(l =>
    l.action.toLowerCase().includes(search.toLowerCase()) ||
    l.projects?.name?.toLowerCase().includes(search.toLowerCase())
  );

  const groupedByDate = filtered.reduce<Record<string, AgentLog[]>>((acc, log) => {
    const date = format(new Date(log.created_at), 'yyyy-MM-dd');
    if (!acc[date]) acc[date] = [];
    acc[date].push(log);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div><div className="skeleton h-7 w-36 mb-2" /><div className="skeleton h-4 w-52" /></div>
        <div className="flex gap-3"><div className="skeleton h-11 flex-1 rounded-xl" /><div className="skeleton h-11 w-48 rounded-xl" /></div>
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton h-16 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Agent Activity</h1>
        <p className="text-slate-400 mt-1 text-sm">Real-time log of the AI agent's actions and decisions</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search activity..." className="w-full glass-input pl-10" />
        </div>
        <div className="relative">
          <Filter className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <select value={filterCategory} onChange={e => { setFilterCategory(e.target.value); setPage(0); }} className="glass-select pl-10 pr-8 appearance-none">
            {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
            <Activity className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">No agent activity recorded yet</p>
          <p className="text-sm text-slate-500 mt-1">Activity will appear here once the agent starts processing projects</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedByDate).map(([date, dateLogs]) => (
            <div key={date}>
              <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">
                {format(new Date(date), 'EEEE, MMMM d, yyyy')}
              </h3>
              <div className="relative pl-6 space-y-0">
                <div className="absolute left-[11px] top-2 bottom-2 w-px bg-white/[0.04]" />
                {dateLogs.map(log => {
                  const config = severityConfig[log.severity] || severityConfig.info;
                  const SeverityIcon = config.icon;
                  const CatIcon = categoryIcon[log.category] || Activity;

                  return (
                    <div key={log.id} className="relative flex items-start gap-4 py-3 group">
                      <div className={`absolute left-[-13px] w-5 h-5 rounded-full ${config.bg} flex items-center justify-center ring-4 ring-[#0a0e17]`}>
                        <SeverityIcon className={`w-3 h-3 ${config.color}`} />
                      </div>
                      <div className="flex-1 min-w-0 glass-card px-4 py-3 group-hover:bg-white/[0.04] transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-slate-200">{log.action}</p>
                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                              {log.projects?.name && (
                                <span className="text-xs text-slate-500">{log.projects.name}</span>
                              )}
                              <span className="inline-flex items-center gap-1 text-xs text-slate-600 capitalize">
                                <CatIcon className="w-3 h-3" />
                                {log.category}
                              </span>
                              <span className="text-xs text-slate-600 flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                              </span>
                            </div>
                          </div>
                        </div>
                        {log.details && Object.keys(log.details).length > 0 && (
                          <pre className="mt-2 text-xs text-slate-500 bg-white/[0.02] rounded-lg px-3 py-2 overflow-x-auto border border-white/[0.04]">
                            {JSON.stringify(log.details, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex justify-center gap-3">
            {page > 0 && (
              <button onClick={() => setPage(page - 1)} className="btn-ghost">Previous</button>
            )}
            {logs.length === pageSize && (
              <button onClick={() => setPage(page + 1)} className="btn-ghost">Next</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

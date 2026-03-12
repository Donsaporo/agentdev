import { NavLink } from 'react-router-dom';
import {
  Bot,
  LayoutDashboard,
  Users,
  FolderKanban,
  FileText,
  MessageSquare,
  MonitorCheck,
  Globe,
  Server,
  Activity,
  Settings,
  LogOut,
  Menu,
  X,
  Inbox,
  Shield,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/clients', icon: Users, label: 'Clients' },
  { to: '/projects', icon: FolderKanban, label: 'Projects' },
  { to: '/briefs', icon: FileText, label: 'Briefs' },
  { to: '/chat', icon: MessageSquare, label: 'Agent Chat', badgeKey: 'chat' as const },
  { to: '/qa', icon: MonitorCheck, label: 'QA Review', badgeKey: 'qa' as const },
  { to: '/inbox', icon: Inbox, label: 'Inbox WA', badgeKey: 'inbox' as const },
  { to: '/director', icon: Shield, label: 'Director' },
  { to: '/domains', icon: Globe, label: 'Domains' },
  { to: '/infrastructure', icon: Server, label: 'Infrastructure' },
  { to: '/activity', icon: Activity, label: 'Activity' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar() {
  const { signOut, teamMember } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingQA, setPendingQA] = useState(0);
  const [unreadWA, setUnreadWA] = useState(0);
  const [agentOnline, setAgentOnline] = useState(false);

  useEffect(() => {
    loadBadges();
    checkAgentStatus();
    const statusInterval = setInterval(checkAgentStatus, 60000);
    const badgeInterval = setInterval(loadBadges, 30000);
    return () => {
      clearInterval(statusInterval);
      clearInterval(badgeInterval);
    };
  }, []);

  async function checkAgentStatus() {
    const [{ data: devData }, { data: salesData }] = await Promise.all([
      supabase.from('agent_heartbeat').select('last_seen, status').eq('id', 1).maybeSingle(),
      supabase.from('sales_agent_heartbeat').select('last_seen, status').eq('id', 'sales-agent').maybeSingle(),
    ]);

    let online = false;

    if (devData) {
      const diffMs = Date.now() - new Date(devData.last_seen).getTime();
      if (diffMs < 180000 && devData.status === 'online') online = true;
    }

    if (salesData) {
      const diffMs = Date.now() - new Date(salesData.last_seen).getTime();
      if (diffMs < 120000 && salesData.status === 'online') online = true;
    }

    setAgentOnline(online);
  }

  async function loadBadges() {
    const [{ count: qaCount }, { data: waData }] = await Promise.all([
      supabase.from('qa_screenshots').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('whatsapp_conversations').select('unread_count').gt('unread_count', 0),
    ]);
    setPendingQA(qaCount || 0);
    setUnreadWA(waData?.reduce((sum, c) => sum + (c.unread_count || 0), 0) || 0);
  }

  const getBadge = (key?: string) => {
    if (key === 'qa' && pendingQA > 0) return pendingQA;
    if (key === 'inbox' && unreadWA > 0) return unreadWA;
    return 0;
  };

  const navContent = (
    <>
      <div className="px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0d1117] ${agentOnline ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-slate-600'}`} />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white tracking-tight">Obzide</h1>
            <p className={`text-[11px] font-medium ${agentOnline ? 'text-emerald-400' : 'text-slate-500'}`}>
              {agentOnline ? 'Agent Online' : 'Agent Offline'}
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 mb-2">
        <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
      </div>

      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {navItems.map(item => {
          const badge = getBadge(item.badgeKey);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `relative flex items-center gap-3 px-3 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-emerald-500/10 text-emerald-400 shadow-sm shadow-emerald-500/5'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-emerald-500 rounded-r-full" />
                  )}
                  <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {badge > 0 && (
                    <span className="min-w-[20px] h-5 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[10px] font-bold px-1.5">
                      {badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="p-3">
        <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent mb-3" />
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center flex-shrink-0 text-xs font-bold text-white uppercase ring-1 ring-white/[0.06]">
            {teamMember?.full_name?.charAt(0) || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-slate-200 truncate">{teamMember?.full_name || 'Team Member'}</p>
            <p className="text-[11px] text-slate-500 truncate capitalize">{teamMember?.role || 'developer'}</p>
          </div>
          <button
            onClick={signOut}
            className="text-slate-600 hover:text-red-400 transition-colors flex-shrink-0 p-1 rounded-lg hover:bg-white/[0.04]"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-[#0d1117] border border-white/[0.06] rounded-xl text-slate-400 shadow-lg"
      >
        <Menu className="w-5 h-5" />
      </button>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`
        fixed lg:static inset-y-0 left-0 z-50 w-[260px] bg-[#0d1117]/95 backdrop-blur-xl border-r border-white/[0.04] flex flex-col
        transition-transform lg:transition-none
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden absolute top-4 right-4 text-slate-400 p-1 rounded-lg hover:bg-white/[0.04]"
        >
          <X className="w-5 h-5" />
        </button>
        {navContent}
      </aside>
    </>
  );
}

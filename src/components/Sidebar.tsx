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
  Activity,
  Settings,
  LogOut,
  Menu,
  X,
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
  { to: '/domains', icon: Globe, label: 'Domains' },
  { to: '/activity', icon: Activity, label: 'Agent Activity' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar() {
  const { signOut, teamMember } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingQA, setPendingQA] = useState(0);

  useEffect(() => {
    loadBadges();
  }, []);

  async function loadBadges() {
    const { count } = await supabase
      .from('qa_screenshots')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    setPendingQA(count || 0);
  }

  const getBadge = (key?: string) => {
    if (key === 'qa' && pendingQA > 0) return pendingQA;
    return 0;
  };

  const navContent = (
    <>
      <div className="flex items-center gap-3 px-5 py-6">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-white truncate">Obzide Dev Agent</h1>
          <p className="text-xs text-slate-500 truncate">AI Development Platform</p>
        </div>
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
                `relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-emerald-500/10 text-emerald-400 before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:bg-emerald-500 before:rounded-r-full'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`
              }
            >
              <item.icon className="w-4.5 h-4.5 flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              {badge > 0 && (
                <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-emerald-500 text-white text-[10px] font-bold px-1">
                  {badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="p-3 border-t border-slate-800/60">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0 text-xs font-bold text-white uppercase">
            {teamMember?.full_name?.charAt(0) || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-200 truncate">{teamMember?.full_name || 'Team Member'}</p>
            <p className="text-xs text-slate-500 truncate capitalize">{teamMember?.role || 'developer'}</p>
          </div>
          <button
            onClick={signOut}
            className="text-slate-500 hover:text-red-400 transition-colors flex-shrink-0"
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
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-400"
      >
        <Menu className="w-5 h-5" />
      </button>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 bg-slate-950 border-r border-slate-800/60 flex flex-col
        transition-transform lg:transition-none
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden absolute top-4 right-4 text-slate-400"
        >
          <X className="w-5 h-5" />
        </button>
        {navContent}
      </aside>
    </>
  );
}

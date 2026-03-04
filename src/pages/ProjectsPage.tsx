import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, FolderKanban, ExternalLink, GitBranch, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { Project, Client, ProjectType, ProjectStatus } from '../lib/types';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import AgentStatusIndicator from '../components/AgentStatusIndicator';
import { formatDistanceToNow } from 'date-fns';

const projectTypes: { value: ProjectType; label: string }[] = [
  { value: 'website', label: 'Website' },
  { value: 'ecommerce', label: 'E-Commerce' },
  { value: 'mobile_app', label: 'Mobile App' },
  { value: 'crm', label: 'CRM / System' },
  { value: 'custom', label: 'Custom' },
];

const projectStatuses: { value: ProjectStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'planning', label: 'Planning' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'qa', label: 'QA' },
  { value: 'review', label: 'Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'deployed', label: 'Deployed' },
];

export default function ProjectsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: '',
    client_id: '',
    type: 'website' as ProjectType,
    description: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const [projRes, clientRes] = await Promise.all([
      supabase.from('projects').select('*, clients(name)').order('updated_at', { ascending: false }),
      supabase.from('clients').select('*').order('name'),
    ]);
    if (projRes.error) toast.error('Failed to load projects: ' + projRes.error.message);
    if (clientRes.error) toast.error('Failed to load clients: ' + clientRes.error.message);
    setProjects(projRes.data || []);
    setClients(clientRes.data || []);
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.from('projects').insert({
      ...form,
      created_by: user?.id,
    });
    if (error) {
      toast.error('Failed to create project: ' + error.message);
      setSubmitting(false);
      return;
    }
    toast.success('Project created');
    setSubmitting(false);
    setShowModal(false);
    setForm({ name: '', client_id: '', type: 'website', description: '' });
    loadData();
  }

  const filtered = projects.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.clients?.name?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = !filterStatus || p.status === filterStatus;
    return matchSearch && matchStatus;
  });

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex justify-between items-center">
          <div><div className="skeleton h-7 w-28 mb-2" /><div className="skeleton h-4 w-36" /></div>
          <div className="skeleton h-10 w-32 rounded-lg" />
        </div>
        <div className="flex gap-3"><div className="skeleton h-11 flex-1 rounded-lg" /><div className="skeleton h-11 w-40 rounded-lg" /></div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-20 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Projects</h1>
          <p className="text-slate-400 mt-1">{projects.length} total projects</p>
        </div>
        <button onClick={() => setShowModal(true)} className="inline-flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-all active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full bg-slate-900/60 border border-slate-800/60 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
          />
        </div>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="bg-slate-900/60 border border-slate-800/60 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
        >
          <option value="">All statuses</option>
          {projectStatuses.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-slate-900/40 border border-slate-800/40 border-dashed rounded-2xl p-16 text-center animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-slate-800/50 flex items-center justify-center mx-auto mb-4">
            <FolderKanban className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">{search || filterStatus ? 'No projects match your filters' : 'No projects yet'}</p>
          {!search && !filterStatus && (
            <button onClick={() => setShowModal(true)} className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
              Create your first project
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((project, i) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className={`block bg-slate-900/60 border border-slate-800/60 rounded-xl p-5 hover:border-slate-700/60 transition-all group animate-fade-in-up stagger-${Math.min(i % 4 + 1, 5)}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <AgentStatusIndicator status={project.agent_status} />
                    <h3 className="text-sm font-semibold text-white truncate group-hover:text-emerald-400 transition-colors">{project.name}</h3>
                    <StatusBadge status={project.status} />
                    <span className="text-xs text-slate-600 bg-slate-800/50 px-2 py-0.5 rounded capitalize hidden sm:inline">{project.type.replace('_', ' ')}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5 truncate">
                    {project.clients?.name || 'No client'} &middot; Updated {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
                  </p>
                </div>

                <div className="flex items-center gap-4 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all"
                        style={{ width: `${project.progress}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 w-8 text-right">{project.progress}%</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {project.demo_url && (
                      <span className="text-slate-600 hover:text-emerald-400 transition-colors" title="Demo URL">
                        <ExternalLink className="w-4 h-4" />
                      </span>
                    )}
                    {project.git_repo_url && (
                      <span className="text-slate-600 hover:text-emerald-400 transition-colors" title="Git repo">
                        <GitBranch className="w-4 h-4" />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Project">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Project Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              required
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
              placeholder="Client Website Redesign"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Client</label>
              <select
                value={form.client_id}
                onChange={e => setForm({ ...form, client_id: e.target.value })}
                required
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
              >
                <option value="">Select client</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Type</label>
              <select
                value={form.type}
                onChange={e => setForm({ ...form, type: e.target.value as ProjectType })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
              >
                {projectTypes.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Description</label>
            <textarea
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none"
              placeholder="Brief description of the project..."
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50 active:scale-[0.97]"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Project
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  { value: 'landing', label: 'Landing Page' },
  { value: 'ecommerce', label: 'E-Commerce' },
  { value: 'crm', label: 'CRM / System' },
  { value: 'lms', label: 'LMS / Education' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'saas', label: 'SaaS Platform' },
  { value: 'blog', label: 'Blog' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'pwa', label: 'PWA / Mobile App' },
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
  const navigate = useNavigate();
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
          <div className="skeleton h-10 w-32 rounded-xl" />
        </div>
        <div className="flex gap-3"><div className="skeleton h-11 flex-1 rounded-xl" /><div className="skeleton h-11 w-40 rounded-xl" /></div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-20 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Projects</h1>
          <p className="text-slate-400 mt-1 text-sm">{projects.length} total projects</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects..." className="w-full glass-input pl-10" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="glass-select">
          <option value="">All statuses</option>
          {projectStatuses.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="glass-card p-16 text-center border-dashed animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
            <FolderKanban className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">{search || filterStatus ? 'No projects match your filters' : 'No projects yet'}</p>
          {!search && !filterStatus && (
            <button onClick={() => setShowModal(true)} className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors">Create your first project</button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((project, i) => (
            <div
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className={`block glass-card-hover p-5 animate-fade-in-up cursor-pointer stagger-${Math.min(i % 4 + 1, 5)}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <AgentStatusIndicator status={project.agent_status} />
                    <h3 className="text-sm font-semibold text-white truncate group-hover:text-emerald-400 transition-colors">{project.name}</h3>
                    <StatusBadge status={project.status} />
                    <span className="text-[11px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded-md capitalize hidden sm:inline">{project.type.replace('_', ' ')}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5 truncate">
                    {project.clients?.name || 'No client'} &middot; Updated {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
                  </p>
                </div>

                <div className="flex items-center gap-4 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all" style={{ width: `${project.progress}%` }} />
                    </div>
                    <span className="text-xs text-slate-500 w-8 text-right">{project.progress}%</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {project.demo_url && (
                      <a href={project.demo_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-slate-600 hover:text-emerald-400 transition-colors" title="Demo URL">
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                    {project.git_repo_url && (
                      <a href={project.git_repo_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-slate-600 hover:text-emerald-400 transition-colors" title="Git repo">
                        <GitBranch className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Project">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Project Name</label>
            <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required className="w-full glass-input" placeholder="Client Website Redesign" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Client</label>
              <select value={form.client_id} onChange={e => setForm({ ...form, client_id: e.target.value })} required className="w-full glass-select">
                <option value="">Select client</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value as ProjectType })} className="w-full glass-select">
                {projectTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Description</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} className="w-full glass-input resize-none" placeholder="Brief description of the project..." />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="btn-primary disabled:opacity-50">
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Project
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

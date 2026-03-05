import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MonitorCheck, Filter, Rocket, X, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { Project, QAScreenshot, QAScreenshotStatus } from '../lib/types';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import QAScreenshotCard from './qa/QAScreenshotCard';

type FilterType = 'all' | QAScreenshotStatus;

export default function QAReviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projectId || '');
  const [screenshots, setScreenshots] = useState<QAScreenshot[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      loadScreenshots(selectedProjectId);
    }
  }, [selectedProjectId]);

  async function loadProjects() {
    const { data, error } = await supabase.from('projects').select('*, clients(name)').order('updated_at', { ascending: false });
    if (error) toast.error('Failed to load projects');
    setProjects(data || []);
    if (!selectedProjectId && data && data.length > 0) {
      setSelectedProjectId(data[0].id);
    }
    setLoading(false);
  }

  async function loadScreenshots(pid: string) {
    const { data, error } = await supabase
      .from('qa_screenshots')
      .select('*')
      .eq('project_id', pid)
      .order('page_name')
      .order('version_number', { ascending: false });
    if (error) toast.error('Failed to load screenshots');
    setScreenshots(data || []);
  }

  useRealtimeSubscription({
    table: 'qa_screenshots',
    event: 'INSERT',
    filter: selectedProjectId ? `project_id=eq.${selectedProjectId}` : undefined,
    onInsert: () => loadScreenshots(selectedProjectId),
    enabled: !!selectedProjectId,
  });

  async function handleApprove(id: string) {
    const { error } = await supabase.from('qa_screenshots').update({ status: 'approved' }).eq('id', id);
    if (error) {
      toast.error('Failed to approve screenshot');
      return;
    }
    toast.success('Screenshot approved');
    setScreenshots(prev => prev.map(s => s.id === id ? { ...s, status: 'approved' as const } : s));
  }

  async function handleReject(id: string, notes: string) {
    const { error } = await supabase.from('qa_screenshots').update({ status: 'rejected', rejection_notes: notes }).eq('id', id);
    if (error) {
      toast.error('Failed to reject screenshot');
      return;
    }
    toast.success('Screenshot rejected -- agent will fix it');
    setScreenshots(prev => prev.map(s => s.id === id ? { ...s, status: 'rejected' as const, rejection_notes: notes } : s));
  }

  async function handleApproveAllAndDeploy() {
    if (!selectedProjectId) return;
    setDeploying(true);
    const pending = screenshots.filter(s => s.status === 'pending');
    for (const s of pending) {
      await supabase.from('qa_screenshots').update({ status: 'approved' }).eq('id', s.id);
    }
    setScreenshots(prev => prev.map(s => s.status === 'pending' ? { ...s, status: 'approved' as const } : s));

    await supabase.from('projects').update({ status: 'deployed' }).eq('id', selectedProjectId);

    const { data: conv } = await supabase
      .from('agent_conversations')
      .select('id')
      .eq('project_id', selectedProjectId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (conv) {
      await supabase.from('agent_messages').insert({
        conversation_id: conv.id,
        role: 'system',
        content: 'All QA screenshots approved. Deploy to production requested.',
      });
    }

    setDeploying(false);
    toast.success('All screenshots approved. Agent will deploy to production.');
  }

  function handleSelectProject(id: string) {
    setSelectedProjectId(id);
    navigate(`/qa/${id}`, { replace: true });
  }

  const filtered = filter === 'all' ? screenshots : screenshots.filter(s => s.status === filter);
  const pendingCount = screenshots.filter(s => s.status === 'pending').length;
  const approvedCount = screenshots.filter(s => s.status === 'approved').length;
  const allApproved = screenshots.length > 0 && pendingCount === 0 && screenshots.every(s => s.status === 'approved');

  const filterButtons: { key: FilterType; label: string }[] = [
    { key: 'all', label: `All (${screenshots.length})` },
    { key: 'pending', label: `Pending (${pendingCount})` },
    { key: 'approved', label: `Approved (${approvedCount})` },
    { key: 'rejected', label: `Needs Fix (${screenshots.filter(s => s.status === 'rejected').length})` },
  ];

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex justify-between items-center">
          <div><div className="skeleton h-7 w-28 mb-2" /><div className="skeleton h-4 w-52" /></div>
        </div>
        <div className="flex gap-4">
          <div className="skeleton h-11 w-64 rounded-xl" />
          <div className="skeleton h-9 w-56 rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-64 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">QA Review</h1>
          <p className="text-slate-400 mt-1 text-sm">Review screenshots and approve pages for deployment</p>
        </div>
        {allApproved && (
          <button onClick={handleApproveAllAndDeploy} disabled={deploying} className="btn-primary disabled:opacity-50">
            {deploying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            Approve All & Deploy
          </button>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <select value={selectedProjectId} onChange={e => handleSelectProject(e.target.value)} className="glass-select sm:w-64">
          <option value="">Select project</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <div className="flex items-center gap-1 overflow-x-auto">
          <Filter className="w-4 h-4 text-slate-500 flex-shrink-0" />
          {filterButtons.map(fb => (
            <button
              key={fb.key}
              onClick={() => setFilter(fb.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                filter === fb.key
                  ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
              }`}
            >
              {fb.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="glass-card p-16 text-center border-dashed animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
            <MonitorCheck className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">
            {screenshots.length === 0
              ? 'No screenshots yet. The agent will capture them during QA.'
              : 'No screenshots match this filter.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map(screenshot => (
            <QAScreenshotCard
              key={screenshot.id}
              screenshot={screenshot}
              onApprove={handleApprove}
              onReject={handleReject}
              onPreview={setPreviewUrl}
            />
          ))}
        </div>
      )}

      {previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md" onClick={() => setPreviewUrl(null)}>
          <button onClick={() => setPreviewUrl(null)} className="absolute top-4 right-4 p-2.5 text-white/60 hover:text-white bg-white/[0.06] rounded-xl transition-colors">
            <X className="w-6 h-6" />
          </button>
          <img src={previewUrl} alt="Screenshot preview" className="max-w-full max-h-[90vh] rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

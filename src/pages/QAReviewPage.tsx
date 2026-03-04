import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MonitorCheck, Filter, Rocket, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Project, QAScreenshot, QAScreenshotStatus } from '../lib/types';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import QAScreenshotCard from './qa/QAScreenshotCard';

type FilterType = 'all' | QAScreenshotStatus;

export default function QAReviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projectId || '');
  const [screenshots, setScreenshots] = useState<QAScreenshot[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      loadScreenshots(selectedProjectId);
    }
  }, [selectedProjectId]);

  async function loadProjects() {
    const { data } = await supabase.from('projects').select('*, clients(name)').order('updated_at', { ascending: false });
    setProjects(data || []);
    if (!selectedProjectId && data && data.length > 0) {
      setSelectedProjectId(data[0].id);
    }
    setLoading(false);
  }

  async function loadScreenshots(pid: string) {
    const { data } = await supabase
      .from('qa_screenshots')
      .select('*')
      .eq('project_id', pid)
      .order('page_name')
      .order('version_number', { ascending: false });
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
    await supabase.from('qa_screenshots').update({ status: 'approved' }).eq('id', id);
    setScreenshots(prev => prev.map(s => s.id === id ? { ...s, status: 'approved' as const } : s));
  }

  async function handleReject(id: string, notes: string) {
    await supabase.from('qa_screenshots').update({ status: 'rejected', rejection_notes: notes }).eq('id', id);
    setScreenshots(prev => prev.map(s => s.id === id ? { ...s, status: 'rejected' as const, rejection_notes: notes } : s));
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
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">QA Review</h1>
          <p className="text-slate-400 mt-1">Review screenshots and approve pages for deployment</p>
        </div>
        {allApproved && (
          <button className="inline-flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-all shadow-lg shadow-emerald-500/20">
            <Rocket className="w-4 h-4" />
            Approve All & Deploy
          </button>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <select
          value={selectedProjectId}
          onChange={e => handleSelectProject(e.target.value)}
          className="bg-slate-900/60 border border-slate-800/60 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors sm:w-64"
        >
          <option value="">Select project</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <div className="flex items-center gap-1 overflow-x-auto">
          <Filter className="w-4 h-4 text-slate-500 flex-shrink-0" />
          {filterButtons.map(fb => (
            <button
              key={fb.key}
              onClick={() => setFilter(fb.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                filter === fb.key
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              {fb.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-12 text-center">
          <MonitorCheck className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => setPreviewUrl(null)}>
          <button
            onClick={() => setPreviewUrl(null)}
            className="absolute top-4 right-4 p-2 text-white/60 hover:text-white bg-slate-900/60 rounded-lg transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={previewUrl}
            alt="Screenshot preview"
            className="max-w-full max-h-[90vh] rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

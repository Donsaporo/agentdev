import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MonitorCheck, Filter, Rocket, X, Loader2, Camera, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { Project, QAScreenshot, QAScreenshotStatus } from '../lib/types';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import { triggerScreenshots } from '../lib/screenshots';
import QAScreenshotCard from './qa/QAScreenshotCard';
import Modal from '../components/Modal';

type FilterType = 'all' | QAScreenshotStatus;

interface PageEntry {
  name: string;
  url: string;
}

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
  const [showCaptureModal, setShowCaptureModal] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [capturePages, setCapturePages] = useState<PageEntry[]>([{ name: 'Home', url: '' }]);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      loadScreenshots(selectedProjectId);
      prefillCaptureUrl(selectedProjectId);
    }
  }, [selectedProjectId]);

  function prefillCaptureUrl(pid: string) {
    const proj = projects.find(p => p.id === pid);
    if (proj?.demo_url) {
      setCapturePages([{ name: 'Home', url: proj.demo_url }]);
    }
  }

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

  async function handleCaptureScreenshots() {
    const validPages = capturePages.filter(p => p.name.trim() && p.url.trim());
    if (validPages.length === 0) {
      toast.error('Add at least one page with a name and URL');
      return;
    }

    setCapturing(true);
    const { error } = await triggerScreenshots(selectedProjectId, validPages);
    setCapturing(false);

    if (error) {
      toast.error('Screenshot capture failed: ' + error);
      return;
    }

    toast.success(`Capturing ${validPages.length} page(s). Screenshots will appear shortly.`);
    setShowCaptureModal(false);
    loadScreenshots(selectedProjectId);
  }

  function addPageRow() {
    const proj = projects.find(p => p.id === selectedProjectId);
    const baseUrl = proj?.demo_url || '';
    setCapturePages(prev => [...prev, { name: '', url: baseUrl }]);
  }

  function removePageRow(index: number) {
    setCapturePages(prev => prev.filter((_, i) => i !== index));
  }

  function updatePageRow(index: number, field: 'name' | 'url', value: string) {
    setCapturePages(prev => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
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
        <div className="flex items-center gap-3">
          {selectedProjectId && (
            <button
              onClick={() => setShowCaptureModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/[0.12] text-slate-200 text-sm font-semibold rounded-xl transition-all"
            >
              <Camera className="w-4 h-4" />
              Capture Screenshots
            </button>
          )}
          {allApproved && (
            <button onClick={handleApproveAllAndDeploy} disabled={deploying} className="btn-primary disabled:opacity-50">
              {deploying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
              Approve All & Deploy
            </button>
          )}
        </div>
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
              ? 'No screenshots yet. Click "Capture Screenshots" to get started.'
              : 'No screenshots match this filter.'}
          </p>
          {screenshots.length === 0 && selectedProjectId && (
            <button
              onClick={() => setShowCaptureModal(true)}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 rounded-xl transition-all"
            >
              <Camera className="w-4 h-4" />
              Capture Screenshots
            </button>
          )}
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

      <Modal open={showCaptureModal} onClose={() => setShowCaptureModal(false)} title="Capture QA Screenshots" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            Enter the pages you want to screenshot. Each page will be captured at desktop, tablet, and mobile viewports.
          </p>

          <div className="space-y-3">
            {capturePages.map((page, index) => (
              <div key={index} className="flex items-start gap-3">
                <div className="w-40 flex-shrink-0">
                  <input
                    type="text"
                    value={page.name}
                    onChange={e => updatePageRow(index, 'name', e.target.value)}
                    placeholder="Page name"
                    className="w-full glass-input text-sm"
                  />
                </div>
                <div className="flex-1">
                  <input
                    type="url"
                    value={page.url}
                    onChange={e => updatePageRow(index, 'url', e.target.value)}
                    placeholder="https://..."
                    className="w-full glass-input text-sm font-mono"
                  />
                </div>
                {capturePages.length > 1 && (
                  <button
                    onClick={() => removePageRow(index)}
                    className="p-2.5 text-slate-600 hover:text-red-400 hover:bg-white/[0.04] rounded-xl transition-all flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            onClick={addPageRow}
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-emerald-400 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add page
          </button>

          <div className="flex justify-end gap-3 pt-2 border-t border-white/[0.06]">
            <button onClick={() => setShowCaptureModal(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              onClick={handleCaptureScreenshots}
              disabled={capturing}
              className="btn-primary disabled:opacity-50"
            >
              {capturing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              {capturing ? 'Capturing...' : 'Capture'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

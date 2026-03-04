import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ExternalLink, GitBranch, Globe, Pencil, Trash2,
  CheckCircle2, Circle, AlertCircle, Clock, Loader2, MessageSquare,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Project, ProjectTask, Integration, Brief } from '../lib/types';
import StatusBadge from '../components/StatusBadge';
import AgentStatusIndicator from '../components/AgentStatusIndicator';
import PhaseIndicator from '../components/PhaseIndicator';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import { formatDistanceToNow } from 'date-fns';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadProject(id);
  }, [id]);

  async function loadProject(projectId: string) {
    const [projRes, tasksRes, intRes, briefRes] = await Promise.all([
      supabase.from('projects').select('*, clients(name, contact_email)').eq('id', projectId).maybeSingle(),
      supabase.from('project_tasks').select('*').eq('project_id', projectId).order('order_index'),
      supabase.from('integrations').select('*').eq('project_id', projectId).order('created_at'),
      supabase.from('briefs').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).maybeSingle(),
    ]);
    setProject(projRes.data);
    setTasks(tasksRes.data || []);
    setIntegrations(intRes.data || []);
    setBrief(briefRes.data);
    setLoading(false);
  }

  useRealtimeSubscription({
    table: 'project_tasks',
    event: '*',
    filter: id ? `project_id=eq.${id}` : undefined,
    onChange: () => {
      if (id) {
        supabase.from('project_tasks').select('*').eq('project_id', id).order('order_index').then(({ data }) => {
          setTasks(data || []);
        });
      }
    },
    enabled: !!id && !loading,
  });

  useRealtimeSubscription({
    table: 'projects',
    event: 'UPDATE',
    filter: id ? `id=eq.${id}` : undefined,
    onUpdate: (payload) => {
      const updated = payload.new as unknown as Project;
      setProject(prev => prev ? { ...prev, ...updated } : null);
    },
    enabled: !!id && !loading,
  });

  async function handleDelete() {
    if (!confirm('Delete this project and all its data?')) return;
    await supabase.from('projects').delete().eq('id', id!);
    navigate('/projects');
  }

  const taskIcon: Record<string, JSX.Element> = {
    pending: <Circle className="w-4 h-4 text-slate-500" />,
    in_progress: <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />,
    completed: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
    failed: <AlertCircle className="w-4 h-4 text-red-400" />,
    blocked: <AlertCircle className="w-4 h-4 text-rose-400" />,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-slate-400">Project not found</p>
        <Link to="/projects" className="text-emerald-400 text-sm mt-2 inline-block">Back to projects</Link>
      </div>
    );
  }

  const completedTasks = tasks.filter(t => t.status === 'completed').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/projects" className="text-slate-400 hover:text-slate-200 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white truncate">{project.name}</h1>
            <StatusBadge status={project.status} size="md" />
            <AgentStatusIndicator status={project.agent_status} showLabel />
          </div>
          <p className="text-sm text-slate-400 mt-1">
            {project.clients?.name} &middot; {project.type.replace('_', ' ')} &middot; Updated {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            to={`/chat/${project.id}`}
            className="p-2 text-slate-400 hover:text-emerald-400 hover:bg-slate-800/50 rounded-lg transition-all"
            title="Chat with Agent"
          >
            <MessageSquare className="w-4 h-4" />
          </Link>
          <button className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 rounded-lg transition-all">
            <Pencil className="w-4 h-4" />
          </button>
          <button onClick={handleDelete} className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800/50 rounded-lg transition-all">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
        <PhaseIndicator currentPhase={project.current_phase} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Progress</p>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all" style={{ width: `${project.progress}%` }} />
            </div>
            <span className="text-lg font-bold text-white">{project.progress}%</span>
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Tasks</p>
          <p className="text-lg font-bold text-white">{completedTasks} <span className="text-sm font-normal text-slate-500">/ {tasks.length}</span></p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Integrations</p>
          <p className="text-lg font-bold text-white">{integrations.length}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {project.demo_url && (
          <a href={project.demo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg hover:bg-emerald-500/20 transition-colors">
            <ExternalLink className="w-3.5 h-3.5" /> Demo
          </a>
        )}
        {project.production_url && (
          <a href={project.production_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-cyan-400 bg-cyan-500/10 px-3 py-1.5 rounded-lg hover:bg-cyan-500/20 transition-colors">
            <Globe className="w-3.5 h-3.5" /> Production
          </a>
        )}
        {project.git_repo_url && (
          <a href={project.git_repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-slate-400 bg-slate-800/50 px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">
            <GitBranch className="w-3.5 h-3.5" /> Repository
          </a>
        )}
      </div>

      {project.description && (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-2">Description</h2>
          <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{project.description}</p>
        </div>
      )}

      {brief && (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Brief</h2>
            <StatusBadge status={brief.status} />
          </div>
          {brief.original_content && (
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap line-clamp-6">{brief.original_content}</p>
          )}
          {brief.pages_screens.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {brief.pages_screens.map((p, i) => (
                <span key={i} className="text-xs px-2 py-0.5 bg-slate-800 text-slate-400 rounded">{p}</span>
              ))}
            </div>
          )}
          {brief.questions.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-800/40">
              <p className="text-xs font-medium text-slate-400 mb-2">{brief.questions.filter(q => !q.answered).length} unanswered questions</p>
            </div>
          )}
        </div>
      )}

      <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800/40">
          <h2 className="text-sm font-semibold text-white">Tasks ({tasks.length})</h2>
        </div>
        {tasks.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No tasks yet. The agent will create tasks when processing the brief.</div>
        ) : (
          <div className="divide-y divide-slate-800/40">
            {tasks.map(task => (
              <div key={task.id} className="flex items-start gap-3 px-5 py-3.5">
                <div className="mt-0.5">{taskIcon[task.status] || taskIcon.pending}</div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${task.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{task.title}</p>
                  {task.description && <p className="text-xs text-slate-500 mt-0.5 truncate">{task.description}</p>}
                  {task.error_log && <p className="text-xs text-red-400 mt-1 font-mono">{task.error_log}</p>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={task.status} />
                  {task.duration_seconds > 0 && (
                    <span className="text-xs text-slate-600">{Math.round(task.duration_seconds / 60)}m</span>
                  )}
                  {task.completed_at && (
                    <span className="text-xs text-slate-600 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(task.completed_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {integrations.length > 0 && (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
          <div className="px-5 py-4 border-b border-slate-800/40">
            <h2 className="text-sm font-semibold text-white">Integrations</h2>
          </div>
          <div className="divide-y divide-slate-800/40">
            {integrations.map(integ => (
              <div key={integ.id} className="flex items-center justify-between px-5 py-3.5">
                <div>
                  <p className="text-sm font-medium text-slate-200">{integ.service_name}</p>
                  <p className="text-xs text-slate-500 capitalize">{integ.service_type}</p>
                </div>
                <StatusBadge status={integ.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

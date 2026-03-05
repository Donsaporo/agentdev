import { ExternalLink, GitBranch, Globe, ChevronRight, CheckCircle2, Circle, Loader2, AlertCircle } from 'lucide-react';
import type { Project, ProjectTask, Brief } from '../../lib/types';
import PhaseIndicator from '../../components/PhaseIndicator';
import StatusBadge from '../../components/StatusBadge';

interface ChatContextPanelProps {
  project: Project;
  tasks: ProjectTask[];
  brief: Brief | null;
}

const taskIcon: Record<string, JSX.Element> = {
  pending: <Circle className="w-3 h-3 text-slate-500" />,
  in_progress: <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />,
  completed: <CheckCircle2 className="w-3 h-3 text-emerald-400" />,
  failed: <AlertCircle className="w-3 h-3 text-red-400" />,
  blocked: <AlertCircle className="w-3 h-3 text-rose-400" />,
};

export default function ChatContextPanel({ project, tasks, brief }: ChatContextPanelProps) {
  const completedTasks = tasks.filter(t => t.status === 'completed').length;

  return (
    <div className="w-full h-full flex flex-col bg-[#0a0e17]/80 border-l border-white/[0.04] overflow-y-auto">
      <div className="px-4 py-4 border-b border-white/[0.04]">
        <h2 className="text-sm font-semibold text-white truncate">{project.name}</h2>
        <p className="text-xs text-slate-500 mt-0.5">{project.clients?.name}</p>
      </div>

      <div className="p-4 border-b border-white/[0.04]">
        <p className="text-xs text-slate-500 mb-2 font-medium">Phase</p>
        <PhaseIndicator currentPhase={project.current_phase} compact />
      </div>

      <div className="p-4 border-b border-white/[0.04]">
        <p className="text-xs text-slate-500 mb-2 font-medium">Progress</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all"
              style={{ width: `${project.progress}%` }}
            />
          </div>
          <span className="text-sm font-bold text-white">{project.progress}%</span>
        </div>
      </div>

      {brief && (
        <div className="p-4 border-b border-white/[0.04]">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-500 font-medium">Brief</p>
            <StatusBadge status={brief.status} />
          </div>
          <p className="text-xs text-slate-400 line-clamp-3">{brief.original_content}</p>
          {brief.pages_screens.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {brief.pages_screens.slice(0, 5).map((page, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-white/[0.04] text-slate-400 rounded border border-white/[0.06]">
                  {page}
                </span>
              ))}
              {brief.pages_screens.length > 5 && (
                <span className="text-[10px] text-slate-500">+{brief.pages_screens.length - 5}</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="p-4 border-b border-white/[0.04]">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-slate-500 font-medium">Tasks</p>
          <span className="text-xs text-slate-400">{completedTasks}/{tasks.length}</span>
        </div>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {tasks.slice(0, 10).map(task => (
            <div key={task.id} className="flex items-center gap-2">
              {taskIcon[task.status] || taskIcon.pending}
              <span className={`text-xs truncate ${task.status === 'completed' ? 'text-slate-600 line-through' : 'text-slate-300'}`}>
                {task.title}
              </span>
            </div>
          ))}
          {tasks.length > 10 && (
            <p className="text-[10px] text-slate-500 pl-5">+{tasks.length - 10} more</p>
          )}
        </div>
      </div>

      <div className="p-4 space-y-2">
        <p className="text-xs text-slate-500 mb-2 font-medium">Links</p>
        {project.demo_url && (
          <a href={project.demo_url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
            <ExternalLink className="w-3 h-3" />
            <span className="truncate">Demo</span>
            <ChevronRight className="w-3 h-3 ml-auto" />
          </a>
        )}
        {project.production_url && (
          <a href={project.production_url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
            <Globe className="w-3 h-3" />
            <span className="truncate">Production</span>
            <ChevronRight className="w-3 h-3 ml-auto" />
          </a>
        )}
        {project.git_repo_url && (
          <a href={project.git_repo_url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-300 transition-colors">
            <GitBranch className="w-3 h-3" />
            <span className="truncate">Repository</span>
            <ChevronRight className="w-3 h-3 ml-auto" />
          </a>
        )}
        {!project.demo_url && !project.production_url && !project.git_repo_url && (
          <p className="text-xs text-slate-600">No links yet</p>
        )}
      </div>
    </div>
  );
}

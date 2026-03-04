import { Bot } from 'lucide-react';
import type { Project } from '../../lib/types';
import AgentStatusIndicator from '../../components/AgentStatusIndicator';

interface ChatProjectListProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function ChatProjectList({ projects, selectedId, onSelect }: ChatProjectListProps) {
  return (
    <div className="w-full h-full flex flex-col bg-slate-950 border-r border-slate-800/60">
      <div className="px-4 py-4 border-b border-slate-800/40">
        <h2 className="text-sm font-semibold text-white">Projects</h2>
        <p className="text-xs text-slate-500 mt-0.5">{projects.length} active</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="p-6 text-center">
            <Bot className="w-8 h-8 text-slate-700 mx-auto mb-2" />
            <p className="text-xs text-slate-600">No projects yet</p>
          </div>
        ) : (
          <div className="py-1">
            {projects.map(project => (
              <button
                key={project.id}
                onClick={() => onSelect(project.id)}
                className={`w-full text-left px-4 py-3 transition-all ${
                  selectedId === project.id
                    ? 'bg-slate-800/60 border-r-2 border-emerald-500'
                    : 'hover:bg-slate-800/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-200 truncate flex-1">{project.name}</span>
                  <AgentStatusIndicator status={project.agent_status} />
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-slate-500 truncate">{project.clients?.name}</span>
                  <span className="text-xs text-slate-600">{project.progress}%</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

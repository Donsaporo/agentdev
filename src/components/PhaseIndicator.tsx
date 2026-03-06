import { Check, Search, Blocks, Code2, MonitorCheck, Rocket, Database, CheckCircle2 } from 'lucide-react';
import type { ProjectPhase } from '../lib/types';

const phases: { key: ProjectPhase; label: string; icon: typeof Search }[] = [
  { key: 'analysis', label: 'Analysis', icon: Search },
  { key: 'scaffolding', label: 'Scaffold', icon: Blocks },
  { key: 'backend_setup', label: 'Backend', icon: Database },
  { key: 'development', label: 'Develop', icon: Code2 },
  { key: 'completeness_check', label: 'Verify', icon: CheckCircle2 },
  { key: 'qa', label: 'QA', icon: MonitorCheck },
  { key: 'deployment', label: 'Deploy', icon: Rocket },
];

interface PhaseIndicatorProps {
  currentPhase: ProjectPhase;
  compact?: boolean;
}

export default function PhaseIndicator({ currentPhase, compact = false }: PhaseIndicatorProps) {
  const currentIdx = phases.findIndex(p => p.key === currentPhase);

  return (
    <div className="flex items-center gap-1">
      {phases.map((phase, i) => {
        const isCompleted = i < currentIdx;
        const isCurrent = i === currentIdx;
        const Icon = phase.icon;

        return (
          <div key={phase.key} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={`
                  flex items-center justify-center rounded-xl transition-all
                  ${compact ? 'w-7 h-7' : 'w-9 h-9'}
                  ${isCompleted ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20' : ''}
                  ${isCurrent ? 'bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30 shadow-lg shadow-cyan-500/10' : ''}
                  ${!isCompleted && !isCurrent ? 'bg-white/[0.03] text-slate-600' : ''}
                `}
              >
                {isCompleted ? (
                  <Check className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                ) : (
                  <Icon className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                )}
              </div>
              {!compact && (
                <span className={`text-[10px] mt-1.5 font-semibold ${
                  isCompleted ? 'text-emerald-400/80' : isCurrent ? 'text-cyan-400' : 'text-slate-600'
                }`}>
                  {phase.label}
                </span>
              )}
            </div>
            {i < phases.length - 1 && (
              <div className={`${compact ? 'w-3' : 'w-6'} h-px mx-0.5 transition-colors ${
                i < currentIdx ? 'bg-emerald-500/40' : 'bg-white/[0.06]'
              }`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

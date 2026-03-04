import type { AgentStatus } from '../lib/types';

interface AgentStatusIndicatorProps {
  status: AgentStatus;
  showLabel?: boolean;
  size?: 'sm' | 'md';
}

const statusConfig: Record<AgentStatus, { color: string; pulse: boolean; label: string }> = {
  idle: { color: 'bg-slate-500', pulse: false, label: 'Idle' },
  working: { color: 'bg-emerald-500', pulse: true, label: 'Working' },
  waiting: { color: 'bg-amber-500', pulse: true, label: 'Waiting' },
  error: { color: 'bg-red-500', pulse: false, label: 'Error' },
};

export default function AgentStatusIndicator({ status, showLabel = false, size = 'sm' }: AgentStatusIndicatorProps) {
  const config = statusConfig[status] || statusConfig.idle;
  const dotSize = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  const pulseSize = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex">
        <span className={`${dotSize} rounded-full ${config.color}`} />
        {config.pulse && (
          <span className={`absolute inset-0 ${pulseSize} rounded-full ${config.color} animate-ping opacity-40`} />
        )}
      </span>
      {showLabel && (
        <span className={`${size === 'sm' ? 'text-xs' : 'text-sm'} text-slate-400 font-medium`}>
          {config.label}
        </span>
      )}
    </span>
  );
}

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const statusStyles: Record<string, string> = {
  draft: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  planning: 'bg-cyan-500/10 text-cyan-400 ring-cyan-500/20',
  in_progress: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
  qa: 'bg-orange-500/10 text-orange-400 ring-orange-500/20',
  review: 'bg-blue-500/10 text-blue-400 ring-blue-500/20',
  approved: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  deployed: 'bg-green-500/10 text-green-400 ring-green-500/20',
  pending: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  pending_review: 'bg-cyan-500/10 text-cyan-400 ring-cyan-500/20',
  questions_pending: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
  processing: 'bg-blue-500/10 text-blue-400 ring-blue-500/20',
  completed: 'bg-green-500/10 text-green-400 ring-green-500/20',
  failed: 'bg-red-500/10 text-red-400 ring-red-500/20',
  blocked: 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
  configured: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  active: 'bg-green-500/10 text-green-400 ring-green-500/20',
  error: 'bg-red-500/10 text-red-400 ring-red-500/20',
  verified: 'bg-green-500/10 text-green-400 ring-green-500/20',
  rejected: 'bg-red-500/10 text-red-400 ring-red-500/20',
};

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const style = statusStyles[status] || statusStyles.draft;
  const label = status.replace(/_/g, ' ');

  return (
    <span className={`
      inline-flex items-center capitalize ring-1 font-semibold tracking-wide
      ${size === 'sm' ? 'text-[11px] px-2 py-0.5 rounded-md' : 'text-xs px-2.5 py-1 rounded-lg'}
      ${style}
    `}>
      {label}
    </span>
  );
}

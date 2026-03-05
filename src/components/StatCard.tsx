import type { LucideIcon } from 'lucide-react';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  trend?: string;
  color: 'emerald' | 'cyan' | 'amber' | 'rose';
}

const colorMap = {
  emerald: {
    bg: 'bg-emerald-500/10',
    icon: 'text-emerald-400',
    ring: 'ring-emerald-500/20',
  },
  cyan: {
    bg: 'bg-cyan-500/10',
    icon: 'text-cyan-400',
    ring: 'ring-cyan-500/20',
  },
  amber: {
    bg: 'bg-amber-500/10',
    icon: 'text-amber-400',
    ring: 'ring-amber-500/20',
  },
  rose: {
    bg: 'bg-rose-500/10',
    icon: 'text-rose-400',
    ring: 'ring-rose-500/20',
  },
};

export default function StatCard({ label, value, icon: Icon, trend, color }: StatCardProps) {
  const c = colorMap[color];

  return (
    <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5 hover:border-slate-700/60 glow-emerald-hover transition-all duration-300">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400">{label}</p>
          <p className="text-2xl font-bold text-white mt-1">{value}</p>
          {trend && <p className="text-xs text-slate-500 mt-1">{trend}</p>}
        </div>
        <div className={`w-10 h-10 rounded-lg ${c.bg} ring-1 ${c.ring} flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${c.icon}`} />
        </div>
      </div>
    </div>
  );
}

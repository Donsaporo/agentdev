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
    bg: 'from-emerald-500/10 to-emerald-500/5',
    icon: 'text-emerald-400',
    iconBg: 'bg-emerald-500/10',
    ring: 'ring-emerald-500/10',
    glow: 'shadow-emerald-500/5',
  },
  cyan: {
    bg: 'from-teal-500/10 to-teal-500/5',
    icon: 'text-teal-400',
    iconBg: 'bg-teal-500/10',
    ring: 'ring-teal-500/10',
    glow: 'shadow-teal-500/5',
  },
  amber: {
    bg: 'from-amber-500/10 to-amber-500/5',
    icon: 'text-amber-400',
    iconBg: 'bg-amber-500/10',
    ring: 'ring-amber-500/10',
    glow: 'shadow-amber-500/5',
  },
  rose: {
    bg: 'from-rose-500/10 to-rose-500/5',
    icon: 'text-rose-400',
    iconBg: 'bg-rose-500/10',
    ring: 'ring-rose-500/10',
    glow: 'shadow-rose-500/5',
  },
};

export default function StatCard({ label, value, icon: Icon, trend, color }: StatCardProps) {
  const c = colorMap[color];

  return (
    <div className={`glass-card-hover p-5 bg-gradient-to-br ${c.bg}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[13px] text-slate-400 font-medium">{label}</p>
          <p className="text-2xl font-bold text-white mt-1.5 tracking-tight">{value}</p>
          {trend && <p className="text-xs text-slate-500 mt-1">{trend}</p>}
        </div>
        <div className={`w-10 h-10 rounded-xl ${c.iconBg} ring-1 ${c.ring} flex items-center justify-center shadow-lg ${c.glow}`}>
          <Icon className={`w-5 h-5 ${c.icon}`} />
        </div>
      </div>
    </div>
  );
}

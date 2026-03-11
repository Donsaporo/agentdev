import { Phone, Trash2, RefreshCw, CheckCircle2, AlertCircle, Clock, Loader2, Signal } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { WhatsAppBusinessAccount } from '../../lib/types';

interface WhatsAppAccountCardProps {
  account: WhatsAppBusinessAccount;
  onDelete: (id: string) => void;
  deleting: boolean;
}

const qualityColors: Record<string, string> = {
  GREEN: 'text-emerald-400 bg-emerald-500/10',
  YELLOW: 'text-amber-400 bg-amber-500/10',
  RED: 'text-red-400 bg-red-500/10',
  unknown: 'text-slate-400 bg-white/[0.04]',
};

const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  connected: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  disconnected: { icon: AlertCircle, color: 'text-slate-400', bg: 'bg-white/[0.04]' },
  error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
  pending: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10' },
};

export default function WhatsAppAccountCard({ account, onDelete, deleting }: WhatsAppAccountCardProps) {
  const status = statusConfig[account.status] || statusConfig.pending;
  const StatusIcon = status.icon;
  const quality = qualityColors[account.quality_rating] || qualityColors.unknown;

  return (
    <div className="glass-card-hover p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div className={`w-12 h-12 rounded-xl ${status.bg} flex items-center justify-center flex-shrink-0`}>
            <Phone className={`w-6 h-6 ${status.color}`} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h3 className="text-base font-semibold text-white truncate">
                {account.display_phone_number || 'Pending number'}
              </h3>
              <StatusIcon className={`w-4 h-4 ${status.color} flex-shrink-0`} />
            </div>
            {account.verified_name && (
              <p className="text-sm text-slate-400 mt-0.5 truncate">{account.verified_name}</p>
            )}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {account.quality_rating !== 'unknown' && (
                <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-md ${quality}`}>
                  <Signal className="w-3 h-3" />
                  Quality: {account.quality_rating}
                </span>
              )}
              <span className="text-xs text-slate-500">
                WABA: <span className="font-mono text-slate-400">{account.waba_id || '---'}</span>
              </span>
              <span className="text-xs text-slate-500">
                Phone ID: <span className="font-mono text-slate-400">{account.phone_number_id || '---'}</span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onDelete(account.id)}
            disabled={deleting}
            className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
            title="Remove account"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {account.status_message && (
        <div className="mt-3 text-xs text-slate-500 bg-white/[0.02] px-3 py-2 rounded-lg">
          {account.status_message}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-white/[0.04] flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {account.connected_at
            ? `Connected ${formatDistanceToNow(new Date(account.connected_at), { addSuffix: true })}`
            : 'Not yet connected'
          }
        </span>
        <span className="text-xs text-slate-600 font-mono">
          App: {account.meta_app_id}
        </span>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Monitor, Tablet, Smartphone, Check, X, Eye, MessageSquare } from 'lucide-react';
import type { QAScreenshot } from '../../lib/types';
import StatusBadge from '../../components/StatusBadge';

interface QAScreenshotCardProps {
  screenshot: QAScreenshot;
  onApprove: (id: string) => void;
  onReject: (id: string, notes: string) => void;
  onPreview: (url: string) => void;
}

export default function QAScreenshotCard({ screenshot, onApprove, onReject, onPreview }: QAScreenshotCardProps) {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectionNotes, setRejectionNotes] = useState('');

  function handleReject() {
    if (!rejectionNotes.trim()) return;
    onReject(screenshot.id, rejectionNotes);
    setShowRejectForm(false);
    setRejectionNotes('');
  }

  const devices = [
    { key: 'desktop', url: screenshot.desktop_url, icon: Monitor, label: 'Desktop' },
    { key: 'tablet', url: screenshot.tablet_url, icon: Tablet, label: 'Tablet' },
    { key: 'mobile', url: screenshot.mobile_url, icon: Smartphone, label: 'Mobile' },
  ];

  return (
    <div className="glass-card overflow-hidden group">
      <div className="p-4 border-b border-white/[0.04]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">{screenshot.page_name}</h3>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{screenshot.page_url}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-600 bg-white/[0.04] px-1.5 py-0.5 rounded font-mono">
              v{screenshot.version_number}
            </span>
            <StatusBadge status={screenshot.status} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-white/[0.02]">
        {devices.map(device => (
          <div key={device.key} className="bg-[#0a0e17] p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <device.icon className="w-3 h-3 text-slate-500" />
              <span className="text-[10px] text-slate-500 font-medium">{device.label}</span>
            </div>
            {device.url ? (
              <button
                onClick={() => onPreview(device.url)}
                className="group/img relative w-full aspect-[4/3] bg-white/[0.02] rounded-xl overflow-hidden border border-white/[0.06] hover:border-emerald-500/30 transition-all"
              >
                <img
                  src={device.url}
                  alt={`${screenshot.page_name} - ${device.label}`}
                  className="w-full h-full object-cover object-top"
                />
                <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/40 transition-all flex items-center justify-center">
                  <Eye className="w-5 h-5 text-white opacity-0 group-hover/img:opacity-100 transition-opacity" />
                </div>
              </button>
            ) : (
              <div className="w-full aspect-[4/3] bg-white/[0.02] rounded-xl border border-white/[0.04] flex items-center justify-center">
                <span className="text-[10px] text-slate-600">No capture</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {screenshot.status === 'rejected' && screenshot.rejection_notes && (
        <div className="px-4 py-3 bg-red-500/[0.04] border-t border-red-500/10">
          <div className="flex items-start gap-2">
            <MessageSquare className="w-3 h-3 text-red-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-400">{screenshot.rejection_notes}</p>
          </div>
        </div>
      )}

      {screenshot.status === 'pending' && (
        <div className="p-3 border-t border-white/[0.04]">
          {showRejectForm ? (
            <div className="space-y-2">
              <textarea
                value={rejectionNotes}
                onChange={e => setRejectionNotes(e.target.value)}
                placeholder="Describe what needs to be fixed..."
                rows={2}
                className="w-full glass-input text-xs resize-none"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleReject}
                  disabled={!rejectionNotes.trim()}
                  className="px-3 py-1.5 bg-amber-500/15 text-amber-400 text-xs font-semibold rounded-lg hover:bg-amber-500/25 transition-colors disabled:opacity-40"
                >
                  Submit Fix Request
                </button>
                <button
                  onClick={() => { setShowRejectForm(false); setRejectionNotes(''); }}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onApprove(screenshot.id)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-500/10 text-emerald-400 text-xs font-semibold rounded-xl hover:bg-emerald-500/20 transition-colors"
              >
                <Check className="w-3.5 h-3.5" /> Approve
              </button>
              <button
                onClick={() => setShowRejectForm(true)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-amber-500/10 text-amber-400 text-xs font-semibold rounded-xl hover:bg-amber-500/20 transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Request Fix
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useEffect } from 'react';
import { Send, ChevronDown, Paperclip, X, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface ChatInputProps {
  onSend: (content: string, attachmentUrls?: string[]) => void;
  disabled: boolean;
  placeholder?: string;
}

const quickCommands = [
  { label: '/status', description: 'Check project status' },
  { label: '/deploy', description: 'Deploy to demo' },
  { label: '/screenshot', description: 'Take QA screenshots' },
  { label: '/fix', description: 'Fix last reported issue' },
];

export default function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [value]);

  function handleSubmit() {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;

    const urls = attachments.map(a => a.url);
    const content = urls.length > 0
      ? `${trimmed}\n\n[Attached files: ${attachments.map(a => a.name).join(', ')}]`
      : trimmed;

    onSend(content, urls.length > 0 ? urls : undefined);
    setValue('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleCommand(cmd: string) {
    onSend(cmd);
    setShowCommands(false);
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    for (const file of Array.from(files)) {
      const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const path = `chat-attachments/${safeName}`;

      const { error } = await supabase.storage
        .from('brief-attachments')
        .upload(path, file, { upsert: true });

      if (!error) {
        const { data: urlData } = supabase.storage
          .from('brief-attachments')
          .getPublicUrl(path);
        setAttachments(prev => [...prev, { name: file.name, url: urlData.publicUrl }]);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeAttachment(index: number) {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="border-t border-white/[0.04] bg-[#0a0e17]/80 backdrop-blur-sm p-3">
      {showCommands && (
        <div className="mb-2 glass-card overflow-hidden">
          {quickCommands.map(cmd => (
            <button
              key={cmd.label}
              onClick={() => handleCommand(cmd.label)}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.04] transition-colors text-left"
            >
              <span className="text-sm font-mono text-emerald-400">{cmd.label}</span>
              <span className="text-xs text-slate-500">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((att, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 bg-white/[0.04] text-slate-300 text-xs px-2.5 py-1 rounded-lg border border-white/[0.06]">
              <Paperclip className="w-3 h-3 text-slate-500" />
              {att.name}
              <button onClick={() => removeAttachment(i)} className="text-slate-500 hover:text-red-400 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          onClick={() => setShowCommands(!showCommands)}
          className="p-2 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0 mb-0.5"
          title="Quick commands"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${showCommands ? 'rotate-180' : ''}`} />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="p-2 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0 mb-0.5 disabled:opacity-40"
          title="Attach file"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          accept="image/*,.pdf,.doc,.docx,.xlsx,.xls,.csv,.txt,.json"
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Message the agent...'}
          disabled={disabled}
          rows={1}
          className="flex-1 glass-input resize-none text-sm"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className="p-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 rounded-xl text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0 mb-0.5 shadow-lg shadow-emerald-500/20"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

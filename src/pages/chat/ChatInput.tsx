import { useState, useRef, useEffect } from 'react';
import { Send, ChevronDown } from 'lucide-react';

interface ChatInputProps {
  onSend: (content: string) => void;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [value]);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
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

  return (
    <div className="border-t border-slate-800/60 bg-slate-950/80 backdrop-blur-sm p-3">
      {showCommands && (
        <div className="mb-2 bg-slate-900 border border-slate-800/60 rounded-lg overflow-hidden">
          {quickCommands.map(cmd => (
            <button
              key={cmd.label}
              onClick={() => handleCommand(cmd.label)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-800/50 transition-colors text-left"
            >
              <span className="text-sm font-mono text-emerald-400">{cmd.label}</span>
              <span className="text-xs text-slate-500">{cmd.description}</span>
            </button>
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
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Message the agent...'}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-slate-800/60 border border-slate-700/40 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 resize-none transition-all disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="p-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 rounded-xl text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0 mb-0.5"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

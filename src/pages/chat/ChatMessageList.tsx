import { useEffect, useRef } from 'react';
import { Bot, User, Terminal } from 'lucide-react';
import type { AgentMessage } from '../../lib/types';
import { formatDistanceToNow } from 'date-fns';

interface ChatMessageListProps {
  messages: AgentMessage[];
  isAgentWorking: boolean;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="my-2 rounded-xl overflow-hidden bg-[#0a0e17] border border-white/[0.06]">
      {language && (
        <div className="px-3 py-1.5 bg-white/[0.03] border-b border-white/[0.04] text-[11px] text-slate-500 font-mono">
          {language}
        </div>
      )}
      <pre className="p-3 text-xs text-slate-300 overflow-x-auto font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function parseContent(content: string) {
  const parts: { type: 'text' | 'code'; content: string; language?: string }[] = [];
  const codeRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', content: match[2], language: match[1] || undefined });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return parts;
}

export default function ChatMessageList({ messages, isAgentWorking }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const roleConfig = {
    user: {
      icon: User,
      align: 'justify-end' as const,
      bubble: 'bg-emerald-500/[0.08] border-emerald-500/15 text-slate-200',
      iconBg: 'bg-emerald-500/15 text-emerald-400',
    },
    assistant: {
      icon: Bot,
      align: 'justify-start' as const,
      bubble: 'bg-white/[0.03] border-white/[0.06] text-slate-300',
      iconBg: 'bg-cyan-500/15 text-cyan-400',
    },
    system: {
      icon: Terminal,
      align: 'justify-center' as const,
      bubble: 'bg-white/[0.02] border-white/[0.04] text-slate-500 italic',
      iconBg: 'bg-white/[0.04] text-slate-500',
    },
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center mb-4 ring-1 ring-emerald-500/10">
            <Bot className="w-8 h-8 text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-1">Start a conversation</h3>
          <p className="text-sm text-slate-500 max-w-sm">
            Select a project and send a message to begin. The agent can help with development, deployment, and QA tasks.
          </p>
        </div>
      )}

      {messages.map(message => {
        const config = roleConfig[message.role];
        const parts = parseContent(message.content);

        if (message.role === 'system') {
          return (
            <div key={message.id} className="flex justify-center">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/[0.02] border border-white/[0.04] rounded-full">
                <Terminal className="w-3 h-3 text-slate-500" />
                <span className="text-xs text-slate-500">{message.content}</span>
              </div>
            </div>
          );
        }

        return (
          <div key={message.id} className={`flex ${config.align} gap-2`}>
            {message.role === 'assistant' && (
              <div className={`w-7 h-7 rounded-xl ${config.iconBg} flex items-center justify-center flex-shrink-0 mt-1`}>
                <config.icon className="w-3.5 h-3.5" />
              </div>
            )}
            <div className={`max-w-[75%] border rounded-2xl px-4 py-3 ${config.bubble}`}>
              {parts.map((part, i) =>
                part.type === 'code' ? (
                  <CodeBlock key={i} code={part.content} language={part.language} />
                ) : (
                  <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">{part.content.trim()}</p>
                ),
              )}
              <p className="text-[10px] text-slate-600 mt-1.5">
                {formatDistanceToNow(new Date(message.created_at), { addSuffix: true })}
              </p>
            </div>
            {message.role === 'user' && (
              <div className={`w-7 h-7 rounded-xl ${config.iconBg} flex items-center justify-center flex-shrink-0 mt-1`}>
                <config.icon className="w-3.5 h-3.5" />
              </div>
            )}
          </div>
        );
      })}

      {isAgentWorking && (
        <div className="flex justify-start gap-2">
          <div className="w-7 h-7 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center flex-shrink-0 mt-1">
            <Bot className="w-3.5 h-3.5" />
          </div>
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl px-4 py-3">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

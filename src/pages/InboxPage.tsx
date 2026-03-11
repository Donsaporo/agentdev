import { useState, useCallback } from 'react';
import { MessageCircle, Loader2, MessageSquareQuote } from 'lucide-react';
import { useInboxData } from './inbox/useInboxData';
import ConversationList from './inbox/ConversationList';
import ChatPanel from './inbox/ChatPanel';
import ContactPanel from './inbox/ContactPanel';
import FeedbackModal from './inbox/FeedbackModal';

export default function InboxPage() {
  const { conversations, personas, loading, markAsRead, getContact } = useInboxData();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [showContact, setShowContact] = useState(false);
  const [feedbackMessageId, setFeedbackMessageId] = useState<string | null>(null);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const activeContact = activeConversation ? getContact(activeConversation.contact_id) : undefined;

  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversationId(id);
      markAsRead(id);
    },
    [markAsRead]
  );

  const handleBack = useCallback(() => {
    setActiveConversationId(null);
    setShowContact(false);
  }, []);

  const handleFeedback = useCallback((messageId: string) => {
    setFeedbackMessageId(messageId);
  }, []);

  if (loading) {
    return (
      <div className="fixed inset-0 lg:left-[260px] flex items-center justify-center bg-[#0a0e17] z-10">
        <Loader2 className="w-6 h-6 text-emerald-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 lg:left-[260px] flex bg-[#0a0e17] z-10">
      <div
        className={`w-full lg:w-[340px] xl:w-[380px] flex-shrink-0 border-r border-white/[0.04] bg-[#0d1117]/60 ${
          activeConversationId ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'
        }`}
      >
        <ConversationList
          conversations={conversations}
          activeId={activeConversationId}
          onSelect={handleSelectConversation}
        />
      </div>

      <div
        className={`flex-1 min-w-0 ${
          activeConversationId ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
        }`}
      >
        {activeConversation ? (
          <ChatPanel
            conversation={activeConversation}
            contact={activeContact}
            onBack={handleBack}
            onToggleContact={() => setShowContact(!showContact)}
            onFeedback={handleFeedback}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <div className="w-20 h-20 rounded-3xl bg-emerald-500/[0.07] flex items-center justify-center mb-6">
              <MessageCircle className="w-10 h-10 text-emerald-500/50" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">Bandeja de WhatsApp</h3>
            <p className="text-sm text-slate-500 max-w-sm">
              Selecciona una conversacion para ver los mensajes, responder manualmente, o gestionar el agente IA asignado.
            </p>
            <div className="flex items-center gap-4 mt-8 text-xs text-slate-600">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                IA Activa
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                Control Manual
              </div>
              <div className="flex items-center gap-1.5">
                <MessageSquareQuote className="w-3 h-3" />
                Feedback
              </div>
            </div>
          </div>
        )}
      </div>

      {showContact && activeConversation && (
        <div className="hidden lg:flex lg:flex-col w-[320px] xl:w-[340px] flex-shrink-0 border-l border-white/[0.04] bg-[#0d1117]/60">
          <ContactPanel
            conversation={activeConversation}
            contact={activeContact}
            personas={personas}
            onClose={() => setShowContact(false)}
          />
        </div>
      )}

      {feedbackMessageId && (
        <FeedbackModal
          messageId={feedbackMessageId}
          conversationId={activeConversationId}
          onClose={() => setFeedbackMessageId(null)}
        />
      )}
    </div>
  );
}

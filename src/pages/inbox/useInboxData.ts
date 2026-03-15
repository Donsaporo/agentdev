import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import type {
  WhatsAppConversation,
  WhatsAppMessage,
  WhatsAppContact,
  SalesAgentPersona,
} from '../../lib/types';

export function useInboxData() {
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [personas, setPersonas] = useState<SalesAgentPersona[]>([]);
  const [loading, setLoading] = useState(true);
  const contactCache = useRef<Record<string, WhatsAppContact>>({});
  const personaCache = useRef<Record<string, SalesAgentPersona>>({});

  const loadConversations = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('whatsapp_conversations')
        .select('*, contact:whatsapp_contacts(*)')
        .in('status', ['active', 'closed'])
        .order('last_message_at', { ascending: false });

      if (error) {
        console.error('Failed to load conversations:', error);
      } else if (data) {
        const enriched = data.map((c: WhatsAppConversation & { contact: WhatsAppContact }) => {
          if (c.contact) contactCache.current[c.contact_id] = c.contact;
          const persona = c.agent_persona_id ? personaCache.current[c.agent_persona_id] : undefined;
          return { ...c, persona };
        });
        setConversations(enriched);
      }
    } catch (e) {
      console.error('Failed to load conversations:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPersonas = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('sales_agent_personas')
        .select('*')
        .eq('is_active', true);

      if (error) {
        console.error('Failed to load personas:', error);
        return;
      }
      if (data) {
        setPersonas(data);
        data.forEach((p: SalesAgentPersona) => {
          personaCache.current[p.id] = p;
        });
      }
    } catch (e) {
      console.error('Failed to load personas:', e);
    }
  }, []);

  useEffect(() => {
    async function init() {
      try {
        await loadPersonas();
      } catch (e) {
        console.error('Failed to load personas:', e);
      }
      try {
        await loadConversations();
      } catch (e) {
        console.error('Failed to load conversations:', e);
        setLoading(false);
      }
    }
    init();
  }, [loadPersonas, loadConversations]);

  useEffect(() => {
    const channel = supabase
      .channel('inbox-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' },
        (payload) => {
          const msg = payload.new as WhatsAppMessage;
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === msg.conversation_id);
            if (idx === -1) {
              loadConversations();
              return prev;
            }
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              last_message_at: msg.created_at,
              last_message_preview: (msg.content || '').slice(0, 80),
              unread_count:
                msg.direction === 'inbound'
                  ? updated[idx].unread_count + 1
                  : updated[idx].unread_count,
            };
            updated.sort(
              (a, b) =>
                new Date(b.last_message_at).getTime() -
                new Date(a.last_message_at).getTime()
            );
            return updated;
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'whatsapp_conversations' },
        (payload) => {
          const updated = payload.new as WhatsAppConversation;
          if (updated.status === 'archived') {
            setConversations((prev) => prev.filter((c) => c.id !== updated.id));
            return;
          }
          setConversations((prev) =>
            prev.map((c) =>
              c.id === updated.id ? { ...c, ...updated, contact: c.contact, persona: c.persona } : c
            )
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_conversations' },
        () => {
          loadConversations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadConversations]);

  const markAsRead = useCallback(async (conversationId: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, unread_count: 0 } : c))
    );
    await supabase
      .from('whatsapp_conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId);
  }, []);

  const getContact = useCallback(
    (contactId: string) => contactCache.current[contactId],
    []
  );

  return {
    conversations,
    personas,
    loading,
    markAsRead,
    getContact,
    refreshConversations: loadConversations,
  };
}

export function useConversationMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }

    let aborted = false;
    setLoading(true);
    setMessages([]);

    const pendingQueue: WhatsAppMessage[] = [];
    let initialLoadDone = false;

    const channelId = `messages-${conversationId}-${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'whatsapp_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (aborted) return;
          const msg = payload.new as WhatsAppMessage;
          if (!initialLoadDone) {
            pendingQueue.push(msg);
            return;
          }
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'whatsapp_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (aborted) return;
          const updated = payload.new as WhatsAppMessage;
          setMessages((prev) =>
            prev.map((m) => (m.id === updated.id ? updated : m))
          );
        }
      )
      .subscribe();

    supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (aborted) return;
        if (error) {
          console.error('Failed to load messages:', error);
          setLoading(false);
          return;
        }
        const loaded = data || [];
        const loadedIds = new Set(loaded.map((m) => m.id));
        const newFromQueue = pendingQueue.filter((m) => !loadedIds.has(m.id));
        setMessages([...loaded, ...newFromQueue]);
        initialLoadDone = true;
        setLoading(false);
      });

    return () => {
      aborted = true;
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  return { messages, loading };
}

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { AgentConfig } from '../lib/types';

export function useAgentConfig() {
  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfigs();
  }, []);

  async function loadConfigs() {
    const { data } = await supabase.from('agent_config').select('*').order('key');
    setConfigs(data || []);
    setLoading(false);
  }

  const getValue = useCallback(
    (key: string, fallback?: unknown) => {
      const found = configs.find(c => c.key === key);
      return found ? found.value : fallback;
    },
    [configs],
  );

  async function setValue(key: string, value: unknown) {
    const { error } = await supabase
      .from('agent_config')
      .upsert({ key, value: JSON.parse(JSON.stringify(value)), updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (!error) {
      setConfigs(prev => {
        const idx = prev.findIndex(c => c.key === key);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], value, updated_at: new Date().toISOString() };
          return updated;
        }
        return [...prev, { id: '', key, value, updated_at: new Date().toISOString() }];
      });
    }
    return { error };
  }

  return { configs, loading, getValue, setValue, reload: loadConfigs };
}

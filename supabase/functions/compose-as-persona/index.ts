import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { text, persona_id, conversation_id } = await req.json();

    if (!text || (!persona_id && !conversation_id)) {
      return new Response(
        JSON.stringify({ error: "text and (persona_id or conversation_id) required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let personaData;

    if (persona_id) {
      const { data } = await supabase
        .from("sales_agent_personas")
        .select("full_name, first_name, communication_style, personality_traits, formality_level, emoji_usage")
        .eq("id", persona_id)
        .maybeSingle();
      personaData = data;
    } else if (conversation_id) {
      const { data: conv } = await supabase
        .from("whatsapp_conversations")
        .select("agent_persona_id")
        .eq("id", conversation_id)
        .maybeSingle();

      if (conv?.agent_persona_id) {
        const { data } = await supabase
          .from("sales_agent_personas")
          .select("full_name, first_name, communication_style, personality_traits, formality_level, emoji_usage")
          .eq("id", conv.agent_persona_id)
          .maybeSingle();
        personaData = data;
      }
    }

    if (!personaData) {
      return new Response(
        JSON.stringify({ transformed: text, persona: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const openaiKey = Deno.env.get("OPENAI_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (!openaiKey && !anthropicKey) {
      return new Response(
        JSON.stringify({ transformed: text, persona: personaData.full_name }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const systemPrompt = `Eres un transformador de mensajes. Tu trabajo es tomar un mensaje informal del director de ventas y reescribirlo con el tono y estilo de ${personaData.full_name}.

Estilo de comunicacion: ${personaData.communication_style || "profesional y amigable"}
Rasgos: ${Array.isArray(personaData.personality_traits) ? personaData.personality_traits.join(", ") : "profesional"}
Formalidad: ${personaData.formality_level || "professional_friendly"}
Emojis: ${personaData.emoji_usage || "minimal"}

Reglas:
- Mantiene el SIGNIFICADO exacto del mensaje original
- Adapta SOLO el tono y estilo al de ${personaData.first_name}
- Formato WhatsApp: corto, natural, sin markdown
- 1-3 oraciones maximo
- Si el mensaje original ya es adecuado, mejoralo minimamente
- Responde SOLO con el texto transformado, nada mas`;

    let transformed = text;

    if (openaiKey) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 300,
          temperature: 0.6,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
        }),
      });

      if (res.ok) {
        const aiResponse = await res.json();
        transformed = aiResponse.choices?.[0]?.message?.content?.trim() || text;
      } else {
        console.error("OpenAI API error:", await res.text());
      }
    } else if (anthropicKey) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          temperature: 0.6,
          system: systemPrompt,
          messages: [{ role: "user", content: text }],
        }),
      });

      if (res.ok) {
        const aiResponse = await res.json();
        transformed = aiResponse.content?.[0]?.text?.trim() || text;
      } else {
        console.error("Claude API error:", await res.text());
      }
    }

    return new Response(
      JSON.stringify({
        transformed,
        original: text,
        persona: personaData.full_name,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("compose-as-persona error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

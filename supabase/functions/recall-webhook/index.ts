import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RECALL_API_BASE = "https://api.recall.ai/api/v1";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const webhookSecret = Deno.env.get("RECALL_WEBHOOK_SECRET") || "";
    const recallApiKey = Deno.env.get("RECALL_API_KEY") || "";

    const signature = req.headers.get("x-recall-signature") || "";

    if (webhookSecret && signature) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );

      const body = await req.clone().arrayBuffer();
      const sigBytes = Uint8Array.from(
        atob(signature),
        (c) => c.charCodeAt(0)
      );

      const valid = await crypto.subtle.verify("HMAC", key, sigBytes, body);
      if (!valid) {
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const payload = await req.json();
    const eventType = payload.event || payload.data?.event;
    const botId = payload.data?.bot_id || payload.bot_id;

    if (!botId) {
      return new Response(JSON.stringify({ ok: true, skipped: "no bot_id" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (
      eventType === "bot.status_change" ||
      eventType === "bot.transcription_complete" ||
      eventType === "bot.done"
    ) {
      const statusCode =
        payload.data?.status?.code || payload.status?.code || "";

      if (statusCode === "done" || eventType === "bot.done" || eventType === "bot.transcription_complete") {
        let transcript = "";

        if (recallApiKey) {
          const transcriptRes = await fetch(
            `${RECALL_API_BASE}/bot/${botId}/transcript`,
            {
              headers: {
                Authorization: `Token ${recallApiKey}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (transcriptRes.ok) {
            const segments: Array<{
              speaker: string;
              words: Array<{ text: string }>;
            }> = await transcriptRes.json();

            transcript = segments
              .map((seg) => {
                const text = seg.words.map((w) => w.text).join(" ");
                return `${seg.speaker}: ${text}`;
              })
              .join("\n");
          }
        }

        await supabase
          .from("sales_meetings")
          .update({
            status: "completed",
            transcript: transcript || null,
            updated_at: new Date().toISOString(),
          })
          .eq("recall_bot_id", botId);
      } else if (statusCode === "joining_call" || statusCode === "in_call") {
        await supabase
          .from("sales_meetings")
          .update({
            status: "in_progress",
            updated_at: new Date().toISOString(),
          })
          .eq("recall_bot_id", botId);
      } else if (statusCode === "fatal" || statusCode === "error") {
        await supabase
          .from("sales_meetings")
          .update({
            status: "error",
            updated_at: new Date().toISOString(),
          })
          .eq("recall_bot_id", botId);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

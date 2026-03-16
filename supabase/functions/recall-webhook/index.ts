import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RECALL_API_BASE = "https://api.recall.ai/api/v1";

async function forwardTranscriptToCrm(
  supabase: ReturnType<typeof createClient>,
  botId: string,
  transcript: string
) {
  const { data: meeting } = await supabase
    .from("sales_meetings")
    .select("id, contact_id, conversation_id, title, start_time, end_time, google_event_id")
    .eq("recall_bot_id", botId)
    .maybeSingle();

  if (!meeting) {
    console.error("No meeting found for bot:", botId);
    return;
  }

  const crmUrl = Deno.env.get("CRM_SUPABASE_URL");
  const crmKey = Deno.env.get("CRM_SUPABASE_SERVICE_ROLE_KEY");

  if (!crmUrl || !crmKey) {
    console.warn("CRM not configured, skipping transcript forwarding");
    return;
  }

  try {
    const { data: contactData } = await supabase
      .from("whatsapp_contacts")
      .select("email, display_name")
      .eq("id", meeting.contact_id)
      .maybeSingle();

    const attendees = ["info@obzide.com"];
    if (contactData?.email) attendees.push(contactData.email);

    const crmRes = await fetch(`${crmUrl}/functions/v1/receive-meeting-transcript`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${crmKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        google_event_id: meeting.google_event_id || undefined,
        title: meeting.title,
        attendees,
        start_time: meeting.start_time,
        end_time: meeting.end_time || meeting.start_time,
        transcript_text: transcript,
        auto_generate_notes: true,
      }),
    });

    if (crmRes.ok) {
      const crmResult = await crmRes.json();
      console.log("CRM transcript pipeline completed", {
        meetingId: crmResult.meeting_id,
        notesGenerated: crmResult.notes_generated,
        tasksCreated: crmResult.notes_result?.tasks_created || 0,
      });
    } else {
      const errText = await crmRes.text();
      console.error("CRM receive-meeting-transcript failed:", crmRes.status, errText);
    }
  } catch (err) {
    console.error("CRM transcript sync error:", err);
  }

  console.log("Transcript forwarded to CRM for meeting:", meeting.id);
}

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

        if (transcript) {
          EdgeRuntime.waitUntil(
            forwardTranscriptToCrm(supabase, botId, transcript).catch(
              (err) => console.error("Transcript CRM forwarding error:", err)
            )
          );
        }
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RECALL_API_BASE = "https://api.recall.ai/api/v1";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

interface MeetingAnalysis {
  summary: string;
  key_points: string[];
  decisions: string[];
  action_items: Array<{ description: string; assigned_to: string; due_date: string | null }>;
  client_commitments: string[];
  next_steps: string[];
  insights: Array<{ category: string; content: string; confidence: string }>;
}

async function analyzeTranscript(transcript: string, meetingTitle: string): Promise<MeetingAnalysis | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey || !transcript || transcript.length < 50) return null;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Analiza la siguiente transcripcion de la reunion "${meetingTitle}" y retorna UNICAMENTE un JSON valido con esta estructura exacta (en espanol):

{
  "summary": "Resumen ejecutivo de 3-5 oraciones",
  "key_points": ["punto clave 1", "punto clave 2"],
  "decisions": ["decision tomada 1", "decision tomada 2"],
  "action_items": [{"description": "tarea", "assigned_to": "persona/equipo", "due_date": null}],
  "client_commitments": ["compromiso del cliente 1"],
  "next_steps": ["proximo paso 1"],
  "insights": [{"category": "need|objection|preference|budget|timeline|decision_maker|competitor|pain_point|positive_signal|personal_detail", "content": "descripcion del insight", "confidence": "high|medium|low"}]
}

Transcripcion:
${transcript.slice(0, 15000)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error("Anthropic API error:", await res.text());
    return null;
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";

  try {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();
    const braceStart = jsonStr.indexOf("{");
    const braceEnd = jsonStr.lastIndexOf("}");
    if (braceStart === -1 || braceEnd === -1) return null;
    return JSON.parse(jsonStr.slice(braceStart, braceEnd + 1));
  } catch {
    console.error("Failed to parse transcript analysis");
    return null;
  }
}

async function processTranscriptWithAI(
  supabase: ReturnType<typeof createClient>,
  botId: string,
  transcript: string
) {
  const { data: meeting } = await supabase
    .from("sales_meetings")
    .select("id, contact_id, conversation_id, title, start_time, google_event_id")
    .eq("recall_bot_id", botId)
    .maybeSingle();

  if (!meeting) {
    console.error("No meeting found for bot:", botId);
    return;
  }

  const analysis = await analyzeTranscript(transcript, meeting.title);
  if (!analysis) {
    console.log("No analysis generated for meeting:", meeting.id);
    return;
  }

  await supabase
    .from("sales_meetings")
    .update({ summary: analysis.summary })
    .eq("id", meeting.id);

  await supabase.from("sales_meeting_transcripts").upsert(
    {
      conversation_id: meeting.conversation_id,
      contact_id: meeting.contact_id,
      recall_bot_id: botId,
      raw_transcript: transcript,
      summary: analysis.summary,
      action_items: analysis.action_items,
      client_commitments: analysis.client_commitments,
      next_steps: analysis.next_steps,
      status: "completed",
      meeting_date: meeting.start_time,
      metadata: {
        key_points: analysis.key_points,
        decisions: analysis.decisions,
      },
    },
    { onConflict: "recall_bot_id" }
  );

  if (meeting.contact_id && analysis.insights.length > 0) {
    const validCategories = [
      "need", "objection", "preference", "budget", "timeline",
      "decision_maker", "competitor", "pain_point", "positive_signal", "personal_detail",
    ];

    const insightRows = analysis.insights
      .filter((i) => validCategories.includes(i.category))
      .map((i) => ({
        contact_id: meeting.contact_id,
        category: i.category,
        content: i.content,
        confidence: i.confidence || "medium",
        source_type: "meeting",
        source_conversation_id: meeting.conversation_id || null,
      }));

    if (insightRows.length > 0) {
      await supabase.from("client_insights").insert(insightRows);
    }
  }

  if (meeting.contact_id && meeting.conversation_id) {
    const keyTopics = [
      ...analysis.key_points.slice(0, 3),
      ...(analysis.decisions.length > 0 ? [`Decisiones: ${analysis.decisions.length}`] : []),
    ];

    await supabase.from("conversation_summaries").insert({
      conversation_id: meeting.conversation_id,
      contact_id: meeting.contact_id,
      summary: `[Reunion: ${meeting.title}] ${analysis.summary}`,
      message_range_start: meeting.start_time || new Date().toISOString(),
      message_range_end: new Date().toISOString(),
      message_count: 0,
      key_topics: keyTopics,
    });
  }

  const crmUrl = Deno.env.get("CRM_SUPABASE_URL");
  const crmKey = Deno.env.get("CRM_SUPABASE_SERVICE_ROLE_KEY");
  if (crmUrl && crmKey && meeting.google_event_id) {
    try {
      const crmSupabase = createClient(crmUrl, crmKey);

      const { data: crmMeeting } = await crmSupabase
        .from("tech_lead_meetings")
        .select("id, client_id")
        .eq("google_event_id", meeting.google_event_id)
        .maybeSingle();

      if (crmMeeting) {
        await crmSupabase
          .from("tech_lead_meetings")
          .update({
            status: "completada",
            post_meeting_notes: analysis.summary,
          })
          .eq("id", crmMeeting.id);

        if (crmMeeting.client_id) {
          await crmSupabase.from("tech_lead_timeline_events").insert({
            client_id: crmMeeting.client_id,
            event_type: "reunion",
            title: `Reunion completada: ${meeting.title}`,
            description: analysis.summary,
            metadata: {
              key_points: analysis.key_points,
              decisions: analysis.decisions,
              action_items_count: analysis.action_items.length,
            },
            reference_id: crmMeeting.id,
            reference_table: "tech_lead_meetings",
          });
        }
      }
    } catch (err) {
      console.error("CRM sync error:", err);
    }
  }

  console.log("Transcript processed successfully for meeting:", meeting.id);
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
            processTranscriptWithAI(supabase, botId, transcript).catch(
              (err) => console.error("Transcript AI processing error:", err)
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

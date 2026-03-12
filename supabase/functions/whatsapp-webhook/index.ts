import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const VERIFY_TOKEN =
  Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "obzide_wa_verify_2026";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

async function handleVerification(url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  return new Response("Forbidden", { status: 403, headers: corsHeaders });
}

async function upsertContact(
  supabase: ReturnType<typeof createClient>,
  waId: string,
  profileName: string
) {
  const { data: existing } = await supabase
    .from("whatsapp_contacts")
    .select("id")
    .eq("wa_id", waId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("whatsapp_contacts")
      .update({ profile_name: profileName, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: created } = await supabase
    .from("whatsapp_contacts")
    .insert({
      wa_id: waId,
      phone_number: waId,
      display_name: profileName,
      profile_name: profileName,
    })
    .select("id")
    .maybeSingle();

  return created?.id;
}

async function getOrCreateConversation(
  supabase: ReturnType<typeof createClient>,
  contactId: string,
  messagePreview: string
) {
  const { data: existing } = await supabase
    .from("whatsapp_conversations")
    .select("id, unread_count")
    .eq("contact_id", contactId)
    .eq("status", "active")
    .maybeSingle();

  if (existing) {
    await supabase
      .from("whatsapp_conversations")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: messagePreview.slice(0, 100),
        unread_count: (existing.unread_count || 0) + 1,
      })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: created } = await supabase
    .from("whatsapp_conversations")
    .insert({
      contact_id: contactId,
      last_message_preview: messagePreview.slice(0, 100),
      unread_count: 1,
    })
    .select("id")
    .maybeSingle();

  return created?.id;
}

function extractMessageContent(message: Record<string, unknown>) {
  const type = message.type as string;

  switch (type) {
    case "text":
      return {
        content: (message.text as Record<string, string>)?.body || "",
        media_url: "",
        media_mime_type: "",
      };
    case "image":
    case "video":
    case "audio":
    case "document": {
      const media = message[type] as Record<string, string>;
      return {
        content: media?.caption || "",
        media_url: media?.id || "",
        media_mime_type: media?.mime_type || "",
      };
    }
    case "location": {
      const loc = message.location as Record<string, number>;
      return {
        content: `${loc?.latitude},${loc?.longitude}`,
        media_url: "",
        media_mime_type: "",
      };
    }
    default:
      return { content: "", media_url: "", media_mime_type: "" };
  }
}

function detectProvider(req: Request, body: Record<string, unknown>): string {
  if (req.headers.get("D360-API-KEY")) return "360dialog";
  if (req.headers.get("x-360dialog-channel")) return "360dialog";

  const entries = (body.entry as Array<Record<string, unknown>>) || [];
  if (entries.length > 0) return "cloud_api";

  if (body.messages || body.statuses || body.contacts) return "360dialog";

  return "cloud_api";
}

function normalize360Payload(body: Record<string, unknown>): Record<string, unknown> {
  if (body.entry) return body;

  const messages = (body.messages as Array<Record<string, unknown>>) || [];
  const contacts = (body.contacts as Array<Record<string, unknown>>) || [];
  const statuses = (body.statuses as Array<Record<string, unknown>>) || [];

  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                phone_number_id: "",
                display_phone_number: "",
              },
              messages,
              contacts,
              statuses,
            },
          },
        ],
      },
    ],
  };
}

async function processIncomingMessages(body: Record<string, unknown>, provider: string) {
  const supabase = getSupabase();

  const normalized = provider === "360dialog" ? normalize360Payload(body) : body;
  const entries = (normalized.entry as Array<Record<string, unknown>>) || [];

  for (const entry of entries) {
    const changes = (entry.changes as Array<Record<string, unknown>>) || [];

    for (const change of changes) {
      if (change.field !== "messages") continue;

      const value = change.value as Record<string, unknown>;
      const metadata = value.metadata as Record<string, string>;
      const phoneNumberId = metadata?.phone_number_id || "";
      const messages = (value.messages as Array<Record<string, unknown>>) || [];
      const contacts = (value.contacts as Array<Record<string, unknown>>) || [];

      const contactMap: Record<string, string> = {};
      for (const c of contacts) {
        const profile = c.profile as Record<string, string>;
        contactMap[c.wa_id as string] = profile?.name || "";
      }

      for (const message of messages) {
        const waId = message.from as string;
        const profileName = contactMap[waId] || waId;

        const contactId = await upsertContact(supabase, waId, profileName);
        if (!contactId) continue;

        const { content: msgContent } = extractMessageContent(message);
        const conversationId = await getOrCreateConversation(supabase, contactId, msgContent || `[${message.type}]`);
        if (!conversationId) continue;

        const { content, media_url, media_mime_type } = extractMessageContent(message);

        const waMessageId = message.id as string;
        const { data: existing } = await supabase
          .from("whatsapp_messages")
          .select("id")
          .eq("wa_message_id", waMessageId)
          .maybeSingle();

        if (existing) continue;

        await supabase.from("whatsapp_messages").insert({
          conversation_id: conversationId,
          contact_id: contactId,
          wa_message_id: waMessageId,
          direction: "inbound",
          message_type: message.type as string,
          content,
          media_url,
          media_mime_type,
          metadata: {
            phone_number_id: phoneNumberId,
            timestamp: message.timestamp,
            provider,
            raw: message,
          },
          status: "received",
        });
      }

      const statuses = (value.statuses as Array<Record<string, unknown>>) || [];
      for (const status of statuses) {
        const waMessageId = status.id as string;
        const statusValue = status.status as string;

        if (waMessageId && statusValue) {
          await supabase
            .from("whatsapp_messages")
            .update({ status: statusValue })
            .eq("wa_message_id", waMessageId)
            .eq("direction", "outbound");
        }
      }
    }
  }
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const url = new URL(req.url);

    if (req.method === "GET") {
      return await handleVerification(url);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const provider = detectProvider(req, body);

      console.log(`Webhook received from provider: ${provider}`);

      EdgeRuntime.waitUntil(
        processIncomingMessages(body, provider).catch((err) =>
          console.error("Webhook processing error:", err)
        )
      );

      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

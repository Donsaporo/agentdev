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

function computeWindowStatus(lastInboundAt: Date): 'open' | 'closing_soon' | 'closed' {
  const now = new Date();
  const diffMs = now.getTime() - lastInboundAt.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 20) return 'open';
  if (diffHours <= 24) return 'closing_soon';
  return 'closed';
}

async function upsertContact(
  supabase: ReturnType<typeof createClient>,
  waId: string,
  profileName: string
): Promise<{ id: string; isNew: boolean } | null> {
  const { data: existing } = await supabase
    .from("whatsapp_contacts")
    .select("id, intro_sent")
    .eq("wa_id", waId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("whatsapp_contacts")
      .update({
        profile_name: profileName,
        updated_at: new Date().toISOString(),
        last_message_direction: 'inbound',
        last_inbound_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return { id: existing.id, isNew: false };
  }

  const { data: created } = await supabase
    .from("whatsapp_contacts")
    .insert({
      wa_id: waId,
      phone_number: waId,
      display_name: profileName,
      profile_name: profileName,
      intro_sent: false,
      is_imported: false,
      last_message_direction: 'inbound',
    })
    .select("id")
    .maybeSingle();

  return created ? { id: created.id, isNew: true } : null;
}

async function getOrCreateConversation(
  supabase: ReturnType<typeof createClient>,
  contactId: string,
  messagePreview: string
) {
  const now = new Date();
  const windowExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { data: existingRows } = await supabase
    .from("whatsapp_conversations")
    .select("id, unread_count")
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("last_message_at", { ascending: false })
    .limit(5);

  const existing = existingRows?.[0];

  if (existing) {
    await supabase
      .from("whatsapp_conversations")
      .update({
        last_message_at: now.toISOString(),
        last_message_preview: messagePreview.slice(0, 100),
        unread_count: (existing.unread_count || 0) + 1,
        last_inbound_at: now.toISOString(),
        window_expires_at: windowExpiresAt.toISOString(),
        window_status: computeWindowStatus(now),
      })
      .eq("id", existing.id);

    if (existingRows && existingRows.length > 1) {
      const duplicateIds = existingRows.slice(1).map((r) => r.id);
      await supabase
        .from("whatsapp_conversations")
        .update({ status: "archived" })
        .in("id", duplicateIds);
      console.log(`Auto-archived ${duplicateIds.length} duplicate conversations for contact ${contactId}`);
    }

    return existing.id;
  }

  const { data: created } = await supabase
    .from("whatsapp_conversations")
    .insert({
      contact_id: contactId,
      last_message_preview: messagePreview.slice(0, 100),
      unread_count: 1,
      last_inbound_at: now.toISOString(),
      window_expires_at: windowExpiresAt.toISOString(),
      window_status: 'open',
    })
    .select("id")
    .maybeSingle();

  return created?.id;
}

function extractReplyContext(message: Record<string, unknown>): string | null {
  const context = message.context as Record<string, string> | undefined;
  if (context?.id) return context.id;
  return null;
}

function extractMessageContent(message: Record<string, unknown>) {
  const type = message.type as string;
  const replyToWaMessageId = extractReplyContext(message);

  switch (type) {
    case "text":
      return {
        content: (message.text as Record<string, string>)?.body || "",
        media_url: "",
        media_mime_type: "",
        media_id: "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    case "image":
    case "video":
    case "audio":
    case "document": {
      const media = message[type] as Record<string, string>;
      const fallbackLabel: Record<string, string> = {
        image: "[imagen]",
        video: "[video]",
        audio: "[audio]",
        document: "[documento]",
      };
      return {
        content: media?.caption || fallbackLabel[type] || `[${type}]`,
        media_url: media?.id || "",
        media_mime_type: media?.mime_type || "",
        media_id: media?.id || "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    }
    case "interactive": {
      const interactive = message.interactive as Record<string, Record<string, string>> | undefined;
      const buttonReply = interactive?.button_reply?.title;
      const listReply = interactive?.list_reply?.title || interactive?.list_reply?.description;
      return {
        content: buttonReply || listReply || "[interactivo]",
        media_url: "",
        media_mime_type: "",
        media_id: "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    }
    case "button": {
      const button = message.button as Record<string, string> | undefined;
      return {
        content: button?.text || "[boton]",
        media_url: "",
        media_mime_type: "",
        media_id: "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    }
    case "sticker": {
      const sticker = message.sticker as Record<string, string>;
      return {
        content: "[sticker]",
        media_url: sticker?.id || "",
        media_mime_type: sticker?.mime_type || "image/webp",
        media_id: sticker?.id || "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    }
    case "reaction": {
      const reaction = message.reaction as Record<string, string>;
      const emoji = reaction?.emoji || "";
      return {
        content: emoji ? `[reaccion: ${emoji}]` : "[reaccion]",
        media_url: "",
        media_mime_type: "",
        media_id: "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    }
    case "location": {
      const loc = message.location as Record<string, number>;
      return {
        content: `${loc?.latitude},${loc?.longitude}`,
        media_url: "",
        media_mime_type: "",
        media_id: "",
        reply_to_wa_message_id: replyToWaMessageId,
      };
    }
    default:
      return { content: "[" + type + "]", media_url: "", media_mime_type: "", media_id: "", reply_to_wa_message_id: replyToWaMessageId };
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

function getExtensionFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "audio/ogg": "ogg",
    "audio/ogg; codecs=opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/amr": "amr",
    "audio/aac": "aac",
    "application/pdf": "pdf",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt",
  };
  return map[mimeType] || "bin";
}

async function fetchMediaWithRetry(mediaId: string, apiKey: string, maxRetries = 2): Promise<Blob> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`https://waba-v2.360dialog.io/media/${mediaId}`, {
        method: "GET",
        headers: { "D360-API-KEY": apiKey },
      });
      if (!response.ok) {
        throw new Error(`Media download failed with status ${response.status}`);
      }
      return await response.blob();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  throw lastError!;
}

async function downloadAndStoreMedia(
  supabase: ReturnType<typeof createClient>,
  messageId: string,
  mediaId: string,
  mimeType: string,
  provider: string,
  apiKey: string
) {
  try {
    const blob = await fetchMediaWithRetry(mediaId, apiKey);
    const ext = getExtensionFromMimeType(mimeType);
    const storagePath = `whatsapp-media/${messageId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("media")
      .upload(storagePath, blob, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const { data: publicUrlData } = supabase.storage
      .from("media")
      .getPublicUrl(storagePath);

    await supabase
      .from("whatsapp_messages")
      .update({
        media_local_path: publicUrlData.publicUrl,
        media_download_status: "downloaded",
        media_file_size: blob.size,
      })
      .eq("id", messageId);
  } catch (err) {
    console.error("downloadAndStoreMedia error:", err);
    await supabase
      .from("whatsapp_messages")
      .update({
        media_download_status: "failed",
      })
      .eq("id", messageId);
  }
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

      let accessToken = "";
      if (provider === "360dialog" && phoneNumberId) {
        const { data: account } = await supabase
          .from("whatsapp_business_accounts")
          .select("access_token")
          .eq("phone_number_id", phoneNumberId)
          .maybeSingle();
        accessToken = account?.access_token || "";
      }

      if (!accessToken && provider === "360dialog") {
        const { data: account } = await supabase
          .from("whatsapp_business_accounts")
          .select("access_token")
          .eq("provider", "360dialog")
          .limit(1)
          .maybeSingle();
        accessToken = account?.access_token || "";
      }

      for (const message of messages) {
        const waId = message.from as string;
        const profileName = contactMap[waId] || waId;

        const contactResult = await upsertContact(supabase, waId, profileName);
        if (!contactResult) continue;

        const { id: contactId, isNew } = contactResult;

        const { content: msgContent } = extractMessageContent(message);
        const conversationId = await getOrCreateConversation(supabase, contactId, msgContent || `[${message.type}]`);
        if (!conversationId) continue;

        if (isNew) {
          await supabase
            .from("whatsapp_conversations")
            .update({ category: "new_lead" })
            .eq("id", conversationId);
        }

        const { content, media_url, media_mime_type, media_id: mediaId, reply_to_wa_message_id } = extractMessageContent(message);

        const waMessageId = message.id as string;

        const msgMetadata: Record<string, unknown> = {
          phone_number_id: phoneNumberId,
          timestamp: message.timestamp,
          provider,
          is_new_contact: isNew,
        };
        if (reply_to_wa_message_id) {
          msgMetadata.reply_to_wa_message_id = reply_to_wa_message_id;
        }

        const { data: inserted, error: insertError } = await supabase
          .from("whatsapp_messages")
          .insert({
            conversation_id: conversationId,
            contact_id: contactId,
            wa_message_id: waMessageId,
            direction: "inbound",
            message_type: message.type as string,
            content,
            media_url,
            media_mime_type,
            metadata: msgMetadata,
            status: "received",
            media_download_status: mediaId ? "pending" : null,
          })
          .select("id")
          .maybeSingle();

        if (insertError) {
          if (
            insertError.code === "23505" ||
            insertError.message?.includes("duplicate") ||
            insertError.message?.includes("unique")
          ) {
            continue;
          }
          console.error("Message insert error:", insertError);
          continue;
        }

        if (mediaId && inserted?.id && accessToken) {
          EdgeRuntime.waitUntil(
            downloadAndStoreMedia(
              supabase,
              inserted.id,
              mediaId,
              media_mime_type,
              provider,
              accessToken
            ).catch((err) => console.error("Media download error:", err))
          );
        }
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
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

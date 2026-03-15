import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GRAPH_API = "https://graph.facebook.com/v21.0";
const D360_API = "https://waba-v2.360dialog.io";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAccount(supabase: ReturnType<typeof createClient>, accountId: string) {
  const { data, error } = await supabase
    .from("whatsapp_business_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  if (error || !data) throw new Error("WhatsApp account not found");
  if (data.status !== "connected") throw new Error("Account is not connected");
  return data;
}

async function d360Fetch(apiKey: string, path: string, method = "GET", body?: Record<string, unknown>) {
  const opts: RequestInit = {
    method,
    headers: {
      "D360-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${D360_API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data.errors?.[0]?.details || data.error?.message || data.meta?.developer_message || JSON.stringify(data);
    throw new Error(errMsg);
  }
  return data;
}

async function graphFetch(token: string, phoneNumberId: string, body: Record<string, unknown>) {
  const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Graph API error: ${res.status}`);
  }
  return data;
}

function buildTextPayload(to: string, message: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: message },
  };
}

function buildTemplatePayload(to: string, templateName: string, languageCode: string, templateComponents?: Record<string, unknown>[]) {
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: languageCode },
  };
  if (templateComponents && templateComponents.length > 0) {
    template.components = templateComponents;
  }
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  };
}

function buildDocumentPayload(to: string, documentUrl: string, filename: string, caption?: string) {
  const document: Record<string, string> = {
    link: documentUrl,
    filename,
  };
  if (caption) {
    document.caption = caption;
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document,
  };
}

async function sendMessage(
  account: Record<string, string>,
  payload: Record<string, unknown>
) {
  if (account.provider === "360dialog") {
    return await d360Fetch(account.access_token, "/messages", "POST", payload);
  }
  return await graphFetch(account.access_token, account.phone_number_id, payload);
}

function isWindowExpiredError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes("24 hour") || msg.includes("outside") || msg.includes("allowed window") || msg.includes("131026");
}

function isRetryableError(err: Error): boolean {
  const msg = err.message;
  return /429|500|502|503|504/.test(msg);
}

async function sendWithRetry(
  account: Record<string, string>,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const maxAttempts = 3;
  const backoffDelays = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sendMessage(account, payload);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (isWindowExpiredError(error)) {
        return { window_expired: true };
      }

      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, backoffDelays[attempt]));
    }
  }

  throw new Error("sendWithRetry: all attempts exhausted");
}

async function checkWindowStatus(
  supabase: ReturnType<typeof createClient>,
  recipientPhone: string
): Promise<{ window_open: boolean; window_status: string; window_expires_at: string | null }> {
  const { data: contact } = await supabase
    .from("whatsapp_contacts")
    .select("id")
    .eq("wa_id", recipientPhone)
    .maybeSingle();

  if (!contact) {
    return { window_open: false, window_status: "no_contact", window_expires_at: null };
  }

  const { data: conversation } = await supabase
    .from("whatsapp_conversations")
    .select("id, window_expires_at, window_status")
    .eq("contact_id", contact.id)
    .eq("status", "active")
    .maybeSingle();

  if (!conversation) {
    return { window_open: false, window_status: "no_conversation", window_expires_at: null };
  }

  const expiresAt = conversation.window_expires_at;
  const windowOpen = expiresAt ? new Date(expiresAt) > new Date() : false;
  const windowStatus = conversation.window_status || (windowOpen ? "open" : "closed");

  return {
    window_open: windowOpen,
    window_status: windowStatus,
    window_expires_at: expiresAt || null,
  };
}

async function recordOutboundMessage(
  supabase: ReturnType<typeof createClient>,
  to: string,
  waMessageId: string,
  messageType: string,
  content: string,
  senderName?: string,
  mediaUrl?: string,
  mediaMimeType?: string
) {
  const { data: contact } = await supabase
    .from("whatsapp_contacts")
    .select("id")
    .eq("wa_id", to)
    .maybeSingle();

  let contactId = contact?.id;
  if (!contactId) {
    const { data: created } = await supabase
      .from("whatsapp_contacts")
      .insert({ wa_id: to, phone_number: to, display_name: to, profile_name: to })
      .select("id")
      .maybeSingle();
    contactId = created?.id;
  }
  if (!contactId) return;

  await supabase
    .from("whatsapp_contacts")
    .update({ last_message_direction: "outbound" })
    .eq("id", contactId);

  const { data: conversation } = await supabase
    .from("whatsapp_conversations")
    .select("id")
    .eq("contact_id", contactId)
    .eq("status", "active")
    .maybeSingle();

  let conversationId = conversation?.id;
  if (!conversationId) {
    const { data: created } = await supabase
      .from("whatsapp_conversations")
      .insert({ contact_id: contactId })
      .select("id")
      .maybeSingle();
    conversationId = created?.id;
  }
  if (!conversationId) return;

  const messageInsert: Record<string, unknown> = {
    conversation_id: conversationId,
    contact_id: contactId,
    wa_message_id: waMessageId,
    direction: "outbound",
    message_type: messageType,
    content,
    status: "sent",
  };

  if (senderName) {
    messageInsert.sender_name = senderName;
  }
  if (mediaUrl) {
    messageInsert.media_url = mediaUrl;
  }
  if (mediaMimeType) {
    messageInsert.media_mime_type = mediaMimeType;
  }

  await supabase.from("whatsapp_messages").insert(messageInsert);

  await supabase
    .from("whatsapp_conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: content.slice(0, 100),
    })
    .eq("id", conversationId);
}

async function handleCloudApiAction(account: Record<string, string>, action: string, body: Record<string, string>) {
  if (action === "register") {
    const regPin = body.pin || "147258";
    const res = await fetch(`${GRAPH_API}/${account.phone_number_id}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: regPin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Registration failed: ${res.status}`);
    return jsonRes({ success: true, message: "Phone number registered successfully" });
  }

  if (action === "check_status") {
    const res = await fetch(
      `${GRAPH_API}/${account.phone_number_id}?fields=verified_name,code_verification_status,quality_rating,platform_type,throughput,is_official_business_account,account_mode,is_pin_enabled,name_status,new_name_status,status,search_visibility,messaging_limit_tier`,
      { headers: { Authorization: `Bearer ${account.access_token}` } }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Status check failed: ${res.status}`);
    return jsonRes({ success: true, phone_status: data });
  }

  if (action === "request_code") {
    const codeMethod = body.code_method || "SMS";
    const codeLang = body.language || "es";
    const res = await fetch(`${GRAPH_API}/${account.phone_number_id}/request_code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", code_method: codeMethod, language: codeLang }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || "";
      const errCode = data.error?.code || "";
      const errSub = data.error?.error_subcode || "";
      return jsonRes({
        error: `${errMsg || "Request code failed"} (code: ${errCode}, subcode: ${errSub})`,
        details: data.error,
        hint: errCode === 136024 ? "Intenta renovar el token primero." : undefined,
      }, 400);
    }
    return jsonRes({ success: true, message: `Verification code sent via ${codeMethod}` });
  }

  if (action === "verify_code") {
    const code = body.code;
    if (!code) throw new Error("code is required");
    const res = await fetch(`${GRAPH_API}/${account.phone_number_id}/verify_code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", code }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || "";
      throw new Error(`${errMsg || "Verification failed"} (status: ${res.status})`);
    }
    return jsonRes({ success: true, message: "Phone number verified and registered" });
  }

  return null;
}

async function handleRefreshToken(supabase: ReturnType<typeof createClient>, accountId: string) {
  const { data: acct, error: acctErr } = await supabase
    .from("whatsapp_business_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  if (acctErr || !acct) throw new Error("Account not found");

  if (acct.provider === "360dialog") {
    return jsonRes({ success: true, message: "360dialog API keys do not expire" });
  }

  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) throw new Error("META_APP_SECRET not configured");
  const appId = acct.meta_app_id || "1393977296081412";

  const resp = await fetch(
    `${GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${acct.access_token}`
  );
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || "Token refresh failed");
  if (!data.access_token) throw new Error("No access_token in refresh response");

  await supabase
    .from("whatsapp_business_accounts")
    .update({
      access_token: data.access_token,
      status_message: `Token renovado - expira en ${data.expires_in ? Math.round(data.expires_in / 86400) + " dias" : "~60 dias"}`,
    })
    .eq("id", accountId);

  return jsonRes({
    success: true,
    message: "Token renovado exitosamente",
    expires_in_days: data.expires_in ? Math.round(data.expires_in / 86400) : null,
  });
}

async function handle360Action(account: Record<string, string>, action: string) {
  if (action === "check_status") {
    const health = await d360Fetch(account.access_token, "/configs/webhook");
    return jsonRes({ success: true, phone_status: { ...health, provider: "360dialog", code_verification_status: "VERIFIED" } });
  }

  return null;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return jsonRes({ error: "Method not allowed" }, 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonRes({ error: "Unauthorized" }, 401);
    }

    const supabase = getSupabase();
    const body = await req.json();
    const { action, account_id, to, message, type = "text", template_name, language_code = "es_PA", template_components, sender_name, document_url, filename, caption } = body;

    if (!account_id) {
      return jsonRes({ error: "account_id is required" }, 400);
    }

    if (action === "refresh_token") {
      return await handleRefreshToken(supabase, account_id);
    }

    const account = await getAccount(supabase, account_id);

    if (action === "check_window") {
      if (!to) return jsonRes({ error: "to is required" }, 400);
      const recipient = to.replace(/[\s\-\+\(\)]/g, "");
      const windowInfo = await checkWindowStatus(supabase, recipient);
      return jsonRes({ success: true, ...windowInfo });
    }

    if (action && action !== "send") {
      if (account.provider === "360dialog") {
        const result = await handle360Action(account, action);
        if (result) return result;
        return jsonRes({ error: `Action '${action}' not supported for 360dialog` }, 400);
      }

      const result = await handleCloudApiAction(account, action, body);
      if (result) return result;
      return jsonRes({ error: `Unknown action: ${action}` }, 400);
    }

    if (!to) {
      return jsonRes({ error: "to is required" }, 400);
    }

    const recipient = to.replace(/[\s\-\+\(\)]/g, "");
    let payload: Record<string, unknown>;
    let content = "";
    let usedTemplate = false;
    let outboundMediaUrl: string | undefined;
    let outboundMimeType: string | undefined;

    const windowInfo = await checkWindowStatus(supabase, recipient);

    if (type === "template") {
      const tplName = template_name || "hello_world";
      payload = buildTemplatePayload(recipient, tplName, language_code, template_components);
      content = `[Template: ${tplName}]`;
      usedTemplate = true;
    } else if (type === "document") {
      if (!document_url || !filename) {
        return jsonRes({ error: "document_url and filename are required for document type" }, 400);
      }
      if (!windowInfo.window_open) {
        return jsonRes({
          success: false,
          error: "Cannot send document: messaging window is closed. The client must write first or send a template to reopen the window.",
          window_expired: true,
          window_open: false,
          window_expires_at: windowInfo.window_expires_at,
        }, 400);
      }
      payload = buildDocumentPayload(recipient, document_url, filename, caption);
      content = caption || `[Document: ${filename}]`;
      outboundMediaUrl = document_url;
      outboundMimeType = "application/pdf";
    } else {
      if (!message) return jsonRes({ error: "message is required for text type" }, 400);

      if (!windowInfo.window_open) {
        const fallbackTemplateName = template_name || "seguimiento_amigable";
        console.log(`Window closed for ${recipient}, falling back to template: ${fallbackTemplateName}`);
        payload = buildTemplatePayload(recipient, fallbackTemplateName, language_code, template_components);
        content = `[Template: ${fallbackTemplateName}]`;
        usedTemplate = true;
      } else {
        payload = buildTextPayload(recipient, message);
        content = message;
      }
    }

    const result = await sendWithRetry(account, payload);

    if (result.window_expired) {
      return jsonRes({
        success: false,
        error: "Message window has expired",
        window_expired: true,
        window_open: false,
        window_expires_at: windowInfo.window_expires_at,
        used_template: usedTemplate,
      }, 400);
    }

    const waMessageId = (result.messages as Record<string, string>[])?.[0]?.id || "";

    try {
      await recordOutboundMessage(supabase, recipient, waMessageId, usedTemplate ? "template" : type, content, sender_name, outboundMediaUrl, outboundMimeType);
    } catch (err) {
      console.error("Record outbound error:", err);
    }

    return jsonRes({
      success: true,
      message_id: waMessageId,
      messaging_product: result.messaging_product as string,
      window_open: windowInfo.window_open,
      window_expires_at: windowInfo.window_expires_at,
      used_template: usedTemplate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Send message error:", error);
    return jsonRes({ error: message }, 400);
  }
});

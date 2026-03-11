import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GRAPH_API = "https://graph.facebook.com/v21.0";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
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

async function sendTextMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string
) {
  const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Graph API error: ${res.status}`);
  }
  return data;
}

async function sendTemplateMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  templateName: string,
  languageCode: string
) {
  const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Graph API error: ${res.status}`);
  }
  return data;
}

async function recordOutboundMessage(
  supabase: ReturnType<typeof createClient>,
  to: string,
  waMessageId: string,
  messageType: string,
  content: string
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
      .insert({
        wa_id: to,
        phone_number: to,
        display_name: to,
        profile_name: to,
      })
      .select("id")
      .maybeSingle();
    contactId = created?.id;
  }

  if (!contactId) return;

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

  await supabase.from("whatsapp_messages").insert({
    conversation_id: conversationId,
    contact_id: contactId,
    wa_message_id: waMessageId,
    direction: "outbound",
    message_type: messageType,
    content,
    status: "sent",
  });

  await supabase
    .from("whatsapp_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getSupabase();
    const body = await req.json();
    const { action, account_id, to, message, type = "text", template_name, language_code = "en_US", pin } = body;

    if (!account_id) {
      return new Response(
        JSON.stringify({ error: "account_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const account = await getAccount(supabase, account_id);

    if (action === "register") {
      const regPin = pin || "147258";
      const regRes = await fetch(`${GRAPH_API}/${account.phone_number_id}/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          pin: regPin,
        }),
      });

      const regData = await regRes.json();
      if (!regRes.ok) {
        throw new Error(regData.error?.message || `Registration failed: ${regRes.status}`);
      }

      return new Response(
        JSON.stringify({ success: true, message: "Phone number registered successfully" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!to) {
      return new Response(
        JSON.stringify({ error: "to is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const recipient = to.replace(/[\s\-\+\(\)]/g, "");

    let result;
    let content = "";

    if (type === "template") {
      const tplName = template_name || "hello_world";
      result = await sendTemplateMessage(
        account.access_token,
        account.phone_number_id,
        recipient,
        tplName,
        language_code
      );
      content = `[Template: ${tplName}]`;
    } else {
      if (!message) {
        return new Response(
          JSON.stringify({ error: "message is required for text type" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      result = await sendTextMessage(
        account.access_token,
        account.phone_number_id,
        recipient,
        message
      );
      content = message;
    }

    const waMessageId = result.messages?.[0]?.id || "";

    EdgeRuntime.waitUntil(
      recordOutboundMessage(supabase, recipient, waMessageId, type, content).catch(
        (err) => console.error("Record outbound error:", err)
      )
    );

    return new Response(
      JSON.stringify({
        success: true,
        message_id: waMessageId,
        messaging_product: result.messaging_product,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Send message error:", error);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

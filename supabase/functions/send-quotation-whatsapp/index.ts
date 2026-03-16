import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

function getCrmSupabase() {
  const url = Deno.env.get("CRM_SUPABASE_URL");
  const key = Deno.env.get("CRM_SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("CRM Supabase credentials not configured");
  return createClient(url, key);
}

const STAGE_ORDER = [
  "nuevo",
  "en_proceso",
  "demo_solicitada",
  "cotizacion_enviada",
  "por_cerrar",
  "ganado",
  "perdido",
];

function shouldAdvanceStage(current: string, target: string): boolean {
  const currentIdx = STAGE_ORDER.indexOf(current);
  const targetIdx = STAGE_ORDER.indexOf(target);
  if (currentIdx === -1 || targetIdx === -1) return false;
  if (current === "ganado" || current === "perdido") return false;
  return targetIdx > currentIdx;
}

async function generatePdf(
  crmUrl: string,
  crmAnonKey: string,
  quotationId: string
): Promise<{ pdf_url: string; filename: string }> {
  const res = await fetch(
    `${crmUrl}/functions/v1/generate-quotation-pdf`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${crmAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quotation_id: quotationId }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PDF generation failed: ${errText}`);
  }

  const data = await res.json();
  if (!data.success || !data.pdf_url) {
    throw new Error("PDF generation returned no URL");
  }

  return { pdf_url: data.pdf_url, filename: data.filename || "cotizacion.pdf" };
}

async function sendWhatsAppMessage(
  supabaseUrl: string,
  serviceRoleKey: string,
  accountId: string,
  to: string,
  type: string,
  payload: Record<string, unknown>
) {
  const res = await fetch(
    `${supabaseUrl}/functions/v1/whatsapp-send-message`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "send",
        account_id: accountId,
        to,
        type,
        ...payload,
      }),
    }
  );

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || `WhatsApp send failed: ${res.status}`);
  }
  return data;
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

    const body = await req.json();
    const { quotation_id, client_id } = body;

    if (!quotation_id || !client_id) {
      return jsonRes(
        { error: "quotation_id and client_id are required" },
        400
      );
    }

    const supabase = getSupabase();
    const crmSupabase = getCrmSupabase();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const crmUrl = Deno.env.get("CRM_SUPABASE_URL")!;
    const crmAnonKey =
      Deno.env.get("CRM_SUPABASE_ANON_KEY") ||
      Deno.env.get("CRM_SUPABASE_SERVICE_ROLE_KEY")!;

    const { data: client, error: clientErr } = await crmSupabase
      .from("tech_clients")
      .select("id, name, contact_name, phone, lead_stage")
      .eq("id", client_id)
      .maybeSingle();

    if (clientErr || !client) {
      return jsonRes({ error: "Client not found in CRM" }, 404);
    }

    if (!client.phone) {
      return jsonRes(
        { error: "Client has no phone number registered" },
        400
      );
    }

    const { data: quotation, error: quotErr } = await crmSupabase
      .from("tech_quotations")
      .select("id, quotation_display, client_name, status, total")
      .eq("id", quotation_id)
      .maybeSingle();

    if (quotErr || !quotation) {
      return jsonRes({ error: "Quotation not found" }, 404);
    }

    if (
      quotation.status === "Cancelled" ||
      quotation.status === "Cancelada"
    ) {
      return jsonRes({ error: "Cannot send a cancelled quotation" }, 400);
    }

    const { data: waAccount } = await supabase
      .from("whatsapp_business_accounts")
      .select("id")
      .eq("status", "connected")
      .limit(1)
      .maybeSingle();

    if (!waAccount) {
      return jsonRes(
        { error: "No connected WhatsApp Business account found" },
        400
      );
    }

    const recipientPhone = client.phone.replace(/[\s\-\+\(\)]/g, "");
    const clientName =
      client.contact_name || client.name || quotation.client_name;

    const { pdf_url, filename } = await generatePdf(
      crmUrl,
      crmAnonKey,
      quotation_id
    );

    const textMessage = `Hola ${clientName}, te envio tu cotizacion ${quotation.quotation_display}. Revisala con calma y cualquier duda me escribes, quedo atento.`;

    const textResult = await sendWhatsAppMessage(
      supabaseUrl,
      serviceRoleKey,
      waAccount.id,
      recipientPhone,
      "text",
      { message: textMessage, sender_name: "Sistema CRM" }
    );

    const docResult = await sendWhatsAppMessage(
      supabaseUrl,
      serviceRoleKey,
      waAccount.id,
      recipientPhone,
      "document",
      {
        document_url: pdf_url,
        filename,
        caption: `Cotizacion ${quotation.quotation_display}`,
        sender_name: "Sistema CRM",
      }
    );

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          if (
            quotation.status === "Draft" ||
            quotation.status === "Borrador"
          ) {
            await crmSupabase
              .from("tech_quotations")
              .update({ status: "Sent" })
              .eq("id", quotation_id);
          }

          if (shouldAdvanceStage(client.lead_stage || "nuevo", "cotizacion_enviada")) {
            await crmSupabase
              .from("tech_clients")
              .update({
                lead_stage: "cotizacion_enviada",
                last_activity_at: new Date().toISOString(),
              })
              .eq("id", client_id);
          }

          await crmSupabase.from("tech_lead_timeline_events").insert({
            client_id,
            event_type: "cotizacion",
            title: `Cotizacion ${quotation.quotation_display} enviada por WhatsApp`,
            description: `Se envio la cotizacion ${quotation.quotation_display} al cliente ${clientName} via WhatsApp.`,
            metadata: {
              quotation_id,
              quotation_display: quotation.quotation_display,
              sent_via: "whatsapp",
              pdf_url,
            },
          });
        } catch (err) {
          console.error("Post-send updates error:", err);
        }
      })()
    );

    return jsonRes({
      success: true,
      text_message_id: textResult.message_id,
      document_message_id: docResult.message_id,
      pdf_url,
      quotation_display: quotation.quotation_display,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    console.error("Send quotation WhatsApp error:", error);
    return jsonRes({ error: message }, 400);
  }
});

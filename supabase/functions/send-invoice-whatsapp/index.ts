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

async function generateInvoicePdf(
  crmUrl: string,
  crmAnonKey: string,
  invoiceId: string
): Promise<{ pdf_url: string; filename: string }> {
  const res = await fetch(
    `${crmUrl}/functions/v1/generate-invoice-pdf`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${crmAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invoice_id: invoiceId }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Invoice PDF generation failed: ${errText}`);
  }

  const data = await res.json();
  if (!data.success || !data.pdf_url) {
    throw new Error("Invoice PDF generation returned no URL");
  }

  return { pdf_url: data.pdf_url, filename: data.filename || "factura.pdf" };
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

function formatDueDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("es-PA", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
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
    const { invoice_id, client_id } = body;

    if (!invoice_id || !client_id) {
      return jsonRes(
        { error: "invoice_id and client_id are required" },
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
      .select("id, name, contact_name, phone")
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

    const { data: invoice, error: invErr } = await crmSupabase
      .from("tech_invoices")
      .select(
        "id, invoice_display, client_name, payment_status, total, due_date"
      )
      .eq("id", invoice_id)
      .maybeSingle();

    if (invErr || !invoice) {
      return jsonRes({ error: "Invoice not found" }, 404);
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
      client.contact_name || client.name || invoice.client_name;

    const { pdf_url, filename } = await generateInvoicePdf(
      crmUrl,
      crmAnonKey,
      invoice_id
    );

    const dueDateStr = invoice.due_date
      ? ` La fecha de vencimiento es el ${formatDueDate(invoice.due_date)}.`
      : "";

    const textMessage = `Hola ${clientName}, te comparto tu factura ${invoice.invoice_display}.${dueDateStr} Cualquier consulta estoy a la orden.`;

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
        caption: `Factura ${invoice.invoice_display}`,
        sender_name: "Sistema CRM",
      }
    );

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          await crmSupabase.from("tech_lead_timeline_events").insert({
            client_id,
            event_type: "otro",
            title: `Factura ${invoice.invoice_display} enviada por WhatsApp`,
            description: `Se envio la factura ${invoice.invoice_display} al cliente ${clientName} via WhatsApp.`,
            metadata: {
              invoice_id,
              invoice_display: invoice.invoice_display,
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
      invoice_display: invoice.invoice_display,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    console.error("Send invoice WhatsApp error:", error);
    return jsonRes({ error: message }, 400);
  }
});

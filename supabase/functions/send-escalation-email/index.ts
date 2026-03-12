import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface EscalationPayload {
  to: string;
  contactName: string;
  contactPhone: string;
  conversationId: string;
  reason: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const payload: EscalationPayload = await req.json();
    const { to, contactName, contactPhone, conversationId, reason } = payload;

    if (!to || !reason) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, reason" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!resendApiKey) {
      console.log("RESEND_API_KEY not configured, logging escalation instead");
      console.log(`ESCALATION: ${contactName} (${contactPhone}) - ${reason}`);
      return new Response(
        JSON.stringify({ success: true, method: "logged" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #dc2626; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">Escalacion - Atencion Requerida</h2>
        </div>
        <div style="background: #fff; border: 1px solid #e5e7eb; padding: 24px; border-radius: 0 0 8px 8px;">
          <p><strong>Cliente:</strong> ${contactName}</p>
          <p><strong>Telefono:</strong> ${contactPhone}</p>
          <p><strong>Razon:</strong></p>
          <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; margin: 12px 0;">
            ${reason}
          </div>
          <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
            Conversacion ID: ${conversationId}
          </p>
        </div>
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Obzide Sales Agent <noreply@obzide.com>",
        to: [to],
        subject: `[ESCALACION] ${contactName} - ${reason.slice(0, 50)}`,
        html: emailHtml,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Resend API error:", err);
      return new Response(
        JSON.stringify({ error: "Failed to send email" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await res.json();
    return new Response(
      JSON.stringify({ success: true, emailId: result.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Escalation email error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

function getAuthSupabase(authHeader: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

async function exchangeCodeForToken(code: string, appId: string) {
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) {
    throw new Error("META_APP_SECRET not configured");
  }

  const url = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.error) {
    throw new Error(data.error.message || "Token exchange failed");
  }

  return data.access_token as string;
}

async function getDebugTokenInfo(inputToken: string, appId: string) {
  const appSecret = Deno.env.get("META_APP_SECRET");
  const url = `https://graph.facebook.com/v21.0/debug_token?input_token=${inputToken}&access_token=${appId}|${appSecret}`;
  const resp = await fetch(url);
  return await resp.json();
}

async function getSharedWABAInfo(accessToken: string) {
  const url = `https://graph.facebook.com/v21.0/me/businesses?access_token=${accessToken}`;
  const resp = await fetch(url);
  return await resp.json();
}

async function getWABAFromToken(accessToken: string, wabaId: string) {
  const url = `https://graph.facebook.com/v21.0/${wabaId}?fields=id,name,currency,timezone_id,message_template_namespace&access_token=${accessToken}`;
  const resp = await fetch(url);
  return await resp.json();
}

async function getPhoneNumbers(accessToken: string, wabaId: string) {
  const url = `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status&access_token=${accessToken}`;
  const resp = await fetch(url);
  return await resp.json();
}

async function registerPhoneNumber(accessToken: string, phoneNumberId: string) {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/register`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      pin: "123456",
    }),
  });
  return await resp.json();
}

async function subscribeToWebhook(accessToken: string, wabaId: string) {
  const url = `https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  return await resp.json();
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

    const authClient = getAuthSupabase(authHeader);
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { code, app_id, configuration_id, waba_id, phone_number_id } = body;

    if (!code || !app_id) {
      return new Response(
        JSON.stringify({ error: "Missing code or app_id" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const accessToken = await exchangeCodeForToken(code, app_id);

    let wabaInfo = null;
    let phoneInfo = null;
    let finalWabaId = waba_id || "";
    let finalPhoneId = phone_number_id || "";
    let displayPhone = "";
    let verifiedName = "";
    let qualityRating = "unknown";

    if (finalWabaId) {
      wabaInfo = await getWABAFromToken(accessToken, finalWabaId);

      const phonesResp = await getPhoneNumbers(accessToken, finalWabaId);
      if (phonesResp.data && phonesResp.data.length > 0) {
        const phone = finalPhoneId
          ? phonesResp.data.find(
              (p: Record<string, string>) => p.id === finalPhoneId
            ) || phonesResp.data[0]
          : phonesResp.data[0];

        finalPhoneId = phone.id;
        displayPhone = phone.display_phone_number || "";
        verifiedName = phone.verified_name || wabaInfo?.name || "";
        qualityRating = phone.quality_rating || "unknown";
      }
    }

    try {
      await registerPhoneNumber(accessToken, finalPhoneId);
    } catch (_e) {
      // phone may already be registered
    }

    if (finalWabaId) {
      try {
        await subscribeToWebhook(accessToken, finalWabaId);
      } catch (_e) {
        // subscription may already exist
      }
    }

    const supabase = getSupabase();

    const { data: account, error: dbError } = await supabase
      .from("whatsapp_business_accounts")
      .insert({
        waba_id: finalWabaId,
        phone_number_id: finalPhoneId,
        display_phone_number: displayPhone,
        verified_name: verifiedName,
        quality_rating: qualityRating,
        access_token: accessToken,
        meta_app_id: app_id,
        configuration_id: configuration_id || "",
        status: "connected",
        status_message: "Connected via Embedded Signup",
        connected_by: user.id,
        connected_at: new Date().toISOString(),
      })
      .select("id, waba_id, phone_number_id, display_phone_number, verified_name, status")
      .maybeSingle();

    if (dbError) {
      return new Response(JSON.stringify({ error: dbError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        account,
        waba_details: wabaInfo,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Embedded signup error:", error);
    const message = error instanceof Error ? error.message : "Internal error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

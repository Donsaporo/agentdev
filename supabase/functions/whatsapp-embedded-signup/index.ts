import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GRAPH_API = "https://graph.facebook.com/v25.0";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getAuthSupabase(authHeader: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

function getServiceSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

async function exchangeCodeForToken(code: string, appId: string): Promise<string> {
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) {
    throw new Error("META_APP_SECRET no esta configurado en los secrets de Edge Functions");
  }

  const resp = await fetch(`${GRAPH_API}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: appId,
      client_secret: appSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  const data = await resp.json();

  if (data.error) {
    console.error("Token exchange error:", JSON.stringify(data.error));
    throw new Error(
      data.error.message || "Fallo el intercambio de token. Verifica META_APP_SECRET."
    );
  }

  if (!data.access_token) {
    throw new Error("No se recibio access_token en la respuesta de Meta");
  }

  return data.access_token as string;
}

async function graphGet(path: string, token: string) {
  const url = `${GRAPH_API}${path}${path.includes("?") ? "&" : "?"}access_token=${token}`;
  const resp = await fetch(url);
  return await resp.json();
}

async function discoverWABA(accessToken: string, appId: string): Promise<string | null> {
  const appSecret = Deno.env.get("META_APP_SECRET");
  const debugUrl = `${GRAPH_API}/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`;
  const debugResp = await fetch(debugUrl);
  const debugData = await debugResp.json();

  if (debugData.data?.granular_scopes) {
    for (const scope of debugData.data.granular_scopes) {
      if (
        scope.scope === "whatsapp_business_management" &&
        scope.target_ids?.length > 0
      ) {
        return scope.target_ids[0] as string;
      }
    }
  }

  const bizData = await graphGet("/me/businesses", accessToken);
  if (bizData.data) {
    for (const biz of bizData.data) {
      const owned = await graphGet(
        `/${biz.id}/owned_whatsapp_business_accounts`,
        accessToken
      );
      if (owned.data?.length > 0) return owned.data[0].id;

      const client = await graphGet(
        `/${biz.id}/client_whatsapp_business_accounts`,
        accessToken
      );
      if (client.data?.length > 0) return client.data[0].id;
    }
  }

  return null;
}

async function getPhoneNumbers(accessToken: string, wabaId: string) {
  return await graphGet(
    `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
    accessToken
  );
}

async function subscribeApp(accessToken: string, wabaId: string) {
  const resp = await fetch(`${GRAPH_API}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  return await resp.json();
}

async function registerPhone(accessToken: string, phoneNumberId: string) {
  const resp = await fetch(`${GRAPH_API}/${phoneNumberId}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      pin: "123456",
    }),
  });
  return await resp.json();
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const authClient = getAuthSupabase(authHeader);
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const { code, app_id, configuration_id, waba_id, phone_number_id } = body;

    if (!code || !app_id) {
      return jsonResponse({ error: "Faltan code o app_id" }, 400);
    }

    console.log("Exchanging code for token...");
    const accessToken = await exchangeCodeForToken(code, app_id);
    console.log("Token obtained successfully");

    let finalWabaId = waba_id || "";
    let finalPhoneId = phone_number_id || "";
    let displayPhone = "";
    let verifiedName = "";
    let qualityRating = "unknown";

    if (!finalWabaId) {
      console.log("Discovering WABA from token...");
      const discovered = await discoverWABA(accessToken, app_id);
      if (discovered) {
        finalWabaId = discovered;
        console.log("Discovered WABA:", finalWabaId);
      }
    }

    if (!finalWabaId) {
      return jsonResponse(
        {
          error:
            "No se detecto tu WhatsApp Business Account. Asegurate de haber completado el flujo y seleccionado una cuenta.",
        },
        400
      );
    }

    const wabaInfo = await graphGet(
      `/${finalWabaId}?fields=id,name,currency,timezone_id,message_template_namespace`,
      accessToken
    );
    console.log("WABA info:", wabaInfo.name || finalWabaId);

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
      console.log("Phone:", displayPhone, "ID:", finalPhoneId);
    }

    try {
      console.log("Subscribing app to WABA...");
      const subResult = await subscribeApp(accessToken, finalWabaId);
      console.log("Subscribe result:", JSON.stringify(subResult));
    } catch (e) {
      console.warn("Subscribe failed (may already exist):", e);
    }

    if (finalPhoneId) {
      try {
        console.log("Registering phone for Cloud API...");
        const regResult = await registerPhone(accessToken, finalPhoneId);
        console.log("Register result:", JSON.stringify(regResult));
      } catch (e) {
        console.warn("Phone register failed (may already be registered):", e);
      }
    }

    const supabase = getServiceSupabase();

    const { data: existing } = await supabase
      .from("whatsapp_business_accounts")
      .select("id")
      .eq("waba_id", finalWabaId)
      .eq("connected_by", user.id)
      .maybeSingle();

    let account;
    let dbError;

    if (existing) {
      const result = await supabase
        .from("whatsapp_business_accounts")
        .update({
          phone_number_id: finalPhoneId,
          display_phone_number: displayPhone,
          verified_name: verifiedName,
          quality_rating: qualityRating,
          access_token: accessToken,
          meta_app_id: app_id,
          configuration_id: configuration_id || "",
          status: "connected",
          status_message: "Reconectado via Embedded Signup",
          connected_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select(
          "id, waba_id, phone_number_id, display_phone_number, verified_name, status"
        )
        .maybeSingle();

      account = result.data;
      dbError = result.error;
    } else {
      const result = await supabase
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
          status_message: "Conectado via Embedded Signup",
          connected_by: user.id,
          connected_at: new Date().toISOString(),
        })
        .select(
          "id, waba_id, phone_number_id, display_phone_number, verified_name, status"
        )
        .maybeSingle();

      account = result.data;
      dbError = result.error;
    }

    if (dbError) {
      console.error("DB error:", dbError);
      return jsonResponse({ error: dbError.message }, 500);
    }

    console.log("Account saved:", account?.id);

    return jsonResponse({
      success: true,
      account,
      waba_details: {
        id: wabaInfo.id,
        name: wabaInfo.name,
        currency: wabaInfo.currency,
      },
    });
  } catch (error) {
    console.error("Embedded signup error:", error);
    const message = error instanceof Error ? error.message : "Error interno";
    return jsonResponse({ error: message }, 500);
  }
});

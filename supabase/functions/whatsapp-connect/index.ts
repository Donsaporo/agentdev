import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GRAPH_API = "https://graph.facebook.com/v21.0";

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

async function graphGet(path: string, token: string) {
  const url = `${GRAPH_API}${path}${path.includes("?") ? "&" : "?"}access_token=${token}`;
  const resp = await fetch(url);
  return await resp.json();
}

async function discoverAccounts(accessToken: string) {
  const accounts: {
    waba_id: string;
    waba_name: string;
    phone_numbers: {
      id: string;
      display_phone_number: string;
      verified_name: string;
      quality_rating: string;
    }[];
  }[] = [];

  const wabaResp = await graphGet(
    "/me/whatsapp_business_accounts?fields=id,name",
    accessToken
  );

  if (wabaResp.error) {
    const bizResp = await graphGet("/me/businesses?fields=id,name", accessToken);

    if (bizResp.data) {
      for (const biz of bizResp.data) {
        const ownedResp = await graphGet(
          `/${biz.id}/owned_whatsapp_business_accounts?fields=id,name`,
          accessToken
        );
        if (ownedResp.data) {
          for (const waba of ownedResp.data) {
            const phones = await getPhoneNumbers(accessToken, waba.id);
            accounts.push({
              waba_id: waba.id,
              waba_name: waba.name || biz.name || "WhatsApp Business",
              phone_numbers: phones,
            });
          }
        }

        const clientResp = await graphGet(
          `/${biz.id}/client_whatsapp_business_accounts?fields=id,name`,
          accessToken
        );
        if (clientResp.data) {
          for (const waba of clientResp.data) {
            const phones = await getPhoneNumbers(accessToken, waba.id);
            accounts.push({
              waba_id: waba.id,
              waba_name: waba.name || biz.name || "WhatsApp Business",
              phone_numbers: phones,
            });
          }
        }
      }
    }
  } else if (wabaResp.data) {
    for (const waba of wabaResp.data) {
      const phones = await getPhoneNumbers(accessToken, waba.id);
      accounts.push({
        waba_id: waba.id,
        waba_name: waba.name || "WhatsApp Business",
        phone_numbers: phones,
      });
    }
  }

  if (accounts.length === 0) {
    const debugResp = await graphGet("/debug_token?input_token=" + accessToken, accessToken);
    if (debugResp.data?.granular_scopes) {
      for (const scope of debugResp.data.granular_scopes) {
        if (
          scope.scope === "whatsapp_business_management" &&
          scope.target_ids?.length > 0
        ) {
          for (const wabaId of scope.target_ids) {
            const wabaInfo = await graphGet(
              `/${wabaId}?fields=id,name`,
              accessToken
            );
            const phones = await getPhoneNumbers(accessToken, wabaId);
            accounts.push({
              waba_id: wabaId,
              waba_name: wabaInfo.name || "WhatsApp Business",
              phone_numbers: phones,
            });
          }
        }
      }
    }
  }

  return accounts;
}

async function getPhoneNumbers(accessToken: string, wabaId: string) {
  const resp = await graphGet(
    `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
    accessToken
  );

  if (!resp.data) return [];

  return resp.data.map(
    (p: Record<string, string>) => ({
      id: p.id,
      display_phone_number: p.display_phone_number || "",
      verified_name: p.verified_name || "",
      quality_rating: p.quality_rating || "unknown",
    })
  );
}

async function connectAccount(
  accessToken: string,
  wabaId: string,
  phoneNumberId: string | undefined,
  userId: string
) {
  const wabaInfo = await graphGet(
    `/${wabaId}?fields=id,name,currency,timezone_id,message_template_namespace`,
    accessToken
  );

  if (wabaInfo.error) {
    throw new Error(
      wabaInfo.error.message || "No se pudo acceder al WABA. Verifica el token y los permisos."
    );
  }

  let finalPhoneId = phoneNumberId || "";
  let displayPhone = "";
  let verifiedName = "";
  let qualityRating = "unknown";

  const phones = await getPhoneNumbers(accessToken, wabaId);
  if (phones.length > 0) {
    const phone = finalPhoneId
      ? phones.find((p: { id: string }) => p.id === finalPhoneId) || phones[0]
      : phones[0];

    finalPhoneId = phone.id;
    displayPhone = phone.display_phone_number;
    verifiedName = phone.verified_name || wabaInfo.name || "";
    qualityRating = phone.quality_rating;
  }

  try {
    await fetch(`${GRAPH_API}/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch (_e) {
    // subscription may already exist
  }

  const supabase = getServiceSupabase();

  const { data: existing } = await supabase
    .from("whatsapp_business_accounts")
    .select("id")
    .eq("waba_id", wabaId)
    .eq("connected_by", userId)
    .maybeSingle();

  if (existing) {
    const { data: account, error: dbError } = await supabase
      .from("whatsapp_business_accounts")
      .update({
        phone_number_id: finalPhoneId,
        display_phone_number: displayPhone,
        verified_name: verifiedName,
        quality_rating: qualityRating,
        access_token: accessToken,
        status: "connected",
        status_message: "Reconectado con token actualizado",
        connected_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select("id, waba_id, phone_number_id, display_phone_number, verified_name, status")
      .maybeSingle();

    if (dbError) throw new Error(dbError.message);
    return { account, updated: true };
  }

  const { data: account, error: dbError } = await supabase
    .from("whatsapp_business_accounts")
    .insert({
      waba_id: wabaId,
      phone_number_id: finalPhoneId,
      display_phone_number: displayPhone,
      verified_name: verifiedName,
      quality_rating: qualityRating,
      access_token: accessToken,
      meta_app_id: "",
      configuration_id: "",
      status: "connected",
      status_message: "Conectado con Access Token",
      connected_by: userId,
      connected_at: new Date().toISOString(),
    })
    .select("id, waba_id, phone_number_id, display_phone_number, verified_name, status")
    .maybeSingle();

  if (dbError) throw new Error(dbError.message);
  return { account, updated: false };
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
    const { action, access_token, waba_id, phone_number_id } = body;

    if (!access_token) {
      return jsonResponse({ error: "Access token es requerido" }, 400);
    }

    if (action === "discover") {
      const accounts = await discoverAccounts(access_token);
      return jsonResponse({ accounts });
    }

    if (action === "connect") {
      if (!waba_id) {
        return jsonResponse({ error: "WABA ID es requerido" }, 400);
      }

      const result = await connectAccount(
        access_token,
        waba_id,
        phone_number_id,
        user.id
      );

      return jsonResponse({
        success: true,
        account: result.account,
        updated: result.updated,
      });
    }

    return jsonResponse({ error: "Invalid action. Use 'discover' or 'connect'" }, 400);
  } catch (error) {
    console.error("WhatsApp connect error:", error);
    const message = error instanceof Error ? error.message : "Internal error";
    return jsonResponse({ error: message }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BROWSERLESS_BASE = "https://chrome.browserless.io";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];

interface ScreenshotRequest {
  project_id: string;
  pages: { name: string; url: string }[];
}

async function getBrowserlessToken(
  supabase: ReturnType<typeof createClient>
): Promise<string> {
  const { data } = await supabase
    .from("agent_secrets")
    .select("secret_value")
    .eq("service_name", "browserless")
    .maybeSingle();
  return data?.secret_value || "";
}

async function captureScreenshot(
  url: string,
  width: number,
  height: number,
  token: string
): Promise<Uint8Array> {
  const response = await fetch(
    `${BROWSERLESS_BASE}/screenshot?token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        options: { fullPage: true, type: "png" },
        gotoOptions: { waitUntil: "networkidle0", timeout: 30000 },
        viewport: { width, height },
        waitForTimeout: 2000,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`Browserless error (${response.status}): ${errorText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function uploadScreenshot(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  pageName: string,
  viewportName: string,
  version: number,
  buffer: Uint8Array
): Promise<string> {
  const safeName = pageName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const path = `${projectId}/${safeName}/v${version}-${viewportName}.png`;

  const { error } = await supabase.storage
    .from("qa-screenshots")
    .upload(path, buffer, { contentType: "image/png", upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData } = supabase.storage
    .from("qa-screenshots")
    .getPublicUrl(path);

  return urlData.publicUrl;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id, pages }: ScreenshotRequest = await req.json();

    if (!project_id || !pages || pages.length === 0) {
      return new Response(
        JSON.stringify({ error: "project_id and pages are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const token = await getBrowserlessToken(supabase);
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Browserless.io API key not configured" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: existingScreenshots } = await supabase
      .from("qa_screenshots")
      .select("page_name, version_number")
      .eq("project_id", project_id)
      .order("version_number", { ascending: false });

    const versionMap: Record<string, number> = {};
    for (const s of existingScreenshots || []) {
      if (!versionMap[s.page_name] || s.version_number > versionMap[s.page_name]) {
        versionMap[s.page_name] = s.version_number;
      }
    }

    await supabase.from("agent_logs").insert({
      project_id,
      action: `QA screenshot capture started for ${pages.length} page(s)`,
      category: "qa",
      severity: "info",
    });

    const results = [];

    for (const page of pages) {
      const version = (versionMap[page.name] || 0) + 1;
      const urls: Record<string, string> = {};

      for (const viewport of VIEWPORTS) {
        try {
          const buffer = await captureScreenshot(
            page.url,
            viewport.width,
            viewport.height,
            token
          );
          const publicUrl = await uploadScreenshot(
            supabase,
            project_id,
            page.name,
            viewport.name,
            version,
            buffer
          );
          urls[viewport.name] = publicUrl;
        } catch (err) {
          await supabase.from("agent_logs").insert({
            project_id,
            action: `Screenshot failed: ${page.name} (${viewport.name}): ${err instanceof Error ? err.message : String(err)}`,
            category: "qa",
            severity: "error",
          });
          urls[viewport.name] = "";
        }
      }

      const { data: screenshot } = await supabase
        .from("qa_screenshots")
        .insert({
          project_id,
          page_name: page.name,
          page_url: page.url,
          desktop_url: urls.desktop || "",
          tablet_url: urls.tablet || "",
          mobile_url: urls.mobile || "",
          status: "pending",
          version_number: version,
        })
        .select("id")
        .maybeSingle();

      results.push({
        page_name: page.name,
        screenshot_id: screenshot?.id,
        desktop_url: urls.desktop || "",
        tablet_url: urls.tablet || "",
        mobile_url: urls.mobile || "",
        version,
      });
    }

    await supabase.from("agent_logs").insert({
      project_id,
      action: `QA screenshots captured: ${results.length} page(s)`,
      category: "qa",
      severity: "success",
    });

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

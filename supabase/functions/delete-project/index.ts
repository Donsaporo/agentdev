import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DeleteRequest {
  project_id: string;
}

interface CleanupResult {
  service: string;
  success: boolean;
  message: string;
}

async function getSecret(
  supabase: ReturnType<typeof createClient>,
  serviceName: string
): Promise<string> {
  const { data } = await supabase
    .from("agent_secrets")
    .select("secret_value")
    .eq("service_name", serviceName)
    .maybeSingle();
  return data?.secret_value || "";
}

async function deleteVercelProject(
  vercelProjectId: string,
  token: string,
  teamId: string
): Promise<CleanupResult> {
  try {
    const params = new URLSearchParams();
    if (teamId) params.set("teamId", teamId);
    const qs = params.toString() ? `?${params.toString()}` : "";

    const res = await fetch(
      `https://api.vercel.com/v9/projects/${vercelProjectId}${qs}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (res.ok || res.status === 204 || res.status === 404) {
      return {
        service: "Vercel",
        success: true,
        message:
          res.status === 404
            ? "Project not found (already deleted)"
            : "Project deleted",
      };
    }

    const body = await res.text().catch(() => "");
    return {
      service: "Vercel",
      success: false,
      message: `HTTP ${res.status}: ${body}`,
    };
  } catch (err) {
    return {
      service: "Vercel",
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function deleteGitHubRepo(
  repoFullName: string,
  token: string
): Promise<CleanupResult> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.ok || res.status === 204 || res.status === 404) {
      return {
        service: "GitHub",
        success: true,
        message:
          res.status === 404
            ? "Repo not found (already deleted)"
            : "Repo deleted",
      };
    }

    const body = await res.text().catch(() => "");
    return {
      service: "GitHub",
      success: false,
      message: `HTTP ${res.status}: ${body}`,
    };
  } catch (err) {
    return {
      service: "GitHub",
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function deleteSupabaseProject(
  projectRef: string,
  managementToken: string
): Promise<CleanupResult> {
  try {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${managementToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (res.ok || res.status === 204 || res.status === 404) {
      return {
        service: "Supabase",
        success: true,
        message:
          res.status === 404
            ? "Project not found (already deleted)"
            : "Project deleted",
      };
    }

    const body = await res.text().catch(() => "");
    return {
      service: "Supabase (child)",
      success: false,
      message: `HTTP ${res.status}: ${body}`,
    };
  } catch (err) {
    return {
      service: "Supabase (child)",
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function deleteStorageFiles(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  bucket: string
): Promise<CleanupResult> {
  try {
    const { data: files } = await supabase.storage
      .from(bucket)
      .list(projectId, { limit: 1000 });

    if (files && files.length > 0) {
      const paths = files.map((f) => `${projectId}/${f.name}`);
      await supabase.storage.from(bucket).remove(paths);
    }

    const { data: subfolders } = await supabase.storage
      .from(bucket)
      .list(projectId);

    if (subfolders) {
      for (const folder of subfolders) {
        if (folder.id === null) {
          const { data: subFiles } = await supabase.storage
            .from(bucket)
            .list(`${projectId}/${folder.name}`, { limit: 1000 });
          if (subFiles && subFiles.length > 0) {
            const subPaths = subFiles.map(
              (f) => `${projectId}/${folder.name}/${f.name}`
            );
            await supabase.storage.from(bucket).remove(subPaths);
          }
        }
      }
    }

    return {
      service: `Storage (${bucket})`,
      success: true,
      message: "Files cleaned up",
    };
  } catch (err) {
    return {
      service: `Storage (${bucket})`,
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractRepoFullName(gitUrl: string): string | null {
  const match = gitUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id }: DeleteRequest = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: project } = await supabase
      .from("projects")
      .select("*")
      .eq("id", project_id)
      .maybeSingle();

    if (!project) {
      return new Response(
        JSON.stringify({ error: "Project not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const results: CleanupResult[] = [];

    const [vercelToken, vercelTeamId, githubToken, supabaseMgmtToken] =
      await Promise.all([
        getSecret(supabase, "vercel"),
        getSecret(supabase, "vercel_team_id"),
        getSecret(supabase, "github"),
        getSecret(supabase, "supabase_management"),
      ]);

    const cleanupPromises: Promise<CleanupResult>[] = [];

    if (project.vercel_project_id && vercelToken) {
      cleanupPromises.push(
        deleteVercelProject(project.vercel_project_id, vercelToken, vercelTeamId)
      );
    }

    if (project.git_repo_url && githubToken) {
      const repoFullName = extractRepoFullName(project.git_repo_url);
      if (repoFullName) {
        cleanupPromises.push(deleteGitHubRepo(repoFullName, githubToken));
      }
    }

    if (project.supabase_project_ref && supabaseMgmtToken) {
      cleanupPromises.push(
        deleteSupabaseProject(project.supabase_project_ref, supabaseMgmtToken)
      );
    }

    cleanupPromises.push(
      deleteStorageFiles(supabase, project_id, "qa-screenshots")
    );
    cleanupPromises.push(
      deleteStorageFiles(supabase, project_id, "brief-attachments")
    );

    const cleanupResults = await Promise.all(cleanupPromises);
    results.push(...cleanupResults);

    const { error: dbError } = await supabase
      .from("projects")
      .delete()
      .eq("id", project_id);

    if (dbError) {
      results.push({
        service: "Database",
        success: false,
        message: dbError.message,
      });
      return new Response(JSON.stringify({ results, error: dbError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    results.push({
      service: "Database",
      success: true,
      message: "Project and related records deleted",
    });

    await supabase.from("agent_logs").insert({
      project_id: null,
      action: `Project "${project.name}" fully deleted from all services`,
      category: "system",
      severity: "info",
      details: { project_name: project.name, results },
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

export interface Client {
  id: string;
  name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  industry: string;
  brand_colors: string[];
  brand_fonts: string[];
  notes: string;
  created_by: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  client_id: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  description: string;
  demo_url: string;
  production_url: string;
  vercel_project_id: string;
  git_repo_url: string;
  progress: number;
  technologies: string[];
  agent_status: AgentStatus;
  current_phase: ProjectPhase;
  has_backend: boolean;
  supabase_project_ref: string | null;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  last_error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  clients?: Client;
}

export type ProjectType = 'website' | 'ecommerce' | 'mobile_app' | 'crm' | 'custom';
export type ProjectStatus = 'draft' | 'planning' | 'in_progress' | 'qa' | 'review' | 'approved' | 'deployed';
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error';
export type ProjectPhase = 'analysis' | 'scaffolding' | 'backend_setup' | 'development' | 'completeness_check' | 'qa' | 'deployment';

export interface Brief {
  id: string;
  project_id: string;
  original_content: string;
  parsed_requirements: string[];
  pages_screens: string[];
  features: string[];
  questions: BriefQuestion[];
  answers: BriefAnswer[];
  status: BriefStatus;
  architecture_plan: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  projects?: Project;
}

export type BriefStatus = 'pending_review' | 'questions_pending' | 'approved' | 'in_progress' | 'processing' | 'completed' | 'failed';

export interface BriefQuestion {
  id: string;
  question: string;
  category: string;
  answered: boolean;
}

export interface BriefAnswer {
  question_id: string;
  answer: string;
  answered_by: string;
  answered_at: string;
}

export interface ProjectTask {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  order_index: number;
  error_log: string;
  screenshot_url: string;
  duration_seconds: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface AgentLog {
  id: string;
  project_id: string | null;
  action: string;
  category: string;
  details: Record<string, unknown>;
  severity: 'info' | 'warning' | 'error' | 'success';
  created_at: string;
}

export interface Domain {
  id: string;
  project_id: string | null;
  client_id: string;
  domain_name: string;
  subdomain: string;
  is_demo: boolean;
  dns_status: string;
  ssl_status: string;
  registrar: string;
  nameservers: string[];
  created_at: string;
  updated_at: string;
}

export interface AgentConversation {
  id: string;
  project_id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface QAScreenshot {
  id: string;
  project_id: string;
  task_id: string | null;
  page_name: string;
  page_url: string;
  desktop_url: string;
  tablet_url: string;
  mobile_url: string;
  status: 'pending' | 'approved' | 'rejected';
  rejection_notes: string;
  version_number: number;
  created_at: string;
}

export interface AgentConfig {
  default_model: string;
  auto_deploy: boolean;
  max_corrections: number;
  auto_qa: boolean;
  notification_email: string;
  supabase_org_id: string;
  supabase_db_region: string;
}

export interface ArchitectureDataField {
  name: string;
  type: 'uuid' | 'text' | 'integer' | 'numeric' | 'boolean' | 'timestamptz' | 'jsonb' | 'text[]';
  pk?: boolean;
  required?: boolean;
  unique?: boolean;
  default?: string;
  reference?: { table: string; column: string };
}

export interface ArchitectureDataModel {
  name: string;
  fields: ArchitectureDataField[];
  rls: {
    select: string;
    insert: string;
    update: string;
    delete: string;
  };
}

export interface ArchitectureUserRole {
  name: string;
  permissions: string[];
  description: string;
}

export interface ArchitectureFlow {
  name: string;
  role: string;
  steps: string[];
}

export interface ArchitectureFeature {
  name: string;
  pages: string[];
  role: string;
  description: string;
}

export interface ArchitecturePage {
  name: string;
  route: string;
  description: string;
  role?: string;
  module?: string;
  requiresAuth?: boolean;
}

export interface ArchitectureDesignSystem {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fonts: { heading: string; body: string };
  style: string;
}

export interface FullArchitecture {
  framework: string;
  styling: string;
  projectType: string;
  requiresBackend: boolean;
  userRoles: ArchitectureUserRole[];
  dataModels: ArchitectureDataModel[];
  features: ArchitectureFeature[];
  pages: ArchitecturePage[];
  flows: ArchitectureFlow[];
  components: { name: string; description: string }[];
  integrations: string[];
  auth: { providers: string[]; requiresVerification: boolean };
  storage: { buckets: string[] };
  designSystem: ArchitectureDesignSystem;
}

export interface FeatureModule {
  name: string;
  pages: ArchitecturePage[];
  role: string;
  description: string;
}

export interface BuildFixAttempt {
  errorHash: string;
  attempt: number;
  errorsText: string;
}

export interface QueueEvent {
  type: 'brief_approved' | 'chat_message' | 'qa_rejected';
  projectId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface ClaudeCodeResponse {
  files: GeneratedFile[];
  explanation: string;
  tokensUsed: { input: number; output: number };
}

export interface DeploymentResult {
  deploymentId: string;
  url: string;
  status: 'ready' | 'error' | 'building';
  buildLogs?: string;
}

export interface ScreenshotResult {
  pageName: string;
  pageUrl: string;
  desktopUrl: string;
  tabletUrl: string;
  mobileUrl: string;
}

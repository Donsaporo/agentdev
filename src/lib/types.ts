export interface TeamMember {
  id: string;
  full_name: string;
  role: string;
  avatar_url: string;
  created_at: string;
}

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
  supabase_project_name: string | null;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  last_error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  clients?: Client;
}

export type ProjectType = 'website' | 'landing' | 'ecommerce' | 'crm' | 'lms' | 'dashboard' | 'saas' | 'blog' | 'portfolio' | 'marketplace' | 'pwa' | 'custom';
export type ProjectStatus = 'draft' | 'planning' | 'in_progress' | 'qa' | 'review' | 'approved' | 'deployed';
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error';
export type ProjectPhase = 'analysis' | 'scaffolding' | 'backend_setup' | 'development' | 'completeness_check' | 'qa' | 'deployment' | 'aborted';

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

export interface Integration {
  id: string;
  project_id: string;
  service_name: string;
  service_type: string;
  config: Record<string, unknown>;
  status: string;
  documentation_url: string;
  notes: string;
  created_at: string;
}

export interface AgentLog {
  id: string;
  project_id: string | null;
  action: string;
  category: string;
  details: Record<string, unknown>;
  severity: 'info' | 'warning' | 'error' | 'success';
  created_at: string;
  projects?: Project;
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
  clients?: Client;
  projects?: Project;
}

export interface AgentConversation {
  id: string;
  project_id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  projects?: Project;
  last_message?: AgentMessage;
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
  status: QAScreenshotStatus;
  rejection_notes: string;
  version_number: number;
  created_at: string;
}

export type QAScreenshotStatus = 'pending' | 'approved' | 'rejected';

export interface BriefAttachment {
  id: string;
  brief_id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  file_size: number;
  processing_status: 'pending' | 'processed' | 'failed';
  extracted_content: string;
  created_at: string;
}

export interface AgentConfig {
  id: string;
  key: string;
  value: unknown;
  updated_at: string;
}

export interface AgentSecret {
  id: string;
  service_name: string;
  service_label: string;
  secret_value: string;
  masked_value: string;
  status: 'connected' | 'error' | 'untested';
  status_message: string;
  last_tested: string | null;
  created_at: string;
  updated_at: string;
}

export interface TokenUsage {
  id: string;
  project_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_estimate: number;
  operation: string;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  vercel_deployment_id: string;
  commit_sha: string;
  url: string;
  status: 'building' | 'ready' | 'error' | 'cancelled';
  build_duration_seconds: number;
  triggered_by: string;
  build_logs: string;
  created_at: string;
  projects?: Project;
}

export interface PipelineState {
  id: string;
  project_id: string;
  brief_id: string;
  current_phase: string;
  phase_data: Record<string, unknown>;
  modules_completed: string[];
  repo_full_name: string;
  started_at: string;
  last_checkpoint: string;
  status: 'running' | 'paused' | 'failed' | 'completed';
  created_at: string;
  projects?: Project;
}

export interface WhatsAppBusinessAccount {
  id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
  access_token: string;
  meta_app_id: string;
  configuration_id: string;
  provider: 'cloud_api' | '360dialog';
  channel_id: string;
  api_base_url: string;
  status: 'pending' | 'connected' | 'disconnected' | 'error';
  status_message: string;
  connected_by: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export type LeadStage =
  | 'nuevo'
  | 'en_proceso'
  | 'demo_solicitada'
  | 'cotizacion_enviada'
  | 'por_cerrar'
  | 'ganado'
  | 'perdido';

export interface ClientProfile {
  id: string;
  display_name: string;
  email: string;
  company: string;
  industry: string;
  estimated_budget: string;
  source: string;
  notes: string;
  crm_client_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppContact {
  id: string;
  wa_id: string;
  phone_number: string;
  display_name: string;
  profile_name: string;
  lead_stage: LeadStage;
  notes: string;
  email: string;
  company: string;
  crm_client_id: string | null;
  client_profile_id: string | null;
  assigned_team_member: string | null;
  is_imported: boolean;
  intro_sent: boolean;
  follow_up_count: number;
  created_at: string;
  updated_at: string;
  client_profile?: ClientProfile;
}

export type AgentMode = 'ai' | 'manual' | 'supervised';
export type ConversationCategory = 'new_lead' | 'active_client' | 'support' | 'escalated' | 'archived';

export interface WhatsAppConversation {
  id: string;
  contact_id: string;
  status: 'active' | 'closed' | 'archived';
  last_message_at: string;
  unread_count: number;
  agent_mode: AgentMode;
  agent_persona_id: string | null;
  category: ConversationCategory;
  last_message_preview: string;
  is_agent_typing: boolean;
  director_reviewed_at: string | null;
  director_notes: string;
  needs_director_attention: boolean;
  priority_score: number;
  last_inbound_at: string | null;
  window_expires_at: string | null;
  window_status: 'open' | 'closing_soon' | 'closed';
  created_at: string;
  updated_at: string;
  contact?: WhatsAppContact;
  persona?: SalesAgentPersona;
}

export interface WhatsAppMessage {
  id: string;
  conversation_id: string;
  contact_id: string;
  wa_message_id: string;
  direction: 'inbound' | 'outbound';
  message_type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'interactive' | 'template' | 'unsupported';
  content: string;
  media_url: string;
  media_mime_type: string;
  media_local_path: string | null;
  media_download_status: 'pending' | 'downloaded' | 'failed' | 'expired' | null;
  media_file_size: number | null;
  metadata: Record<string, unknown>;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  sender_name: string;
  created_at: string;
}

export interface InternalPhoneNumber {
  id: string;
  phone_number: string;
  role: string;
  name: string;
  created_at: string;
}

export interface SalesAgentPersona {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  job_title: string;
  communication_style: string;
  greeting_template: string;
  farewell_template: string;
  signature: string;
  avatar_url: string;
  personality_traits: string[];
  response_length_preference: string;
  emoji_usage: string;
  formality_level: string;
  is_active: boolean;
  total_conversations: number;
  total_messages_sent: number;
  team_member_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SalesAgentFeedback {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  feedback_type: 'correction' | 'instruction' | 'new_knowledge' | 'praise';
  content: string;
  status: 'pending' | 'processed' | 'incorporated';
  created_by: string;
  processed_at: string | null;
  resulting_instruction_id: string | null;
  created_at: string;
}

export interface SalesAgentInstruction {
  id: string;
  instruction: string;
  priority: 'critical' | 'high' | 'normal';
  category: string;
  is_active: boolean;
  source_feedback_id: string | null;
  persona_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SalesEscalation {
  id: string;
  conversation_id: string;
  contact_id: string | null;
  reason: string;
  priority: 'critical' | 'high' | 'normal';
  status: 'open' | 'attended' | 'resolved';
  assigned_to: string | null;
  resolved_at: string | null;
  resolution_notes: string;
  created_at: string;
  conversation?: WhatsAppConversation;
  contact?: WhatsAppContact;
}

export interface SalesAgentActionLog {
  id: string;
  action_type: string;
  conversation_id: string | null;
  contact_id: string | null;
  persona_id: string | null;
  input_summary: string;
  output_summary: string;
  model_used: string;
  tokens_input: number;
  tokens_output: number;
  duration_ms: number;
  success: boolean;
  error_message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SalesMeeting {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
  google_event_id: string | null;
  title: string;
  start_time: string;
  end_time: string;
  meet_link: string;
  recall_bot_id: string | null;
  transcript: string | null;
  summary: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

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
  created_by: string | null;
  created_at: string;
  updated_at: string;
  clients?: Client;
}

export type ProjectType = 'website' | 'ecommerce' | 'mobile_app' | 'crm' | 'custom';
export type ProjectStatus = 'draft' | 'planning' | 'in_progress' | 'qa' | 'review' | 'approved' | 'deployed';
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error';
export type ProjectPhase = 'analysis' | 'scaffolding' | 'development' | 'qa' | 'deployment';

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

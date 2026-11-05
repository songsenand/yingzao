// Pearl/template manifests (M1, static planner).
//
// A pearl is a fixed decision point; a template is one readable implementation of it.
// The planner only computes steps/budget/coverage — it never calls a tool.

export interface PearlBudget {
  maxDistinctTools: number;
  maxCalls: number;
  maxCostSeconds: number;
  maxProbe: 1;
}

export interface PearlProbeSlot {
  required: boolean;
  criteria: string[];
  allowed: string[];
}

export interface PearlManifest {
  schemaVersion: 1;
  id: string;
  guide?: string;
  undeclaredPolicy?: 'warn' | 'block';
  version: string;
  question: string;
  exit: string[];
  not: string[];
  templates: string[];
  budget: PearlBudget;
  probe: PearlProbeSlot;
}

export type BindingSource = 'project' | 'input' | 'step' | 'contract' | 'failure';

export interface StepBinding {
  from: BindingSource;
  /** Dot path into that source, e.g. "assembly.path" or "gap.aVersionId". */
  path: string;
  /** Missing value keeps the literal arg/default instead of blocking. */
  optional?: boolean;
}

export interface TemplateStep {
  id: string;
  tool: string;
  /** Literal tool args. */
  args?: Record<string, unknown>;
  /** Values resolved from the project/inputs/previous step/contract/failure. */
  bind?: Record<string, StepBinding>;
  when?: string;
}

export interface TemplateOnFail {
  when: string;
  goto: string;
  with?: string;
  /** transient = same-input retry; repair = adjust then rerun; unrecoverable = stop. */
  kind?: 'transient' | 'repair' | 'unrecoverable';
}

export interface PearlTemplate {
  schemaVersion: 1;
  id: string;
  pearl: string;
  version: string;
  when: string;
  steps: TemplateStep[];
  parallel?: string[][];
  /** Self-return allowance; the global repair policy still caps rounds at 4 and stops on no-progress. */
  retry?: number;
  exit: string;
  on_fail: TemplateOnFail[];
}

export interface PlanIssue {
  code: string;
  message: string;
}

export interface PearlPlan {
  pearl: string;
  template: string;
  status: 'planned' | 'blocked';
  budgetUsed: { distinctTools: number; calls: number; probe: number };
  steps: { id: string; tool: string; when?: string; args?: Record<string, unknown>; bind?: Record<string, StepBinding>; parallelWith: string[] }[];
  distinctTools: number;
  calls: number;
  budget: PearlBudget;
  issues: PlanIssue[];
}

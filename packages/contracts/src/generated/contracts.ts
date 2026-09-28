/* Generated from immutable JSON Schemas. Do not edit. */

/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "CompetencyEstimate".
 */
export type CompetencyEstimate = ({
[k: string]: any
} & {
competency_id: string
mastery_state: ("unknown" | "needs_foundation" | "developing" | "demonstrated")
evidence_sufficiency: ("insufficient" | "limited" | "sufficient")
policy_version: string
/**
 * @minItems 0
 */
evidence_ids: string[]
/**
 * @minItems 0
 */
passed_criteria: string[]
/**
 * @minItems 0
 */
failed_criteria: string[]
/**
 * @minItems 0
 */
unobserved_criteria: string[]
open_conflict: boolean
evaluated_at: string
})
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "StepReason".
 */
export type StepReason = ({
[k: string]: any
} & {
kind: ("GAP" | "PREREQUISITE_CHECK" | "EXPLORATION" | "NEW_GOAL" | "PRACTICE" | "FINAL_ASSESSMENT")
explanation: string
/**
 * @minItems 0
 */
evidence_ids: string[]
assumption_reason: (string | null)
})
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "AnswerSubmission".
 */
export type AnswerSubmission = {
[k: string]: any
}

export interface MAXCommonContractsRelease40 {
[k: string]: any
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "Constraints".
 */
export interface Constraints {
age_group: string
role: ("SCHOOL" | "STUDENT")
device: ("PHONE" | "TABLET" | "DESKTOP" | "UNKNOWN")
/**
 * @minItems 0
 */
tools: string[]
session_minutes: (number | null)
weekly_minutes: (number | null)
deadline: (string | null)
language: string
paid_resources_allowed: (boolean | null)
preferred_format: (string | null)
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "Evidence".
 */
export interface Evidence {
evidence_id: string
user_id: string
competency_id: string
criterion_id: string
observed_result: ("PASS" | "PARTIAL" | "FAIL" | "NOT_ASSESSED")
evidence_kind: ("CHOICE" | "EXPLANATION" | "PRACTICE" | "SELF_REPORT")
task_family_id: string
task_version_id: string
rubric_version: string
difficulty: number
assistance_level: ("NONE" | "HINT" | "SOLUTION")
assessment_kind: ("LOCAL" | "INTEGRATIVE")
source_ref: string
status: ("ACTIVE" | "REVOKED" | "SUPERSEDED" | "RESOLVED")
created_at: string
evidence_excerpt: (string | null)
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "MasteryPolicy".
 */
export interface MasteryPolicy {
policy_version: string
competency_id: string
/**
 * @minItems 1
 */
required_criteria: [string, ...(string)[]]
required_independent_families: number
minimum_difficulty: number
/**
 * @minItems 1
 */
allowed_assistance: [("NONE" | "HINT" | "SOLUTION"), ...(("NONE" | "HINT" | "SOLUTION"))[]]
validity_days: number
requires_integrative_task: boolean
/**
 * @minItems 1
 */
compatible_rubric_versions: [string, ...(string)[]]
/**
 * @minItems 0
 */
foundation_criteria: string[]
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "DiagnosticContext".
 */
export interface DiagnosticContext {
schema_version: "4.0"
session_id: string
problem_id: string
problem_version: number
profile_version: number
evidence_revision: number
goal_type: ("DIRECTION" | "KNOWLEDGE_GAP" | "SKILL" | "PRACTICE_READINESS")
confirmed_goal: string
completeness: ("COMPLETED" | "COMPLETED_PARTIAL")
/**
 * @minItems 0
 */
competencies: CompetencyEstimate[]
/**
 * @minItems 0
 */
interests: {
label: string
source: "self_report"
}[]
constraints: Constraints
/**
 * @minItems 0
 */
evidence_ids: string[]
/**
 * @minItems 0
 */
unresolved_questions: string[]
recommended_entry: {
competency_id: string
reason: StepReason
}
/**
 * @minItems 0
 */
method_versions: string[]
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "CourseCompletionPolicy".
 */
export interface CourseCompletionPolicy {
policy_version: string
/**
 * @minItems 1
 */
target_competency_ids: [string, ...(string)[]]
/**
 * @minItems 1
 */
mastery_policy_versions: [string, ...(string)[]]
/**
 * @minItems 0
 */
required_integrative_task_ids: string[]
allow_compatible_prior_evidence: boolean
block_on_required_evidence_dispute: boolean
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "RoutePlan".
 */
export interface RoutePlan {
schema_version: "4.0"
course_id: string
route_version_id: string
goal_id: string
problem_version: number
catalog_version: string
policy_version: string
/**
 * @minItems 1
 */
steps: [{
step_id: string
/**
 * @minItems 1
 */
competency_ids: [string, ...(string)[]]
/**
 * @minItems 0
 */
prerequisite_step_ids: string[]
block_id: string
material_version_id: string
task_version_id: string
reason: StepReason
estimated_minutes: number
}, ...({
step_id: string
/**
 * @minItems 1
 */
competency_ids: [string, ...(string)[]]
/**
 * @minItems 0
 */
prerequisite_step_ids: string[]
block_id: string
material_version_id: string
task_version_id: string
reason: StepReason
estimated_minutes: number
})[]]
completion_policy: CourseCompletionPolicy
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "BuildRequest".
 */
export interface BuildRequest {
schema_version: "4.0"
request_id: string
idempotency_key: string
course_id: string
problem_version: number
profile_version: number
evidence_revision: number
catalog_version: string
policy_version: string
expected_active_route_version: (string | null)
diagnostic_context: DiagnosticContext
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "PublishDecision".
 */
export interface PublishDecision {
request_id: string
job_state: ("SUCCEEDED" | "SUPERSEDED" | "FAILED_FINAL")
route_version_id: (string | null)
course_version_id: (string | null)
/**
 * @minItems 0
 */
mismatched_fields: string[]
active_pair_changed: boolean
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
code: string
message: string
request_id: string
retryable: boolean
current_revision: (number | null)
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "PublicQuestion".
 */
export interface PublicQuestion {
question_instance_id: string
session_revision: number
question_kind: ("SINGLE_CHOICE" | "MULTI_CHOICE" | "SHORT_TEXT" | "PRACTICAL_TEXT" | "PREFERENCE")
prompt: string
/**
 * @minItems 0
 */
options: {
id: string
label: string
}[]
/**
 * @minItems 0
 */
public_criteria: string[]
estimated_seconds: number
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "JobAccepted".
 */
export interface JobAccepted {
job_id: string
status: ("QUEUED" | "RUNNING")
polling_url: string
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "DiagnosticSessionCreate".
 */
export interface DiagnosticSessionCreate {
problem_id: string
problem_version: number
profile_version: number
idempotency_key: string
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "ProblemInput".
 */
export interface ProblemInput {
raw_text: string
confirmed_goal: (string | null)
goal_type: (("DIRECTION" | "KNOWLEDGE_GAP" | "SKILL" | "PRACTICE_READINESS") | null)
expected_revision: (number | null)
idempotency_key: string
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "VersionAction".
 */
export interface VersionAction {
expected_revision: number
idempotency_key: string
reason: (string | null)
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "AttemptInput".
 */
export interface AttemptInput {
task_version_id: string
route_version_id: string
client_request_id: string
answer_text: (string | null)
/**
 * @minItems 0
 */
attachment_ids: string[]
assistance_reported: ("NONE" | "HINT" | "SOLUTION")
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "ObjectRef".
 */
export interface ObjectRef {
id: string
revision: number
status: string
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "Review".
 */
export interface Review {
review_id: string
attempt_id: string
rubric_version: string
status: ("GRADED" | "NEEDS_REVIEW" | "REVOKED")
task_result: ("PASS" | "PARTIAL" | "FAIL" | "NOT_ASSESSED")
/**
 * @minItems 0
 */
criterion_results: {
criterion_id: string
result: ("PASS" | "PARTIAL" | "FAIL" | "NOT_ASSESSED")
evidence_excerpt: (string | null)
}[]
/**
 * @minItems 0
 */
evidence_ids: string[]
explanation: string
evidence_revision: number
}
/**
 * This interface was referenced by `MAXCommonContractsRelease40`'s JSON-Schema
 * via the `definition` "DiagnosticSessionState".
 */
export interface DiagnosticSessionState {
id: string
revision: number
status: ("CREATED" | "PLANNED" | "IN_PROGRESS" | "ANALYZING" | "COMPLETED" | "COMPLETED_PARTIAL" | "PAUSED" | "NEEDS_REVIEW" | "FAILED_RETRYABLE" | "SUPERSEDED" | "CANCELLED")
question: (PublicQuestion | null)
/**
 * @minItems 0
 */
completed_areas: string[]
/**
 * @minItems 0
 */
remaining_areas: string[]
}

/**
 * This interface was referenced by `VibeWorkPhase1Contracts`'s JSON-Schema
 * via the `definition` "JobState".
 */
export type JobState = ("QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "DEAD_LETTERED")

export interface VibeWorkPhase1Contracts {
[k: string]: any
}
/**
 * This interface was referenced by `VibeWorkPhase1Contracts`'s JSON-Schema
 * via the `definition` "JobFailure".
 */
export interface JobFailure {
code: string
message: string
}
/**
 * This interface was referenced by `VibeWorkPhase1Contracts`'s JSON-Schema
 * via the `definition` "JobStatusResponse".
 */
export interface JobStatusResponse {
job_id: string
state: JobState
attempts_made: number
retryable: boolean
failure: (JobFailure | null)
}

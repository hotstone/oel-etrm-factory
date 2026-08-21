import { Agent, BedrockModel } from "@strands-agents/sdk";
import { z } from "zod";
import { CONFIG } from "./config.js";
import type { LinearIssue } from "./linear.js";

export const AssessmentSchema = z.object({
  suitable: z.boolean().describe("Whether this ticket is well-specified enough for automated implementation"),
  confidence: z.number().min(0).max(1),
  missingInfo: z.array(z.string()).describe("Questions that must be answered before work can start; empty if none"),
  acceptanceCriteria: z.array(z.string()).describe("Concrete, testable criteria distilled from the ticket"),
  affectedAreas: z.array(z.string()).describe("Files or modules likely involved, if inferable"),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const CritiqueSchema = z.object({
  approved: z.boolean().describe("True if the plan faithfully covers the acceptance criteria with no material gaps"),
  objections: z.array(
    z.object({
      severity: z.enum(["blocking", "minor"]),
      objection: z.string(),
    }),
  ),
});
export type Critique = z.infer<typeof CritiqueSchema>;

function lightModel(): BedrockModel {
  return new BedrockModel({ region: CONFIG.region, modelId: CONFIG.models.light, maxTokens: 2048 });
}

/** One-call ticket gate: is this issue actionable, and what are the criteria? */
export function makeAnalyzer(): Agent {
  return new Agent({
    id: "analyzer",
    printer: false,
    model: lightModel(),
    structuredOutputSchema: AssessmentSchema,
    systemPrompt: `You assess issue tickets for automated implementation by a coding agent
against a TypeScript library. A ticket is suitable only if a competent engineer could start
work without asking questions: the intended behavior is unambiguous and testable. Distill
concrete acceptance criteria. If information is missing, list precise questions — do not
guess the author's intent. Vague aspirations ("make it better") are not suitable.`,
  });
}

/** One-call adversarial plan review against the acceptance criteria. */
export function makeAdversary(): Agent {
  return new Agent({
    id: "adversary",
    printer: false,
    model: lightModel(),
    structuredOutputSchema: CritiqueSchema,
    systemPrompt: `You adversarially review implementation plans. Your job is to refute:
find mismatches between the plan and the acceptance criteria, unhandled cases, and scope
creep. Judge only plan-vs-requirements — not style. Mark an objection "blocking" only if
following the plan as written would fail a stated acceptance criterion; everything else is
"minor". If the plan faithfully covers the criteria, approve it — do not invent objections.`,
  });
}

export function analyzerPrompt(issue: LinearIssue): string {
  const comments = issue.comments.length
    ? `\n\nComments:\n${issue.comments.map((c) => `- ${c.author}: ${c.body}`).join("\n")}`
    : "";
  return `Assess this ticket:\n\n# ${issue.identifier}: ${issue.title}\n\n${issue.description}${comments}`;
}

export function adversaryPrompt(assessment: Assessment, plan: string): string {
  return `Acceptance criteria:\n${assessment.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Implementation plan to review:
${plan}`;
}

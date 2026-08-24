import { Agent, BedrockModel } from "@strands-agents/sdk";
import { z } from "zod";
import { CONFIG } from "./config.js";
import type { Finding } from "./findings.js";
import type { Lesson } from "./memory.js";

export const CuratorSchema = z.object({
  decisions: z.array(
    z.object({
      finding: z.number().describe("Index of the finding this decision is about"),
      action: z.enum(["drop", "new_lesson", "reinforce"]),
      lessonText: z
        .string()
        .optional()
        .describe("For new_lesson: the generalized, transferable rule (not the ticket-specific instance)"),
      reinforceLessonId: z
        .string()
        .optional()
        .describe("For reinforce: the id of the existing lesson this finding re-confirms"),
      repoChangeSuggestion: z
        .string()
        .optional()
        .describe("If the rule is mechanically checkable, the lint rule / test / CLAUDE.md line that would enforce it"),
    }),
  ),
});
export type CuratorDecisions = z.infer<typeof CuratorSchema>;

export function makeCurator(): Agent {
  return new Agent({
    id: "curator",
    printer: false,
    model: new BedrockModel({ region: CONFIG.region, modelId: CONFIG.models.light, maxTokens: 3000 }),
    structuredOutputSchema: CuratorSchema,
    systemPrompt: `You curate long-term lessons from code-review findings so an automated
pipeline avoids repeating mistakes. For each finding decide:
- "drop": one-off slips, typos, or anything with no transferable rule.
- "new_lesson": there is a transferable rule AND no existing lesson covers it. Write
  lessonText as the general rule a future engineer should know — name modules or
  behaviours, never ticket numbers. One sentence or two.
- "reinforce": an existing lesson (listed with its id) already covers this — name it.
Prefer reinforce over near-duplicate new lessons; duplicates poison retrieval. If the
rule could be enforced by a lint rule, a test, or a CLAUDE.md instruction in the target
repo, set repoChangeSuggestion — a guarantee beats a reminder. Be selective: most
findings should be dropped; memory is for recurring, judgment-requiring knowledge.`,
  });
}

export function curatorPrompt(
  findings: (Finding & { resolution: string })[],
  existing: Lesson[],
): string {
  const findingList = findings
    .map((f, i) => `${i}. [${f.severity}, run outcome: ${f.resolution}] ${f.text}`)
    .join("\n");
  const existingList = existing.length
    ? existing.map((l) => `- id=${l.memoryRecordId}: ${l.text}`).join("\n")
    : "(none)";
  return `Review findings from the latest pipeline run:
${findingList}

Existing lessons already in memory (reinforce these rather than duplicating):
${existingList}`;
}

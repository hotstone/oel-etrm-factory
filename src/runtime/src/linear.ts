import { CONFIG } from "./config.js";
import { linearApiKey } from "./secrets.js";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  comments: { body: string; author: string }[];
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = await linearApiKey();
  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  // Linear occasionally emits raw control characters inside JSON string values
  // (observed in comment bodies), which strict parsers reject. Parse strictly
  // first; on failure, escape bare control chars inside string literals and retry.
  const text = await resp.text();
  let data: { data?: T; errors?: { message: string }[] };
  try {
    data = JSON.parse(text);
  } catch {
    const sanitized = text.replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
      str.replace(/[\u0000-\u001f]/g, (c) =>
        c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : "",
      ),
    );
    data = JSON.parse(sanitized);
  }
  if (data.errors?.length) throw new Error(`Linear API error: ${data.errors[0]?.message}`);
  if (!data.data) throw new Error("Linear API returned no data");
  return data.data;
}

/** Fetch an issue by identifier (e.g. "HOT-50") or UUID. */
export async function fetchIssue(idOrIdentifier: string): Promise<LinearIssue> {
  const data = await gql<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      url: string;
      comments: { nodes: { body: string; user: { name: string } | null }[] };
    };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        id identifier title description url
        comments { nodes { body user { name } } }
      }
    }`,
    { id: idOrIdentifier },
  );
  const issue = data.issue;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    url: issue.url,
    comments: issue.comments.nodes.map((c) => ({ body: c.body, author: c.user?.name ?? "unknown" })),
  };
}

/** Create an issue (used by the eval harness); returns id + identifier. */
export async function createIssue(title: string, body: string): Promise<{ id: string; identifier: string }> {
  const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } } }>(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
    { input: { teamId: CONFIG.linear.teamId, title, description: body } },
  );
  if (!data.issueCreate.success) throw new Error("issueCreate failed");
  return data.issueCreate.issue;
}

/** Archive an issue (eval cleanup). */
export async function archiveIssue(issueId: string): Promise<void> {
  await gql(`mutation($id: String!) { issueArchive(id: $id) { success } }`, { id: issueId });
}

export async function commentOnIssue(issueId: string, body: string): Promise<void> {
  await gql(
    `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId, body } },
  );
}

/** Replace the agent-* labels on an issue with the given one, preserving other labels. */
export async function setAgentLabel(
  issueId: string,
  label: keyof typeof CONFIG.linear.labels | null,
): Promise<void> {
  const data = await gql<{ issue: { labels: { nodes: { id: string }[] } } }>(
    `query($id: String!) { issue(id: $id) { labels { nodes { id } } } }`,
    { id: issueId },
  );
  const agentLabelIds = new Set<string>(Object.values(CONFIG.linear.labels));
  const kept = data.issue.labels.nodes.map((l) => l.id).filter((id) => !agentLabelIds.has(id));
  if (label) kept.push(CONFIG.linear.labels[label]);
  await gql(
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issueId, input: { labelIds: kept } },
  );
}

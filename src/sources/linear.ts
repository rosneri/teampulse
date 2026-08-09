import type { People } from "../config";
import type { Activity, OpenIssue } from "../types";
import { classify } from "../worktype";

const ENDPOINT = "https://api.linear.app/graphql";

async function linear<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    // Personal API keys go in Authorization bare — no "Bearer" prefix.
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as any;
  if (json.errors) throw new Error(`linear: ${json.errors.map((e: any) => e.message).join("; ")}`);
  return json.data;
}

type RelayConnection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

/** Walks a Relay connection to the end. */
async function paginate<T>(
  query: string,
  variables: Record<string, unknown>,
  field: string,
): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | null = null;
  do {
    const data: Record<string, RelayConnection<T>> = await linear(query, { ...variables, after });
    const connection: RelayConnection<T> | undefined = data[field];
    if (!connection) throw new Error(`linear: response has no "${field}" field`);
    nodes.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

const ISSUES = `
  query Issues($since: DateTimeOrDuration!, $after: String) {
    issues(filter: { updatedAt: { gte: $since } }, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title url createdAt completedAt
        creator { id } assignee { id }
        state { type name }
        labels { nodes { name } }
      }
    }
  }`;

const COMMENTS = `
  query Comments($since: DateTimeOrDuration!, $after: String) {
    comments(filter: { createdAt: { gte: $since } }, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id body createdAt url
        user { id }
        issue { identifier title }
      }
    }
  }`;

const OPEN = `
  query Open($after: String) {
    issues(
      filter: { state: { type: { nin: ["completed", "canceled"] } }, assignee: { null: false } }
      first: 100
      after: $after
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title url updatedAt priority
        assignee { id }
        state { name }
        project { id name }
        labels { nodes { name } }
      }
    }
  }`;

/**
 * Initiatives are asked for separately rather than through `project.initiatives`
 * because they are a paid-plan feature: on a workspace without them the field
 * does not resolve, and folding it into the query above would cost the whole
 * open-issue snapshot rather than one optional column. Its failure is swallowed
 * for the same reason — an issue with no initiative and a workspace with no
 * initiatives are the same absence downstream.
 */
const INITIATIVES = `
  query Initiatives($after: String) {
    initiatives(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id name projects { nodes { id } } }
    }
  }`;

async function initiativeByProject(): Promise<Map<string, string>> {
  const byProject = new Map<string, string>();
  try {
    for (const initiative of await paginate<any>(INITIATIVES, {}, "initiatives")) {
      for (const project of initiative.projects?.nodes ?? []) {
        byProject.set(project.id, initiative.name);
      }
    }
  } catch {
    // Left empty on purpose: see the comment on INITIATIVES.
  }
  return byProject;
}

const labelsOf = (n: any): string[] => (n.labels?.nodes ?? []).map((l: any) => l.name);

export async function collectLinear(people: People, since: Date): Promise<Activity[]> {
  const iso = since.toISOString();
  const out: Activity[] = [];

  for (const issue of await paginate<any>(ISSUES, { since: iso }, "issues")) {
    const workType = classify(issue.title, labelsOf(issue));
    const base = {
      source: "linear" as const,
      workType,
      url: issue.url,
      title: `${issue.identifier} ${issue.title}`,
      meta: { identifier: issue.identifier, state: issue.state?.name },
    };

    const creator = issue.creator?.id && people.byLinear.get(issue.creator.id);
    if (creator && issue.createdAt && new Date(issue.createdAt) >= since) {
      out.push({ ...base, id: `linear:issue_created:${issue.id}`, type: "issue_created", personId: creator, ts: issue.createdAt });
    }

    // Completion is credited to the assignee — the person who did the work.
    const assignee = issue.assignee?.id && people.byLinear.get(issue.assignee.id);
    if (assignee && issue.completedAt && new Date(issue.completedAt) >= since) {
      out.push({ ...base, id: `linear:issue_completed:${issue.id}`, type: "issue_completed", personId: assignee, ts: issue.completedAt });
    }
  }

  for (const c of await paginate<any>(COMMENTS, { since: iso }, "comments")) {
    const personId = c.user?.id && people.byLinear.get(c.user.id);
    if (!personId) continue;
    out.push({
      id: `linear:issue_commented:${c.id}`,
      source: "linear",
      type: "issue_commented",
      personId,
      ts: c.createdAt,
      url: c.url,
      title: c.issue ? `${c.issue.identifier} ${c.issue.title}` : undefined,
      body: c.body,
      meta: { identifier: c.issue?.identifier },
    });
  }

  return out;
}

export async function collectOpenIssues(people: People): Promise<OpenIssue[]> {
  const initiatives = await initiativeByProject();
  const out: OpenIssue[] = [];
  for (const i of await paginate<any>(OPEN, {}, "issues")) {
    const personId = i.assignee?.id && people.byLinear.get(i.assignee.id);
    if (!personId) continue;
    out.push({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      personId,
      state: i.state?.name ?? "",
      workType: classify(i.title, labelsOf(i)),
      priority: i.priority ?? 0,
      projectName: i.project?.name ?? null,
      initiativeName: (i.project?.id && initiatives.get(i.project.id)) ?? null,
      updatedAt: i.updatedAt,
    });
  }
  return out;
}

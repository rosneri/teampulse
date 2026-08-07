import type { People } from "../config";
import type { Activity } from "../types";

/**
 * Notion pages, as edits.
 *
 * The ceiling is Notion's own: a page carries `created_by` and `last_edited_by`
 * and nothing in between. Ten edits by one person across a week collapse into
 * one "edited" row at the latest timestamp, and an earlier editor who was later
 * overwritten leaves no trace at all. This is a floor on documentation work, not
 * a measure of it — the dashboard says so where the number is shown.
 */

const API = "https://api.notion.com/v1";

// Pinned rather than "latest": the search response shape below is this version's,
// and a silent upgrade would change it underneath us.
const NOTION_VERSION = "2022-06-28";

async function notion(path: string, body: unknown): Promise<any> {
  const token = process.env.NOTION_API_KEY;
  if (!token) throw new Error("NOTION_API_KEY not set");

  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as any;
  if (!response.ok) throw new Error(`notion ${path}: ${json?.message ?? response.statusText}`);
  return json;
}

/** The page's title, wherever this database chose to put it. */
function titleOf(page: any): string | undefined {
  const properties = Object.values(page.properties ?? {}) as any[];
  const title = properties.find((property) => property?.type === "title");
  const text = (title?.title ?? []).map((part: any) => part?.plain_text ?? "").join("");
  return text || undefined;
}

export async function collectNotion(people: People, since: Date): Promise<Activity[]> {
  const out: Activity[] = [];
  let cursor: string | undefined;
  // A page whose editor is nobody we know looks exactly like a workspace with no
  // pages in it — from the sync line, both are "0 events". Count them apart.
  const unknownEditors = new Set<string>();
  let pagesSeen = 0;

  // Newest edit first, so the walk can stop at the window's edge rather than
  // paging through the entire workspace every sync.
  let reachedWindowEdge = false;
  do {
    const page = await notion("/search", {
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
      start_cursor: cursor,
    });

    for (const result of page.results ?? []) {
      const editedAt = result.last_edited_time as string | undefined;
      if (!editedAt) continue;
      // Sorted descending: everything after this is older. Break rather than
      // return — an early return would skip the diagnostics below, which is
      // exactly the silent zero they exist to prevent.
      if (new Date(editedAt) < since) {
        reachedWindowEdge = true;
        break;
      }

      pagesSeen++;
      const title = titleOf(result);
      for (const id of [result.last_edited_by?.id, result.created_by?.id]) {
        if (id && !people.byNotion.has(id)) unknownEditors.add(id);
      }
      const base = { source: "notion" as const, url: result.url, title };

      const editor = result.last_edited_by?.id && people.byNotion.get(result.last_edited_by.id);
      if (editor) {
        // The id carries the timestamp: one row per page per edit *time*, so a page
        // edited again tomorrow is a second row rather than a lost one.
        out.push({
          ...base,
          id: `notion:doc_edited:${result.id}:${editedAt}`,
          type: "doc_edited",
          personId: editor,
          ts: editedAt,
          meta: { pageId: result.id },
        });
      }

      const createdAt = result.created_time as string | undefined;
      const author = result.created_by?.id && people.byNotion.get(result.created_by.id);
      if (author && createdAt && new Date(createdAt) >= since) {
        out.push({
          ...base,
          id: `notion:doc_created:${result.id}`,
          type: "doc_created",
          personId: author,
          ts: createdAt,
          meta: { pageId: result.id },
        });
      }
    }

    cursor = reachedWindowEdge || !page.has_more ? undefined : page.next_cursor;
  } while (cursor);

  if (!out.length && pagesSeen) {
    console.warn(
      `  notion: ${pagesSeen} pages in the window, none by anybody in people.yaml. ` +
        `Add \`notion:\` ids — these are the user ids that edited them: ` +
        `${[...unknownEditors].slice(0, 10).join(", ")}`,
    );
  }
  if (!pagesSeen) {
    console.warn(
      "  notion: the integration can see no pages at all — share the pages or " +
        "databases with it in Notion; a token alone grants it nothing",
    );
  }

  return out;
}

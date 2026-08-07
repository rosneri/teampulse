/**
 * The filter state a reader can pin as their default view. Kept in the
 * browser's own storage: it is one person's preference on one machine, not a
 * fact about the team, so it has no business in the database or people.yaml.
 *
 * Storage is passed in rather than reached for, so the parsing below can be
 * tested without a browser.
 */

export type SavedView = {
  /** A window the date filter offers: "7d", "30d", "90d". */
  range: string;
  /** A repository name, or "" for all of them. */
  repository: string;
  hideWeekends: boolean;
};

/** What the dashboard opens on when nothing has been saved. */
export const BUILT_IN_VIEW: SavedView = {
  range: "30d",
  repository: "",
  hideWeekends: true,
};

const STORAGE_KEY = "teampulse.defaultView";

/**
 * Anything stored can have been hand-edited or written by an older version, so
 * a value that is not a complete, well-typed view is discarded rather than
 * half-applied — a dashboard opening on a garbled scope is worse than one
 * opening on the built-in default.
 */
function parseSavedView(raw: string): SavedView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.range !== "string" || candidate.range === "") return null;
  if (typeof candidate.repository !== "string") return null;
  if (typeof candidate.hideWeekends !== "boolean") return null;

  return {
    range: candidate.range,
    repository: candidate.repository,
    hideWeekends: candidate.hideWeekends,
  };
}

export function readSavedView(storage: Storage | undefined): SavedView | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw === null ? null : parseSavedView(raw);
  } catch {
    // Private browsing and blocked storage both throw on access rather than
    // returning null. A missing preference is not worth a broken page.
    return null;
  }
}

export function writeSavedView(storage: Storage | undefined, view: SavedView): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(view));
    return true;
  } catch {
    return false;
  }
}

export function clearSavedView(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: the preference simply stays.
  }
}

export function sameView(left: SavedView, right: SavedView): boolean {
  return (
    left.range === right.range &&
    left.repository === right.repository &&
    left.hideWeekends === right.hideWeekends
  );
}

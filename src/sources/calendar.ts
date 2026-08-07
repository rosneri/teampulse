import { JWT } from "google-auth-library";
import type { People, Person } from "../config";
import type { Activity } from "../types";

/**
 * Meetings, from each person's own Google Calendar.
 *
 * The only source that reports real *duration*: every other event in this
 * database is an instant, and a meeting is the one thing we can say a person was
 * demonstrably occupied for. That is why `endsAt` exists on Activity at all.
 *
 * Reads through a service account with domain-wide delegation, impersonating
 * each person's work email. That is what lets it see a teammate's 1:1 the tool
 * owner was never invited to — the alternative, a single OAuth login, only ever
 * sees its own calendar and would quietly under-report everyone else.
 */

const API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

/**
 * `GOOGLE_SERVICE_ACCOUNT_JSON` holds the key itself or a path to it. Both are
 * accepted because a JSON blob survives a container environment and a path
 * survives a developer's laptop, and neither is worth making the other's problem.
 */
async function serviceAccount(): Promise<{ client_email: string; private_key: string }> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");

  const text = raw.trim().startsWith("{") ? raw : await Bun.file(raw).text();
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { client_email?: unknown }).client_email !== "string" ||
    typeof (parsed as { private_key?: unknown }).private_key !== "string"
  ) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON has no client_email / private_key");
  }
  return parsed as { client_email: string; private_key: string };
}

type CalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  transparency?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  organizer?: { email?: string };
  hangoutLink?: string;
};

/**
 * What counts as a meeting this person was in.
 *
 * Excluded, each for its own reason: a cancelled event never happened; an
 * all-day entry is a holiday or a PTO marker, not an hour in a room; a
 * "transparent" event is one the person themselves marked as free time; and an
 * invitation they declined is somebody else's meeting.
 */
function attended(event: CalendarEvent): boolean {
  if (event.status === "cancelled") return false;
  if (!event.start?.dateTime || !event.end?.dateTime) return false;
  if (event.transparency === "transparent") return false;
  const self = event.attendees?.find((attendee) => attendee.self);
  return self?.responseStatus !== "declined";
}

async function eventsFor(person: Person, since: Date): Promise<CalendarEvent[]> {
  const { client_email, private_key } = await serviceAccount();
  const auth = new JWT({
    email: client_email,
    key: private_key,
    scopes: [SCOPE],
    // Domain-wide delegation: act as this person, so their calendar — not the
    // service account's empty one — is what gets read.
    subject: person.email,
  });
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error(`calendar: no access token for ${person.email}`);

  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${API}/calendars/primary/events`);
    url.searchParams.set("timeMin", since.toISOString());
    url.searchParams.set("timeMax", new Date().toISOString());
    // Google expands recurrence for us, so a daily standup arrives as the days it
    // actually happened rather than a rule this collector would have to unroll.
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const json = (await response.json()) as any;
    if (!response.ok) {
      throw new Error(
        `calendar ${person.email}: ${json?.error?.message ?? response.statusText}`,
      );
    }
    events.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return events;
}

export async function collectCalendar(people: People, since: Date): Promise<Activity[]> {
  const out: Activity[] = [];
  const withEmail = people.all.filter((person) => person.email);
  if (!withEmail.length) {
    throw new Error("no person in people.yaml has an email — nothing to read a calendar for");
  }

  for (const person of withEmail) {
    // One unreachable calendar is not worth the other people's meetings: a
    // person who never granted access should not blank the whole source.
    let events: CalendarEvent[];
    try {
      events = await eventsFor(person, since);
    } catch (cause) {
      console.warn(`  calendar: ${person.email} skipped — ${cause instanceof Error ? cause.message : cause}`);
      continue;
    }

    for (const event of events) {
      if (!attended(event)) continue;
      const start = event.start?.dateTime;
      const end = event.end?.dateTime;
      if (!start || !end || !event.id) continue;
      if (new Date(start) < since) continue;

      out.push({
        id: `calendar:meeting:${person.id}:${event.id}:${start}`,
        source: "calendar",
        type: "meeting",
        personId: person.id,
        ts: start,
        endsAt: end,
        url: event.htmlLink,
        title: event.summary ?? "(no title)",
        meta: {
          minutes: Math.round((Date.parse(end) - Date.parse(start)) / 60_000),
          attendees: event.attendees?.length ?? 1,
          organizer: event.organizer?.email ?? null,
          video: Boolean(event.hangoutLink),
        },
      });
    }
  }

  return out;
}

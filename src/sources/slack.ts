import type { Config, People } from "../config";
import type { Activity } from "../types";

const API = "https://slack.com/api";

async function slack(method: string, params: Record<string, string | number> = {}): Promise<any> {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error("SLACK_USER_TOKEN not set");

  const url = new URL(`${API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 5);
      await Bun.sleep((wait + 1) * 1000);
      continue;
    }
    const json = (await res.json()) as any;
    if (!json.ok) throw new Error(`slack ${method}: ${json.error}`);
    return json;
  }
  throw new Error(`slack ${method}: rate limited after 5 attempts`);
}

async function paginate(method: string, params: Record<string, string | number>, field: string): Promise<any[]> {
  const items: any[] = [];
  let cursor = "";
  do {
    const res = await slack(method, cursor ? { ...params, cursor } : params);
    items.push(...(res[field] ?? []));
    cursor = res.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return items;
}

/** Slack timestamps are "1712345678.123456" seconds-with-microseconds. */
const toIso = (ts: string) => new Date(Number(ts) * 1000).toISOString();

const MENTION = /<@([A-Z0-9]+)>/g;

export async function collectSlack(cfg: Config, people: People, since: Date): Promise<Activity[]> {
  const auth = await slack("auth.test");
  const me: string = auth.user_id;
  const teamUrl: string = auth.url; // e.g. "https://acme.slack.com/"
  const oldest = Math.floor(since.getTime() / 1000);
  const out: Activity[] = [];

  const permalink = (channel: string, ts: string) =>
    `${teamUrl}archives/${channel}/p${ts.replace(".", "")}`;

  /** Turn one raw Slack message into zero or more activities. */
  const emit = (channel: string, msg: any, dmWith?: string) => {
    if (msg.subtype && msg.subtype !== "thread_broadcast") return; // joins, topic changes, bot noise
    const author = msg.user as string | undefined;
    if (!author || !msg.ts) return;

    const url = permalink(channel, msg.ts);
    const isReply = msg.thread_ts && msg.thread_ts !== msg.ts;

    if (dmWith && author === me) {
      // A message you sent in a DM — the raw material for the priority list.
      out.push({
        id: `slack:directive_received:${channel}:${msg.ts}`,
        source: "slack",
        type: "directive_received",
        personId: dmWith,
        ts: toIso(msg.ts),
        url,
        body: msg.text,
        meta: { channel, dm: true, from: me },
      });
    } else {
      const personId = people.bySlack.get(author);
      if (personId) {
        out.push({
          id: `slack:message:${channel}:${msg.ts}`,
          source: "slack",
          type: isReply ? "thread_reply" : "message",
          personId,
          ts: toIso(msg.ts),
          url,
          body: msg.text,
          meta: { channel, dm: Boolean(dmWith), threadTs: msg.thread_ts ?? null },
        });
      }
    }

    for (const [, uid] of String(msg.text ?? "").matchAll(MENTION)) {
      const target = people.bySlack.get(uid);
      if (!target || uid === author) continue;
      out.push({
        id: `slack:mention_received:${channel}:${msg.ts}:${uid}`,
        source: "slack",
        type: "mention_received",
        personId: target,
        ts: toIso(msg.ts),
        url,
        body: msg.text,
        meta: { channel, by: author },
      });
    }
  };

  const drain = async (channel: string, dmWith?: string) => {
    const msgs = await paginate("conversations.history", { channel, oldest, limit: 200 }, "messages");
    for (const msg of msgs) {
      emit(channel, msg, dmWith);
      // history returns thread parents only; replies live behind their own call.
      if (msg.reply_count > 0 && Number(msg.latest_reply ?? 0) >= oldest) {
        const replies = await paginate("conversations.replies", { channel, ts: msg.ts, limit: 200 }, "messages");
        for (const r of replies) {
          if (r.ts === msg.ts) continue; // the parent again
          if (Number(r.ts) < oldest) continue;
          emit(channel, r, dmWith);
        }
      }
    }
  };

  // Default is every conversation you belong to. An explicit `channels:` list in
  // people.yaml narrows it. Either way the ceiling is the same: a user token only
  // reaches conversations you are a member of, so anything a teammate says in a
  // channel you never joined is invisible to this tool.
  const explicit = cfg.slack?.channels ?? [];

  if (explicit.length) {
    const needsLookup = explicit.some((c) => !/^[CG][A-Z0-9]+$/.test(c));
    const byName = new Map<string, string>();
    if (needsLookup) {
      const all = await paginate(
        "users.conversations",
        { types: "public_channel,private_channel", limit: 200, exclude_archived: "true" },
        "channels",
      );
      for (const c of all) byName.set(c.name, c.id);
    }
    for (const entry of explicit) {
      const id = /^[CG][A-Z0-9]+$/.test(entry) ? entry : byName.get(entry.replace(/^#/, ""));
      if (!id) {
        console.warn(`  slack: channel "${entry}" not found or not joined — skipped`);
        continue;
      }
      await drain(id);
    }
  } else {
    const convos = await paginate(
      "users.conversations",
      { types: "public_channel,private_channel,mpim", limit: 200, exclude_archived: "true" },
      "channels",
    );
    console.log(`  slack: ${convos.length} channels`);
    for (const c of convos) await drain(c.id);
  }

  // DMs are always swept, independent of the channel list — they are the source
  // of directive_received, which nothing else provides.
  const dms = await paginate("users.conversations", { types: "im", limit: 200 }, "channels");
  let swept = 0;
  for (const im of dms) {
    const personId = people.bySlack.get(im.user);
    if (!personId || im.is_user_deleted) continue;
    await drain(im.id, personId);
    swept++;
  }
  console.log(`  slack: ${swept} DMs with tracked people`);

  return out;
}

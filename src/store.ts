import { DatabaseSync } from "node:sqlite";
import type {
  AgentRecord,
  BusMessage,
  Kind,
  PendingAsk,
  AgentMetrics,
  ReplyState,
  StateEntry,
} from "./types.ts";
import { TTY_RE } from "./wake.ts";

function isPaneOrTty(sessionId?: string | null): boolean {
  if (!sessionId) return false;
  return (
    sessionId.startsWith("zellij:") ||
    sessionId.startsWith("pty:") ||
    /^(?:tmux:)?%\d+$/.test(sessionId) ||
    TTY_RE.test(sessionId)
  );
}

export function sessionHandle(name: string, sessionId?: string | null, harness?: string): string {
  if (!sessionId || isPaneOrTty(sessionId)) return name;
  if (harness && name !== harness) return name;
  const short = sessionId.slice(0, 4).toLowerCase();
  if (name.toLowerCase().endsWith(`-${short}`)) return name;
  return `${name}-${short}`;
}

export function inboxCursorKey(clientKey: string, topic?: string): string {
  return topic ? JSON.stringify([clientKey, "topic", topic]) : clientKey;
}

// One definition of task completion for status, metrics, and the Stop gate.
// Only a 'done' reply (default) or a superseding ask closes an ask; 'progress' and 'blocked' keep it open.
const ANSWERED_ASK = `
  SELECT 1 FROM messages r WHERE r.repo = a.repo AND r.kind = 'reply'
    AND r.correlation_id = a.correlation_id
    AND COALESCE(r.reply_state, 'done') = 'done'
    AND (r.from_name = a.to_name OR r.from_id = a.to_name OR EXISTS (
      SELECT 1 FROM agents ag WHERE ag.repo = a.repo AND ag.session_id = a.to_name AND ag.name = r.from_name
    ))
    AND (r.to_name = a.from_name OR r.to_name = a.from_id) AND r.seq > a.seq
  UNION ALL
  SELECT 1 FROM messages s WHERE s.repo = a.repo AND s.kind = 'ask'
    AND s.supersedes = a.correlation_id AND s.seq > a.seq
`;

const SELECT_MESSAGE_WITH_ASK_STATE = `
  SELECT a.*,
    CASE
      WHEN a.kind = 'ask' AND a.correlation_id IS NOT NULL AND EXISTS (${ANSWERED_ASK}) THEN 'done'
      ELSE a.reply_state
    END AS effective_reply_state
  FROM messages a
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  repo TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  topic TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT,
  to_name TEXT,
  reply_state TEXT,
  supersedes TEXT,
  PRIMARY KEY (repo, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_id ON messages(repo, id);
CREATE INDEX IF NOT EXISTS messages_topic ON messages(repo, topic, seq);
CREATE INDEX IF NOT EXISTS messages_correlation ON messages(repo, kind, correlation_id);

CREATE TABLE IF NOT EXISTS cursors (
  repo TEXT NOT NULL,
  client_key TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  PRIMARY KEY (repo, client_key)
);

CREATE TABLE IF NOT EXISTS agents (
  repo TEXT NOT NULL,
  session_key TEXT NOT NULL,
  name TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT,
  wake_session_id TEXT,
  cwd TEXT NOT NULL,
  branch TEXT,
  head TEXT,
  wake INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo, session_key)
);
CREATE INDEX IF NOT EXISTS agents_repo_name ON agents(repo, name);
CREATE INDEX IF NOT EXISTS agents_repo_session ON agents(repo, session_id);

CREATE TABLE IF NOT EXISTS roles (
  repo TEXT NOT NULL PRIMARY KEY,
  orchestrator TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  repo TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, key)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  repo TEXT NOT NULL,
  session_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  since_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, session_key, topic)
);

CREATE TABLE IF NOT EXISTS deferred_wakes (
  repo TEXT NOT NULL,
  target TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, target)
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.migrateMessagesTable();
    this.migrateAgentsTable();
    this.db.exec(SCHEMA);
  }

  private migrateMessagesTable(): void {
    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (cols.length === 0) return;
    if (!cols.some((col) => col.name === "reply_state")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reply_state TEXT;");
    }
    if (!cols.some((col) => col.name === "supersedes")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN supersedes TEXT;");
    }
  }

  private migrateAgentsTable(): void {
    const cols = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (cols.length === 0) return;
    const hasSessionKey = cols.some((col) => col.name === "session_key");
    const hasBranch = cols.some((col) => col.name === "branch");
    const hasHead = cols.some((col) => col.name === "head");
    if (!hasSessionKey || !hasBranch || !hasHead) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          CREATE TABLE agents_v2 (
            repo TEXT NOT NULL,
            session_key TEXT NOT NULL,
            name TEXT NOT NULL,
            harness TEXT NOT NULL,
            session_id TEXT,
            wake_session_id TEXT,
            cwd TEXT NOT NULL,
            branch TEXT,
            head TEXT,
            wake INTEGER NOT NULL DEFAULT 0,
            last_seen INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (repo, session_key)
          );
          INSERT OR REPLACE INTO agents_v2 (repo, session_key, name, harness, session_id, wake_session_id, cwd, branch, head, wake, last_seen, status)
          SELECT repo, COALESCE(session_id, 'name:' || name), name, harness, session_id, NULL, cwd, NULL, NULL, wake, last_seen, status
          FROM agents;
          DROP TABLE agents;
          ALTER TABLE agents_v2 RENAME TO agents;
          CREATE INDEX IF NOT EXISTS agents_repo_name ON agents(repo, name);
          CREATE INDEX IF NOT EXISTS agents_repo_session ON agents(repo, session_id);
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const updatedCols = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (updatedCols.length > 0 && !updatedCols.some((col) => col.name === "wake_session_id")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN wake_session_id TEXT;");
    }
  }

  close(): void {
    this.db.close();
  }

  cursor(repo: string, name: string): number {
    const row = this.db
      .prepare("SELECT cursor FROM cursors WHERE repo = ? AND client_key = ?")
      .get(repo, name) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  ack(repo: string, name: string, cursor: number): void {
    const current = this.cursor(repo, name);
    const next = Math.max(current, cursor);
    this.db
      .prepare(
        `INSERT INTO cursors (repo, client_key, cursor) VALUES (?, ?, ?)
         ON CONFLICT(repo, client_key) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(repo, name, next);
  }

  migrateSessionCursors(repo: string, oldName: string, newName: string, sessionId: string): void {
    if (!sessionId || oldName === newName || isPaneOrTty(sessionId)) return;
    const oldBase = `${oldName}:${sessionId}`;
    const newBase = `${newName}:${sessionId}`;
    for (const prefix of ["", "hook:"]) {
      const prev = this.cursor(repo, `${prefix}${oldBase}`);
      if (prev > 0) this.ack(repo, `${prefix}${newBase}`, prev);
      for (const topic of ["dm", "repo", "reports"]) {
        const prevTopic = this.cursor(repo, `${prefix}${inboxCursorKey(oldBase, topic)}`);
        if (prevTopic > 0) this.ack(repo, `${prefix}${inboxCursorKey(newBase, topic)}`, prevTopic);
      }
    }
  }

  insert(input: {
    repo: string;
    id: string;
    topic: string;
    fromId: string;
    fromName: string;
    body: string;
    ts: number;
    kind: Kind;
    correlationId: string | null;
    to: string | null;
    replyState?: ReplyState | null;
    supersedes?: string | null;
  }): BusMessage {
    const existing = this.db
      .prepare("SELECT seq FROM messages WHERE repo = ? AND id = ?")
      .get(input.repo, input.id) as { seq: number } | undefined;
    if (existing) {
      const found = this.bySeq(input.repo, existing.seq);
      if (!found) throw new Error("message id existed without a row");
      return found;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE repo = ?")
        .get(input.repo) as { seq: number };
      this.db
        .prepare(
          `INSERT INTO messages
           (repo, seq, id, topic, from_id, from_name, body, ts, kind, correlation_id, to_name, reply_state, supersedes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.repo,
          row.seq,
          input.id,
          input.topic,
          input.fromId,
          input.fromName,
          input.body,
          input.ts,
          input.kind,
          input.correlationId,
          input.to,
          input.replyState ?? null,
          input.supersedes ?? null,
        );
      this.db.exec("COMMIT");
      return this.bySeq(input.repo, row.seq)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bySeq(repo: string, seq: number): BusMessage | undefined {
    const row = this.db
      .prepare(`${SELECT_MESSAGE_WITH_ASK_STATE} WHERE a.repo = ? AND a.seq = ?`)
      .get(repo, seq) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  byId(repo: string, id: string): BusMessage | undefined {
    const row = this.db
      .prepare(`${SELECT_MESSAGE_WITH_ASK_STATE} WHERE a.repo = ? AND a.id = ?`)
      .get(repo, id) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  byCorrelation(repo: string, correlationId: string): BusMessage | undefined {
    const row = this.db
      .prepare(
        `${SELECT_MESSAGE_WITH_ASK_STATE} WHERE a.repo = ? AND a.correlation_id = ? AND a.kind = 'ask' ORDER BY a.seq DESC LIMIT 1`,
      )
      .get(repo, correlationId) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  /** Workspace-wide tracker: only a matching done reply or superseding ask closes an ask. */
  pendingAsks(
    repo: string,
    limit = 50,
    now = Date.now(),
    participant?: string,
    sessionId?: string | null,
  ): PendingAsk[] {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 50;
    const session = sessionId ?? null;
    const multiSessionForName = Boolean(
      participant &&
        session &&
        (
          this.db
            .prepare("SELECT COUNT(*) AS cnt FROM agents WHERE repo = ? AND name = ?")
            .get(repo, participant) as { cnt: number }
        ).cnt > 1,
    );
    const rows = this.db
      .prepare(
        `SELECT a.*, (
           SELECT r.reply_state FROM messages r
           WHERE r.repo = a.repo AND r.kind = 'reply'
             AND r.correlation_id = a.correlation_id AND r.seq > a.seq
           ORDER BY r.seq DESC LIMIT 1
         ) AS last_reply_state
         FROM messages a
         WHERE a.repo = ? AND a.kind = 'ask' AND a.correlation_id IS NOT NULL
           AND (
             ? IS NULL
             OR (? = 1 AND (a.from_id = ? OR a.to_name = ? OR a.to_name = ?))
             OR (? = 0 AND (a.from_name = ? OR a.to_name = ? OR (? IS NOT NULL AND (a.from_id = ? OR a.to_name = ?))))
           )
           AND NOT EXISTS (${ANSWERED_ASK})
         ORDER BY a.seq DESC LIMIT ?`,
      )
      .all(
        repo,
        participant ?? null,
        multiSessionForName ? 1 : 0,
        session,
        session,
        participant ?? null,
        multiSessionForName ? 1 : 0,
        participant ?? null,
        participant ?? null,
        session,
        session,
        session,
        boundedLimit,
      ) as (Row & {
      last_reply_state?: ReplyState | null;
    })[];
    return rows.map((row) => ({
      id: row.id,
      correlation_id: row.correlation_id!,
      seq: row.seq,
      from: row.from_name,
      to: row.to_name,
      topic: row.topic,
      age_seconds: Math.max(0, Math.floor((now - row.ts) / 1000)),
      preview: row.body.replace(/\s+/g, " ").trim().slice(0, 160),
      ...(row.last_reply_state ? { last_reply_state: row.last_reply_state } : {}),
    }));
  }

  /** Cumulative board telemetry; first recipient reply per ask determines latency. */
  agentMetrics(repo: string, participant?: string, sessionId?: string | null): AgentMetrics[] {
    const session = sessionId ?? null;
    const rows = this.db.prepare(
      `WITH names AS (
         SELECT name AS agent FROM agents WHERE repo = ?
         UNION SELECT from_name FROM messages WHERE repo = ? AND kind IN ('ask', 'reply')
         UNION SELECT to_name FROM messages WHERE repo = ? AND kind IN ('ask', 'reply')
           AND to_name IS NOT NULL AND to_name != '*'
       ), asks AS (
         SELECT to_name AS agent, COUNT(*) AS received,
           SUM(CASE WHEN a.correlation_id IS NOT NULL AND NOT EXISTS (${ANSWERED_ASK}) THEN 1 ELSE 0 END) AS pending
         FROM messages a WHERE repo = ? AND kind = 'ask' AND to_name IS NOT NULL AND to_name != '*'
         GROUP BY to_name
       ), replies AS (
         SELECT from_name AS agent, COUNT(*) AS sent, MAX(ts) AS last_reply
         FROM messages WHERE repo = ? AND kind = 'reply' GROUP BY from_name
       ), latency AS (
         SELECT a.to_name AS agent, AVG(MAX(0, (
           SELECT r.ts FROM messages r WHERE r.repo = a.repo AND r.kind = 'reply'
             AND r.correlation_id = a.correlation_id
             AND (r.from_name = a.to_name OR r.from_id = a.to_name OR EXISTS (
               SELECT 1 FROM agents ag WHERE ag.repo = a.repo AND ag.session_id = a.to_name AND ag.name = r.from_name
             ))
             AND (r.to_name = a.from_name OR r.to_name = a.from_id) AND r.seq > a.seq
           ORDER BY r.seq LIMIT 1
         ) - a.ts) / 1000.0) AS avg_latency
         FROM messages a WHERE a.repo = ? AND a.kind = 'ask' AND a.correlation_id IS NOT NULL
           AND a.to_name IS NOT NULL AND a.to_name != '*' GROUP BY a.to_name
       )
       SELECT names.agent,
         COALESCE(asks.received, 0) AS asks_received,
         COALESCE(replies.sent, 0) AS replies_sent,
         COALESCE(asks.pending, 0) AS pending_asks_count,
         latency.avg_latency AS avg_reply_latency_seconds,
         replies.last_reply AS last_reply_at
       FROM names LEFT JOIN asks USING (agent) LEFT JOIN replies USING (agent) LEFT JOIN latency USING (agent)
       WHERE (? IS NULL OR names.agent = ? OR (? IS NOT NULL AND names.agent = ?)) ORDER BY names.agent`,
    ).all(repo, repo, repo, repo, repo, repo, participant ?? null, participant ?? null, session, session) as AgentMetrics[];
    return rows.map((row) => ({ ...row }));
  }

  unansweredAsk(
    repo: string,
    toName: string,
    cursor: number,
    minTs = 0,
    sessionId?: string | null,
  ): BusMessage | null {
    const session = sessionId ?? null;
    const row = this.db
      .prepare(
        `SELECT * FROM messages a
         WHERE a.repo = ?
           AND (
             a.to_name = ?
             OR (? IS NOT NULL AND a.to_name = ?)
             OR (? IS NULL AND EXISTS (
               SELECT 1 FROM agents ag WHERE ag.repo = a.repo AND ag.session_id = a.to_name AND ag.name = ?
             ))
           )
           AND a.kind = 'ask'
           AND a.seq <= ? AND a.ts >= ?
           AND a.correlation_id IS NOT NULL
           AND NOT EXISTS (${ANSWERED_ASK})
         ORDER BY a.seq DESC
         LIMIT 1`,
      )
      .get(repo, toName, session, session, session, toName, cursor, minTs) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  maxSeq(repo: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE repo = ?")
      .get(repo) as { seq: number };
    return row.seq;
  }

  subscribe(repo: string, sessionKey: string, topics: Iterable<string>, sinceSeq = this.maxSeq(repo)): void {
    const stmt = this.db.prepare(
      `INSERT INTO subscriptions (repo, session_key, topic, since_seq)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, session_key, topic) DO NOTHING`,
    );
    for (const topic of topics) {
      if (topic === "repo" || topic === "presence") continue;
      stmt.run(repo, sessionKey, topic, sinceSeq);
    }
  }

  unsubscribe(repo: string, sessionKey: string, topics: Iterable<string>): void {
    const stmt = this.db.prepare(
      "DELETE FROM subscriptions WHERE repo = ? AND session_key = ? AND topic = ?",
    );
    for (const topic of topics) {
      if (topic === "repo" || topic === "presence") continue;
      stmt.run(repo, sessionKey, topic);
    }
  }

  subscriptions(repo: string, sessionKey: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT topic, since_seq FROM subscriptions WHERE repo = ? AND session_key = ? ORDER BY topic ASC")
      .all(repo, sessionKey) as { topic: string; since_seq: number }[];
    return new Map(rows.map((r) => [r.topic, r.since_seq]));
  }

  migrateSubscriptions(repo: string, fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    const existing = this.subscriptions(repo, fromKey);
    if (existing.size === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO subscriptions (repo, session_key, topic, since_seq)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, session_key, topic) DO UPDATE SET
         since_seq = MIN(subscriptions.since_seq, excluded.since_seq)`,
    );
    for (const [topic, sinceSeq] of existing) {
      insert.run(repo, toKey, topic, sinceSeq);
    }
  }

  inbox(
    repo: string,
    since: number,
    opts: {
      topic?: string;
      to?: string;
      sessionId?: string | null;
      subscriptionKey?: string;
      isOrchestrator?: boolean;
      limit: number;
    },
  ): BusMessage[] {
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const topic = opts.topic ?? null;
    const session = opts.sessionId ?? null;
    if (topic !== null) {
      const rows = this.db
        .prepare(
          `${SELECT_MESSAGE_WITH_ASK_STATE}
           WHERE a.repo = ? AND a.seq > ?
             AND a.topic = ?
             AND (
               a.to_name IS NULL
               OR a.to_name = '*'
               OR a.to_name = ?
               OR (? IS NOT NULL AND a.to_name = ?)
               OR (? IS NULL AND EXISTS (
                 SELECT 1 FROM agents ag WHERE ag.repo = a.repo AND ag.session_id = a.to_name AND ag.name = ?
               ))
             )
           ORDER BY a.seq ASC
           LIMIT ?`,
        )
        .all(repo, since, topic, opts.to ?? "", session, session, session, opts.to ?? "", limit) as Row[];
      return rows.map(mapMessage);
    }
    const subKey = opts.subscriptionKey ?? (session || `name:${opts.to ?? ""}`);
    const isOrch = opts.isOrchestrator ? 1 : 0;
    const rows = this.db
      .prepare(
        `${SELECT_MESSAGE_WITH_ASK_STATE}
         WHERE a.repo = ? AND a.seq > ? AND a.topic != 'presence'
           AND (
             (a.to_name IS NOT NULL AND a.to_name != '*' AND (
               a.to_name = ?
               OR (? IS NOT NULL AND a.to_name = ?)
               OR (? IS NULL AND EXISTS (
                 SELECT 1 FROM agents ag WHERE ag.repo = a.repo AND ag.session_id = a.to_name AND ag.name = ?
               ))
             ))
             OR
             ((a.to_name IS NULL OR a.to_name = '*') AND (
               a.topic IN ('repo', 'dm')
               OR (? = 1 AND a.topic = 'reports')
               OR EXISTS (
                 SELECT 1 FROM subscriptions sub
                 WHERE sub.repo = a.repo
                   AND sub.session_key = ?
                   AND sub.topic = a.topic
                   AND a.seq > sub.since_seq
               )
             ))
           )
         ORDER BY a.seq ASC
         LIMIT ?`,
      )
      .all(repo, since, opts.to ?? "", session, session, session, opts.to ?? "", isOrch, subKey, limit) as Row[];
    return rows.map(mapMessage);
  }

  /** Read-only wait queries use the same visibility and topic cursor rules as inbox. */
  unreadForWait(
    repo: string,
    to: string,
    since: number,
    cursorKey = to,
    topic?: string,
    sessionId?: string | null,
    opts?: { subscriptionKey?: string; isOrchestrator?: boolean },
  ): BusMessage[] {
    const session = sessionId ?? null;
    const subKey =
      opts?.subscriptionKey ?? (session || this.getAgent(repo, to)?.sessionId || `name:${to}`);
    const isOrch = (opts?.isOrchestrator ?? (this.getOrchestrator(repo) === to)) ? 1 : 0;
    const rows = this.db.prepare(
      `${SELECT_MESSAGE_WITH_ASK_STATE} WHERE a.repo = ?
         AND a.seq > MAX(?, COALESCE((SELECT MAX(cursor) FROM cursors WHERE repo = ? AND client_key = ?), 0))
         AND (
           (a.to_name IS NOT NULL AND a.to_name != '*' AND (
             a.to_name = ?
             OR (? IS NOT NULL AND a.to_name = ?)
             OR (? IS NULL AND EXISTS (
               SELECT 1 FROM agents ag WHERE ag.repo = a.repo AND ag.session_id = a.to_name AND ag.name = ?
             ))
           ))
           OR
           ((a.to_name IS NULL OR a.to_name = '*') AND (
             ? IS NOT NULL
             OR ? = '*'
             OR a.topic IN ('repo', 'dm')
             OR (? = 1 AND a.topic = 'reports')
             OR EXISTS (
               SELECT 1 FROM subscriptions sub
               WHERE sub.repo = a.repo
                 AND sub.session_key = ?
                 AND sub.topic = a.topic
                 AND a.seq > sub.since_seq
             )
           ))
         )
         AND ((? IS NULL AND a.topic != 'presence') OR a.topic = ?)
       ORDER BY a.seq ASC LIMIT 200`,
    ).all(
      repo,
      since,
      repo,
      inboxCursorKey(cursorKey, topic),
      to,
      session,
      session,
      session,
      to,
      topic ?? null,
      to,
      isOrch,
      subKey,
      topic ?? null,
      topic ?? null,
    ) as Row[];
    return rows.map(mapMessage);
  }

  latestUnreadSeq(
    repo: string,
    to: string,
    cursorKey = to,
    topic?: string,
    sessionId?: string | null,
    opts?: { subscriptionKey?: string; isOrchestrator?: boolean },
  ): number {
    const session = sessionId ?? null;
    const subKey =
      opts?.subscriptionKey ?? (session || this.getAgent(repo, to)?.sessionId || `name:${to}`);
    const isOrch = (opts?.isOrchestrator ?? (this.getOrchestrator(repo) === to)) ? 1 : 0;
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE repo = ?
         AND seq > COALESCE((SELECT MAX(cursor) FROM cursors WHERE repo = ? AND client_key = ?), 0)
         AND (
           (to_name IS NOT NULL AND to_name != '*' AND (
             to_name = ?
             OR (? IS NOT NULL AND to_name = ?)
             OR (? IS NULL AND EXISTS (
               SELECT 1 FROM agents ag WHERE ag.repo = messages.repo AND ag.session_id = messages.to_name AND ag.name = ?
             ))
           ))
           OR
           ((to_name IS NULL OR to_name = '*') AND (
             ? IS NOT NULL
             OR ? = '*'
             OR topic IN ('repo', 'dm')
             OR (? = 1 AND topic = 'reports')
             OR EXISTS (
               SELECT 1 FROM subscriptions sub
               WHERE sub.repo = messages.repo
                 AND sub.session_key = ?
                 AND sub.topic = messages.topic
                 AND messages.seq > sub.since_seq
             )
           ))
         )
         AND ((? IS NULL AND topic != 'presence') OR topic = ?)`,
    ).get(
      repo,
      repo,
      inboxCursorKey(cursorKey, topic),
      to,
      session,
      session,
      session,
      to,
      topic ?? null,
      to,
      isOrch,
      subKey,
      topic ?? null,
      topic ?? null,
    ) as { seq: number };
    return row.seq;
  }

  upsertAgent(agent: {
    repo: string;
    name: string;
    harness: string;
    sessionId: string | null;
    wakeSessionId?: string | null;
    cwd: string;
    branch?: string | null;
    head?: string | null;
    wake: boolean;
    status: string;
    bySession?: boolean;
  }): AgentRecord {
    const now = Date.now();
    const keyBySession = Boolean(agent.sessionId && (agent.bySession || !isPaneOrTty(agent.sessionId)));
    if (keyBySession && agent.sessionId) {
      const existingRow = this.getAgentBySession(agent.repo, agent.sessionId);
      const placeholder = this.db
        .prepare(
          "SELECT wake_session_id FROM agents WHERE repo = ? AND name = ? AND (session_key = ? OR status = 'invited') AND session_id IS NULL ORDER BY last_seen DESC LIMIT 1",
        )
        .get(agent.repo, agent.name, `name:${agent.name}`) as { wake_session_id: string | null } | undefined;
      const incomingWake = agent.wakeSessionId ?? null;
      const existingWake = existingRow?.wakeSessionId ?? placeholder?.wake_session_id ?? null;
      const carriedWakeSessionId =
        incomingWake && isPaneOrTty(incomingWake)
          ? incomingWake
          : existingWake && isPaneOrTty(existingWake)
            ? existingWake
            : (incomingWake ?? existingWake ?? null);
      // Remove any unbound or invited placeholder row for this (repo, name) once a real session id is bound.
      this.db
        .prepare(
          "DELETE FROM agents WHERE repo = ? AND name = ? AND (session_key = ? OR status = 'invited') AND session_id IS NULL",
        )
        .run(agent.repo, agent.name, `name:${agent.name}`);
      this.db
        .prepare(
          `INSERT INTO agents (repo, session_key, name, harness, session_id, wake_session_id, cwd, branch, head, wake, last_seen, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo, session_key) DO UPDATE SET
             name = excluded.name,
             harness = excluded.harness,
             session_id = excluded.session_id,
             wake_session_id = COALESCE(excluded.wake_session_id, agents.wake_session_id),
             cwd = excluded.cwd,
             branch = COALESCE(excluded.branch, agents.branch),
             head = COALESCE(excluded.head, agents.head),
             wake = excluded.wake,
             last_seen = excluded.last_seen,
             status = excluded.status`,
        )
        .run(
          agent.repo,
          agent.sessionId,
          agent.name,
          agent.harness,
          agent.sessionId,
          carriedWakeSessionId,
          agent.cwd,
          agent.branch ?? null,
          agent.head ?? null,
          agent.wake ? 1 : 0,
          now,
          agent.status,
        );
      return this.getAgentBySession(agent.repo, agent.sessionId)!;
    }

    if (!agent.sessionId) {
      const existingBound = this.db
        .prepare("SELECT * FROM agents WHERE repo = ? AND name = ? AND session_id IS NOT NULL ORDER BY last_seen DESC LIMIT 1")
        .get(agent.repo, agent.name) as AgentRow | undefined;
      if (existingBound) {
        this.db
          .prepare(
            `UPDATE agents
             SET harness = ?, wake_session_id = COALESCE(?, wake_session_id), cwd = ?, branch = COALESCE(?, branch), head = COALESCE(?, head), wake = ?, last_seen = ?, status = ?
             WHERE repo = ? AND session_key = ?`,
          )
          .run(
            agent.harness,
            agent.wakeSessionId ?? null,
            agent.cwd,
            agent.branch ?? null,
            agent.head ?? null,
            agent.wake ? 1 : 0,
            now,
            agent.status,
            agent.repo,
            existingBound.session_key,
          );
        return this.getAgentBySession(agent.repo, existingBound.session_key)!;
      }
    }

    const sessionKey = `name:${agent.name}`;
    this.db
      .prepare(
        `INSERT INTO agents (repo, session_key, name, harness, session_id, wake_session_id, cwd, branch, head, wake, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, session_key) DO UPDATE SET
           harness = excluded.harness,
           session_id = COALESCE(excluded.session_id, agents.session_id),
           wake_session_id = COALESCE(excluded.wake_session_id, agents.wake_session_id),
           cwd = excluded.cwd,
           branch = COALESCE(excluded.branch, agents.branch),
           head = COALESCE(excluded.head, agents.head),
           wake = excluded.wake,
           last_seen = excluded.last_seen,
           status = excluded.status`,
      )
      .run(
        agent.repo,
        sessionKey,
        agent.name,
        agent.harness,
        agent.sessionId,
        agent.wakeSessionId ?? null,
        agent.cwd,
        agent.branch ?? null,
        agent.head ?? null,
        agent.wake ? 1 : 0,
        now,
        agent.status,
      );
    return this.getAgent(agent.repo, agent.sessionId ?? agent.name)!;
  }

  saveInvitedAgent(agent: {
    repo: string;
    name: string;
    harness: string;
    sessionId: string | null;
    wakeSessionId: string | null;
    cwd: string;
    branch: string | null;
    head: string | null;
    status: string;
  }): AgentRecord {
    const now = Date.now();
    const sessionKey = agent.sessionId ?? `name:${agent.name}`;
    this.db
      .prepare(
        "DELETE FROM agents WHERE repo = ? AND name = ? AND (session_key = ? OR status = 'invited' OR session_id IS NULL)",
      )
      .run(agent.repo, agent.name, `name:${agent.name}`);
    this.db
      .prepare(
        `INSERT INTO agents (repo, session_key, name, harness, session_id, wake_session_id, cwd, branch, head, wake, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(repo, session_key) DO UPDATE SET
           harness = excluded.harness,
           session_id = excluded.session_id,
           wake_session_id = excluded.wake_session_id,
           cwd = excluded.cwd,
           branch = COALESCE(excluded.branch, agents.branch),
           head = COALESCE(excluded.head, agents.head),
           wake = 1,
           last_seen = excluded.last_seen,
           status = excluded.status`,
      )
      .run(
        agent.repo,
        sessionKey,
        agent.name,
        agent.harness,
        agent.sessionId,
        agent.wakeSessionId,
        agent.cwd,
        agent.branch,
        agent.head,
        now,
        agent.status,
      );
    return this.getAgent(agent.repo, agent.sessionId ?? agent.name)!;
  }

  touchAgent(repo: string, name: string, status?: string, sessionId?: string | null): void {
    const now = Date.now();
    if (sessionId) {
      const res =
        status === undefined
          ? this.db.prepare("UPDATE agents SET last_seen = ? WHERE repo = ? AND session_id = ?").run(now, repo, sessionId)
          : this.db
              .prepare("UPDATE agents SET last_seen = ?, status = ? WHERE repo = ? AND session_id = ?")
              .run(now, status, repo, sessionId);
      if (res.changes > 0) return;
    }
    if (status === undefined) {
      this.db
        .prepare("UPDATE agents SET last_seen = ? WHERE repo = ? AND name = ?")
        .run(now, repo, name);
      return;
    }
    this.db
      .prepare("UPDATE agents SET last_seen = ?, status = ? WHERE repo = ? AND name = ?")
      .run(now, status, repo, name);
  }

  listRepos(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT repo FROM agents ORDER BY repo").all() as { repo: string }[];
    return rows.map((row) => row.repo);
  }

  /** Compare the scanned registration before changing it; preserve concurrent reconnects. */
  pruneAgent(expected: AgentRecord, reason: "dead_pane" | "stale"): boolean {
    const clearSessionId = reason === "dead_pane" && Boolean(expected.sessionId && isPaneOrTty(expected.sessionId));
    const clearWakeSessionId = reason === "dead_pane";
    const expectedWake = expected.wakeSessionId ?? expected.sessionId ?? null;
    const result = this.db.prepare(
      `UPDATE agents
       SET status = 'offline',
           session_id = CASE WHEN ? = 1 THEN NULL ELSE session_id END,
           wake_session_id = CASE WHEN ? = 1 THEN NULL ELSE wake_session_id END
       WHERE repo = ? AND name = ? AND session_id IS ? AND COALESCE(wake_session_id, session_id) IS ? AND last_seen = ? AND status = ?
         AND (status != 'offline' OR (? = 'dead_pane' AND (session_id IS NOT NULL OR wake_session_id IS NOT NULL)))`,
    ).run(
      clearSessionId ? 1 : 0,
      clearWakeSessionId ? 1 : 0,
      expected.repo,
      expected.name,
      expected.sessionId,
      expectedWake,
      expected.lastSeen,
      expected.status,
      reason,
    );
    return result.changes > 0;
  }

  getOrchestrator(repo: string): string | null {
    const row = this.db
      .prepare("SELECT orchestrator FROM roles WHERE repo = ?")
      .get(repo) as { orchestrator: string } | undefined;
    return row?.orchestrator || null;
  }

  setOrchestrator(repo: string, name: string | null): void {
    if (!name) {
      this.db.prepare("DELETE FROM roles WHERE repo = ?").run(repo);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO roles (repo, orchestrator) VALUES (?, ?)
         ON CONFLICT(repo) DO UPDATE SET orchestrator = excluded.orchestrator`,
      )
      .run(repo, name);
  }

  getAgentBySession(repo: string, sessionId: string): AgentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE repo = ? AND (session_id = ? OR wake_session_id = ? OR session_key = ?) LIMIT 1")
      .get(repo, sessionId, sessionId, sessionId) as AgentRow | undefined;
    return row ? mapAgent(row, false) : undefined;
  }

  getAgent(repo: string, nameOrSession: string): AgentRecord | undefined {
    const bySession = this.getAgentBySession(repo, nameOrSession);
    if (bySession) return bySession;
    const row = this.db
      .prepare(
        "SELECT * FROM agents WHERE repo = ? AND name = ? ORDER BY last_seen DESC, CASE WHEN status = 'invited' THEN 1 ELSE 0 END DESC, rowid DESC LIMIT 1",
      )
      .get(repo, nameOrSession) as AgentRow | undefined;
    return row ? mapAgent(row, false) : undefined;
  }

  listAgents(repo: string, onlineNames: Set<string>): AgentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM agents WHERE repo = ? ORDER BY name, last_seen DESC, CASE WHEN status = 'invited' THEN 1 ELSE 0 END DESC, rowid DESC",
      )
      .all(repo) as AgentRow[];
    return rows.map((row) => mapAgent(row, onlineNames.has(row.name)));
  }

  getState(repo: string, key: string): StateEntry | null {
    const row = this.db
      .prepare("SELECT * FROM state WHERE repo = ? AND key = ?")
      .get(repo, key) as StateRow | undefined;
    return row ? mapState(row) : null;
  }

  listState(repo: string, prefix?: string): StateEntry[] {
    const rows = prefix
      ? (this.db
          .prepare("SELECT * FROM state WHERE repo = ? AND substr(key, 1, ?) = ? ORDER BY key ASC")
          .all(repo, prefix.length, prefix) as StateRow[])
      : (this.db
          .prepare("SELECT * FROM state WHERE repo = ? ORDER BY key ASC")
          .all(repo) as StateRow[]);
    return rows.map(mapState);
  }

  setState(input: {
    repo: string;
    key: string;
    value: string;
    updatedBy: string;
    ifRev?: number;
  }): { ok: true; entry: StateEntry } | { ok: false; current: StateEntry | null } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.db
        .prepare("SELECT * FROM state WHERE repo = ? AND key = ?")
        .get(input.repo, input.key) as StateRow | undefined;
      const current = currentRow ? mapState(currentRow) : null;
      if (input.ifRev !== undefined) {
        if (input.ifRev === 0) {
          if (current !== null) {
            this.db.exec("COMMIT");
            return { ok: false, current };
          }
        } else if (!current || current.rev !== input.ifRev) {
          this.db.exec("COMMIT");
          return { ok: false, current };
        }
      }
      const nextRev = (current?.rev ?? 0) + 1;
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO state (repo, key, value, rev, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo, key) DO UPDATE SET
             value = excluded.value,
             rev = excluded.rev,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .run(input.repo, input.key, input.value, nextRev, input.updatedBy, now);
      const updated = this.getState(input.repo, input.key)!;
      this.db.exec("COMMIT");
      return { ok: true, entry: updated };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteState(input: {
    repo: string;
    key: string;
    ifRev?: number;
  }): { ok: true; deleted: boolean; rev: number } | { ok: false; current: StateEntry | null } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.db
        .prepare("SELECT * FROM state WHERE repo = ? AND key = ?")
        .get(input.repo, input.key) as StateRow | undefined;
      const current = currentRow ? mapState(currentRow) : null;
      if (input.ifRev !== undefined && (current?.rev ?? 0) !== input.ifRev) {
        this.db.exec("COMMIT");
        return { ok: false, current };
      }
      if (current) {
        this.db.prepare("DELETE FROM state WHERE repo = ? AND key = ?").run(input.repo, input.key);
      }
      this.db.exec("COMMIT");
      return { ok: true, deleted: Boolean(current), rev: current?.rev ?? 0 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveDeferredWake(repo: string, target: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO deferred_wakes (repo, target, seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, target) DO UPDATE SET
           seq = MAX(deferred_wakes.seq, excluded.seq),
           updated_at = excluded.updated_at`,
      )
      .run(repo, target, seq, Date.now());
  }

  clearDeferredWake(repo: string, target: string): void {
    this.db.prepare("DELETE FROM deferred_wakes WHERE repo = ? AND target = ?").run(repo, target);
  }

  listDeferredWakes(repo?: string): Array<{ repo: string; target: string; seq: number }> {
    if (repo !== undefined) {
      return this.db
        .prepare("SELECT repo, target, seq FROM deferred_wakes WHERE repo = ? ORDER BY seq ASC")
        .all(repo) as Array<{ repo: string; target: string; seq: number }>;
    }
    return this.db
      .prepare("SELECT repo, target, seq FROM deferred_wakes ORDER BY seq ASC")
      .all() as Array<{ repo: string; target: string; seq: number }>;
  }

  /**
   * Ensures a session_id or wake_session_id (tty/pane/UUID) bound in `repo` is not left
   * bound in any other repo board, preventing cross-repo wake/injection mix-ups.
   */
  evictCrossRepoBinding(repo: string, sessionId?: string | null, wakeSessionId?: string | null): void {
    for (const id of [sessionId, wakeSessionId]) {
      if (!id) continue;
      this.db
        .prepare("UPDATE agents SET wake_session_id = NULL WHERE repo != ? AND wake_session_id = ?")
        .run(repo, id);
      this.db
        .prepare("DELETE FROM agents WHERE repo != ? AND session_id = ?")
        .run(repo, id);
    }
  }
}

type StateRow = {
  repo: string;
  key: string;
  value: string;
  rev: number;
  updated_by: string;
  updated_at: number;
};

type Row = {
  repo: string;
  seq: number;
  id: string;
  topic: string;
  from_id: string;
  from_name: string;
  body: string;
  ts: number;
  kind: string;
  correlation_id: string | null;
  to_name: string | null;
  reply_state: string | null;
  effective_reply_state?: string | null;
  supersedes: string | null;
};

type AgentRow = {
  repo: string;
  session_key: string;
  name: string;
  harness: string;
  session_id: string | null;
  wake_session_id: string | null;
  cwd: string;
  branch: string | null;
  head: string | null;
  wake: number;
  last_seen: number;
  status: string;
};

function mapMessage(row: Row): BusMessage {
  const rawState = row.effective_reply_state ?? row.reply_state;
  const replyState =
    rawState === "done" || rawState === "progress" || rawState === "blocked"
      ? rawState
      : null;
  return {
    id: row.id,
    seq: row.seq,
    repo: row.repo,
    topic: row.topic,
    fromId: row.from_id,
    fromName: row.from_name,
    body: row.body,
    ts: row.ts,
    kind: row.kind === "ask" || row.kind === "reply" ? row.kind : "pub",
    correlationId: row.correlation_id,
    to: row.to_name,
    ...(replyState ? { replyState } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
  };
}

function mapState(row: StateRow): StateEntry {
  return {
    repo: row.repo,
    key: row.key,
    value: row.value,
    rev: row.rev,
    updatedBy: row.updated_by,
    ts: row.updated_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

function mapAgent(row: AgentRow, online: boolean): AgentRecord {
  return {
    repo: row.repo,
    name: row.name,
    harness: row.harness,
    sessionId: row.session_id,
    wakeSessionId: row.wake_session_id ?? row.session_id,
    cwd: row.cwd,
    branch: row.branch,
    head: row.head,
    wake: row.wake === 1,
    lastSeen: row.last_seen,
    online,
    status: row.status,
    role: "worker",
  };
}

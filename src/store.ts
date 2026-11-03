import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, BusMessage, Kind, PendingAsk, AgentMetrics } from "./types.ts";

export function inboxCursorKey(clientKey: string, topic?: string): string {
  return topic ? JSON.stringify([clientKey, "topic", topic]) : clientKey;
}

// One definition of task completion for status, metrics, and the Stop gate.
const ANSWERED_ASK = `SELECT 1 FROM messages r WHERE r.repo = a.repo AND r.kind = 'reply'
  AND r.correlation_id = a.correlation_id AND r.from_name = a.to_name
  AND r.to_name = a.from_name AND r.seq > a.seq`;

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
  name TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT NOT NULL,
  wake INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo, name)
);

CREATE TABLE IF NOT EXISTS roles (
  repo TEXT NOT NULL PRIMARY KEY,
  orchestrator TEXT NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
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
           (repo, seq, id, topic, from_id, from_name, body, ts, kind, correlation_id, to_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      .prepare("SELECT * FROM messages WHERE repo = ? AND seq = ?")
      .get(repo, seq) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  byId(repo: string, id: string): BusMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE repo = ? AND id = ?")
      .get(repo, id) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  byCorrelation(repo: string, correlationId: string): BusMessage | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM messages WHERE repo = ? AND correlation_id = ? AND kind = 'ask' ORDER BY seq DESC LIMIT 1",
      )
      .get(repo, correlationId) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  /** Workspace-wide tracker: only a matching reply answers an ask, not a report or inbox read. */
  pendingAsks(repo: string, limit = 50, now = Date.now(), participant?: string): PendingAsk[] {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 50;
    const rows = this.db.prepare(
      `SELECT a.* FROM messages a
       WHERE a.repo = ? AND a.kind = 'ask' AND a.correlation_id IS NOT NULL
         AND (? IS NULL OR a.from_name = ? OR a.to_name = ?)
         AND NOT EXISTS (${ANSWERED_ASK})
       ORDER BY a.seq DESC LIMIT ?`,
    ).all(repo, participant ?? null, participant ?? null, participant ?? null, boundedLimit) as Row[];
    return rows.map((row) => ({
      id: row.id,
      correlation_id: row.correlation_id!,
      seq: row.seq,
      from: row.from_name,
      to: row.to_name,
      topic: row.topic,
      age_seconds: Math.max(0, Math.floor((now - row.ts) / 1000)),
      preview: row.body.replace(/\s+/g, " ").trim().slice(0, 160),
    }));
  }

  /** Cumulative board telemetry; first recipient reply per ask determines latency. */
  agentMetrics(repo: string, participant?: string): AgentMetrics[] {
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
             AND r.correlation_id = a.correlation_id AND r.from_name = a.to_name AND r.to_name = a.from_name AND r.seq > a.seq
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
       WHERE (? IS NULL OR names.agent = ?) ORDER BY names.agent`,
    ).all(repo, repo, repo, repo, repo, repo, participant ?? null, participant ?? null) as AgentMetrics[];
    return rows.map((row) => ({ ...row }));
  }

  unansweredAsk(
    repo: string,
    toName: string,
    cursor: number,
    minTs = 0,
  ): BusMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages a
         WHERE a.repo = ? AND a.to_name = ? AND a.kind = 'ask'
           AND a.seq <= ? AND a.ts >= ?
           AND a.correlation_id IS NOT NULL
           AND NOT EXISTS (${ANSWERED_ASK})
         ORDER BY a.seq DESC
         LIMIT 1`,
      )
      .get(repo, toName, cursor, minTs) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  inbox(repo: string, since: number, opts: { topic?: string; to?: string; limit: number }): BusMessage[] {
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const topic = opts.topic ?? null;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE repo = ? AND seq > ?
           AND (to_name IS NULL OR to_name = '*' OR to_name = ?)
           AND ((? IS NULL AND topic != 'presence') OR topic = ?)
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(repo, since, opts.to ?? "", topic, topic, limit) as Row[];
    return rows.map(mapMessage);
  }

  /** Read-only wait queries use the same visibility and topic cursor rules as inbox. */
  unreadForWait(repo: string, to: string, since: number, cursorKey = to, topic?: string): BusMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE repo = ?
         AND seq > MAX(?, COALESCE((SELECT MAX(cursor) FROM cursors WHERE repo = ? AND client_key = ?), 0))
         AND (to_name IS NULL OR to_name = '*' OR to_name = ?)
         AND ((? IS NULL AND topic != 'presence') OR topic = ?)
       ORDER BY seq ASC LIMIT 200`,
    ).all(repo, since, repo, inboxCursorKey(cursorKey, topic), to, topic ?? null, topic ?? null) as Row[];
    return rows.map(mapMessage);
  }

  latestUnreadSeq(repo: string, to: string, cursorKey = to, topic?: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE repo = ?
         AND seq > COALESCE((SELECT MAX(cursor) FROM cursors WHERE repo = ? AND client_key = ?), 0)
         AND (to_name IS NULL OR to_name = '*' OR to_name = ?)
         AND ((? IS NULL AND topic != 'presence') OR topic = ?)`,
    ).get(repo, repo, inboxCursorKey(cursorKey, topic), to, topic ?? null, topic ?? null) as { seq: number };
    return row.seq;
  }

  upsertAgent(agent: {
    repo: string;
    name: string;
    harness: string;
    sessionId: string | null;
    cwd: string;
    wake: boolean;
    status: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agents (repo, name, harness, session_id, cwd, wake, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, name) DO UPDATE SET
           harness = excluded.harness,
           session_id = COALESCE(excluded.session_id, agents.session_id),
           cwd = excluded.cwd,
           wake = excluded.wake,
           last_seen = excluded.last_seen,
           status = excluded.status`,
      )
      .run(
        agent.repo,
        agent.name,
        agent.harness,
        agent.sessionId,
        agent.cwd,
        agent.wake ? 1 : 0,
        now,
        agent.status,
      );
  }

  touchAgent(repo: string, name: string, status?: string): void {
    if (status === undefined) {
      this.db
        .prepare("UPDATE agents SET last_seen = ? WHERE repo = ? AND name = ?")
        .run(Date.now(), repo, name);
      return;
    }
    this.db
      .prepare("UPDATE agents SET last_seen = ?, status = ? WHERE repo = ? AND name = ?")
      .run(Date.now(), status, repo, name);
  }

  listRepos(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT repo FROM agents ORDER BY repo").all() as { repo: string }[];
    return rows.map((row) => row.repo);
  }

  /** Compare the scanned registration before changing it; preserve concurrent reconnects. */
  pruneAgent(expected: AgentRecord, reason: "dead_pane" | "stale"): boolean {
    const result = this.db.prepare(
      `UPDATE agents SET status = 'offline', session_id = CASE WHEN ? = 'dead_pane' THEN NULL ELSE session_id END
       WHERE repo = ? AND name = ? AND session_id IS ? AND last_seen = ? AND status = ?
         AND (status != 'offline' OR (? = 'dead_pane' AND session_id IS NOT NULL))`,
    ).run(reason, expected.repo, expected.name, expected.sessionId, expected.lastSeen, expected.status, reason);
    return result.changes > 0;
  }

  getOrchestrator(repo: string): string | null {
    const row = this.db
      .prepare("SELECT orchestrator FROM roles WHERE repo = ?")
      .get(repo) as { orchestrator: string } | undefined;
    return row?.orchestrator ?? null;
  }

  setOrchestrator(repo: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO roles (repo, orchestrator) VALUES (?, ?)
         ON CONFLICT(repo) DO UPDATE SET orchestrator = excluded.orchestrator`,
      )
      .run(repo, name);
  }

  getAgent(repo: string, name: string): AgentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE repo = ? AND name = ?")
      .get(repo, name) as AgentRow | undefined;
    return row ? mapAgent(row, false) : undefined;
  }

  listAgents(repo: string, onlineNames: Set<string>): AgentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agents WHERE repo = ? ORDER BY name")
      .all(repo) as AgentRow[];
    return rows.map((row) => mapAgent(row, onlineNames.has(row.name)));
  }
}

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
};

type AgentRow = {
  repo: string;
  name: string;
  harness: string;
  session_id: string | null;
  cwd: string;
  wake: number;
  last_seen: number;
  status: string;
};

function mapMessage(row: Row): BusMessage {
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
  };
}

function mapAgent(row: AgentRow, online: boolean): AgentRecord {
  return {
    repo: row.repo,
    name: row.name,
    harness: row.harness,
    sessionId: row.session_id,
    cwd: row.cwd,
    wake: row.wake === 1,
    lastSeen: row.last_seen,
    online,
    status: row.status,
    role: "worker",
  };
}

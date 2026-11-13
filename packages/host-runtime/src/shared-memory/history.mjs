import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { digest } from "./store.mjs";

const fingerprint = (file) => {
  const files = [file, file + "-wal"];
  return files
    .map((p) => {
      try {
        const s = statSync(p);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return "-";
      }
    })
    .join("|");
};
function* files(root, suffix) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(file, suffix);
    else if (entry.isFile() && entry.name.endsWith(suffix)) yield file;
  }
}
function json(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const flatten = (input) =>
  typeof input === "string"
    ? input
    : Array.isArray(input)
      ? input
          .map((v) => (typeof v?.text === "string" ? v.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";
export function putHistory(
  store,
  { agent = "codex", threadId, cwd = "", title = "", id, role, text, at, source },
) {
  if (!threadId || !["user", "agent"].includes(role) || !text?.trim()) return 0;
  // Bound index records while retaining every part of long messages.
  let count = 0;
  const parts = Math.ceil(text.length / 2900),
    prefix = `history:${agent}:${threadId}:${id}:`;
  store.db
    .prepare("DELETE FROM documents WHERE id>=? AND id<? AND CAST(substr(id,?) AS INTEGER)>=?")
    .run(prefix, prefix + "\uffff", prefix.length + 1, parts);
  for (let i = 0; i < parts; i++)
    count += Number(
      store.put({
        id: `history:${agent}:${threadId}:${id}:${i}`,
        kind: "history",
        agent,
        threadId,
        cwd,
        role,
        title,
        text: text.slice(i * 2900, i * 2900 + 3000),
        at,
        source,
      }),
    );
  return count;
}
function metadata(home, hostHome) {
  const threads = new Map(),
    native = new Map();
  const dbfile = path.join(home, "state_5.sqlite");
  if (existsSync(dbfile)) {
    const db = new DatabaseSync(dbfile, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT id,cwd,title,updated_at FROM threads").iterate())
        threads.set(row.id, {
          cwd: row.cwd,
          title: row.title,
          at: row.updated_at * 1000,
          agent: "codex",
        });
    } finally {
      db.close();
    }
  }
  for (const file of files(path.join(hostHome, "mapping-store/threads"), ".json")) {
    const row = json(file);
    if (!row?.hostThreadId) continue;
    const info = {
      threadId: row.hostThreadId,
      cwd: row.cwd || "",
      title: row.title || "",
      agent: row.harnessId || "external",
      at: Date.parse(row.updatedAt) || Date.now(),
    };
    threads.set(row.hostThreadId, info);
    if (row.nativeSessionRef?.nativeSessionId)
      native.set(row.nativeSessionRef.nativeSessionId, info);
  }
  return { threads, native };
}
function importNativeDatabase(store, meta, report) {
  const file = path.join(store.home, "thread_history_1.sqlite");
  const indexedThreads = new Set();
  if (!existsSync(file)) return indexedThreads;
  const fp = fingerprint(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const row of db
      .prepare(
        "SELECT DISTINCT thread_id FROM thread_items WHERE item_type IN ('userMessage','agentMessage')",
      )
      .iterate())
      indexedThreads.add(row.thread_id);
    if (store.fingerprint(file) === fp) {
      report.skipped++;
      return indexedThreads;
    }
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(thread_items)")
        .all()
        .map((row) => row.name),
    );
    const incremental = columns.has("rollout_ordinal") && columns.has("updated_at_ordinal");
    const cursors = new Map(
      store.db
        .prepare("SELECT thread_id,ordinal FROM history_progress WHERE source=?")
        .all(file)
        .map((row) => [row.thread_id, row.ordinal]),
    );
    const threads = incremental
      ? db
          .prepare(
            "SELECT thread_id,max(max(rollout_ordinal,updated_at_ordinal)) AS ordinal FROM thread_items GROUP BY thread_id",
          )
          .all()
      : [{ thread_id: null, ordinal: 0 }];
    const base =
      "SELECT thread_id,turn_id,item_id,item_type,item_json,created_at_ms FROM thread_items WHERE item_type IN ('userMessage','agentMessage')";
    const statement = db.prepare(
      base +
        (incremental
          ? " AND thread_id=? AND (rollout_ordinal>? OR updated_at_ordinal>?) ORDER BY rollout_ordinal"
          : " ORDER BY rowid"),
    );
    const saveCursor = store.db.prepare(
      "INSERT INTO history_progress VALUES(?,?,?) ON CONFLICT(source,thread_id) DO UPDATE SET ordinal=excluded.ordinal",
    );
    for (const cursor of threads) {
      const previous = cursors.get(cursor.thread_id) ?? -1;
      if (incremental && previous >= cursor.ordinal) continue;
      let batch = [];
      const flush = () => {
        store.transaction(() => {
          for (const row of batch) {
            let item;
            try {
              item = JSON.parse(row.item_json);
            } catch {
              continue;
            }
            const info = meta.threads.get(row.thread_id) || {};
            report.changed += putHistory(store, {
              ...info,
              threadId: row.thread_id,
              id: row.turn_id + ":" + row.item_id,
              role: row.item_type === "userMessage" ? "user" : "agent",
              text: row.item_type === "userMessage" ? flatten(item.content) : item.text,
              at: row.created_at_ms || info.at,
              source: file,
            });
            report.messages++;
          }
        });
        batch = [];
      };
      const args = incremental ? [cursor.thread_id, previous, previous] : [];
      for (const row of statement.iterate(...args)) {
        batch.push(row);
        if (batch.length >= 200) flush();
      }
      if (batch.length) flush();
      if (incremental) saveCursor.run(file, cursor.thread_id, cursor.ordinal);
    }
    // Deletions in the source chat store also remove its derived index entries.
    for (const row of store.db
      .prepare("SELECT DISTINCT thread_id FROM documents WHERE source=? AND kind='history'")
      .all(file)) {
      if (!indexedThreads.has(row.thread_id))
        store.db
          .prepare("DELETE FROM documents WHERE source=? AND thread_id=? AND kind='history'")
          .run(file, row.thread_id);
    }
    store.indexed(file, fp);
    report.sources++;
  } finally {
    db.close();
  }
  return indexedThreads;
}
async function importRollout(store, file, indexedThreads, meta, report, agent = "codex") {
  const fp = fingerprint(file);
  if (store.fingerprint(file) === fp) {
    report.skipped++;
    return;
  }
  let threadId,
    info = {},
    turnId = "",
    ordinal = 0;
  const responses = [],
    events = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    ordinal++;
    const payload = row.payload || row;
    if (row.type === "session_meta") {
      threadId = payload.id;
      info = { cwd: payload.cwd || "", ...meta.threads.get(threadId) };
      if (indexedThreads.has(threadId)) {
        lines.close();
        lines.input.destroy();
        store.indexed(file, fp);
        report.skipped++;
        return;
      }
    }
    if (payload.type === "turn_started" && payload.turn_id) turnId = payload.turn_id;
    if (
      row.type === "response_item" &&
      payload.type === "message" &&
      ["user", "assistant"].includes(payload.role)
    )
      responses.push({
        role: payload.role === "user" ? "user" : "agent",
        text: flatten(payload.content),
        id: payload.id || `${turnId}:${ordinal}`,
        at: Date.parse(row.timestamp) || info.at,
      });
    else if (row.type === "event_msg" && ["user_message", "agent_message"].includes(payload.type))
      events.push({
        role: payload.type === "user_message" ? "user" : "agent",
        text: payload.message,
        id: `${turnId}:${ordinal}`,
        at: Date.parse(row.timestamp) || info.at,
      });
    // Claude Code uses a message envelope rather than Codex rollout events.
    if (agent === "claude-code" && ["user", "assistant"].includes(row.type) && row.message) {
      threadId ||= row.sessionId;
      info.cwd ||= row.cwd || "";
      responses.push({
        role: row.type === "user" ? "user" : "agent",
        text: flatten(row.message.content),
        id: row.uuid || String(ordinal),
        at: Date.parse(row.timestamp),
      });
    }
  }
  threadId ||= path.basename(file, ".jsonl");
  store.transaction(() => {
    for (const row of responses.length ? responses : events) {
      report.changed += putHistory(store, { ...info, agent, threadId, ...row, source: file });
      report.messages++;
    }
  });
  store.indexed(file, fp);
  report.sources++;
}
function importAntigravity(store, file, meta, report) {
  const fp = fingerprint(file);
  if (store.fingerprint(file) === fp) {
    report.skipped++;
    return;
  }
  const data = json(file);
  if (!data || !Array.isArray(data.turns)) return;
  const info = meta.native.get(data.nativeSessionId) || {
    agent: "antigravity",
    threadId: data.nativeSessionId || path.basename(file, ".json"),
  };
  store.transaction(() => {
    for (const [index, turn] of data.turns.entries()) {
      const turnId = turn.nativeTurnRef?.nativeTurnKey || String(index);
      const input = flatten(turn.input);
      report.changed += putHistory(store, {
        ...info,
        id: turnId + ":input",
        role: "user",
        text: input,
        source: file,
      });
      report.messages++;
      for (const [n, snapshot] of (turn.items || []).entries()) {
        const item = snapshot.item || snapshot;
        if (!["agentMessage", "agent_message"].includes(item.type)) continue;
        report.changed += putHistory(store, {
          ...info,
          id: turnId + ":" + (item.itemId || n),
          role: "agent",
          text: item.text,
          source: file,
        });
        report.messages++;
      }
    }
  });
  store.indexed(file, fp);
  report.sources++;
}
export async function indexHistory(
  store,
  {
    hostHome = path.join(os.homedir(), ".codexhost"),
    claudeHome = path.join(os.homedir(), ".claude"),
  } = {},
) {
  const report = { sources: 0, skipped: 0, messages: 0, changed: 0, errors: [] };
  const meta = metadata(store.home, hostHome);
  let indexedThreads = new Set();
  try {
    indexedThreads = importNativeDatabase(store, meta, report);
  } catch (error) {
    report.errors.push({ source: "Codex history database", error: error.message });
  }
  for (const dir of ["sessions", "archived_sessions"])
    for (const file of files(path.join(store.home, dir), ".jsonl")) {
      try {
        await importRollout(store, file, indexedThreads, meta, report);
      } catch (error) {
        report.errors.push({ source: file, error: error.message });
      }
    }
  for (const file of files(path.join(hostHome, "antigravity-history"), ".json")) {
    try {
      importAntigravity(store, file, meta, report);
    } catch (error) {
      report.errors.push({ source: file, error: error.message });
    }
  }
  for (const file of files(path.join(claudeHome, "projects"), ".jsonl")) {
    try {
      await importRollout(store, file, new Set(), meta, report, "claude-code");
    } catch (error) {
      report.errors.push({ source: file, error: error.message });
    }
  }
  return report;
}

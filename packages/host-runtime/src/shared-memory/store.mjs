import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const codexHome = () =>
  path.resolve(
    process.env.CODEXHOST_SHARED_CODEX_HOME ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), ".codex"),
  );
export function redact(text) {
  return String(text ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}=*/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|api_key|access_token)=)[^\s&"<>]+/gi, "$1[REDACTED]");
}
export function tokens(value) {
  const result = [];
  for (const word of String(value)
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{Script=Han}]+|[a-z0-9_./-]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length === 1) result.push(word);
      else for (let i = 0; i < word.length - 1; i++) result.push(word.slice(i, i + 2));
    } else if (word.length > 1) result.push(word);
  }
  return [...new Set(result)].slice(0, 4096);
}
export const normalizeScope = (cwd, global = false) =>
  global || cwd === "global" ? "global" : path.resolve(cwd || process.cwd());
const scopeMatches = (scope, cwd) =>
  scope === "global" || cwd === scope || cwd.startsWith(scope + path.sep);

export class MemoryStore {
  constructor(home = codexHome()) {
    this.home = path.resolve(home);
    this.directory = path.join(this.home, "memories");
    mkdirSync(this.directory, { recursive: true });
    this.filename = path.join(this.directory, "shared-memory.sqlite");
    this.db = new DatabaseSync(this.filename);
    chmodSync(this.filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS documents(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
        thread_id TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, tokens TEXT NOT NULL,
        updated_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_scope ON documents(kind,cwd);
      CREATE INDEX IF NOT EXISTS documents_thread ON documents(thread_id,updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(tokens,content='documents',content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid,tokens) VALUES(new.rowid,new.tokens); END;
      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts,rowid,tokens) VALUES('delete',old.rowid,old.tokens); END;
      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts,rowid,tokens) VALUES('delete',old.rowid,old.tokens);
        INSERT INTO documents_fts(rowid,tokens) VALUES(new.rowid,new.tokens); END;
      CREATE TABLE IF NOT EXISTS memory_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, action TEXT NOT NULL,
        agent TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,indexed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_progress(source TEXT NOT NULL,thread_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(source,thread_id));`);
    this.putStatement = this.db
      .prepare(`INSERT INTO documents(id,kind,agent,thread_id,cwd,role,title,text,tokens,updated_at,source,hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,agent=excluded.agent,
      thread_id=excluded.thread_id,cwd=excluded.cwd,role=excluded.role,title=excluded.title,text=excluded.text,
      tokens=excluded.tokens,updated_at=excluded.updated_at,source=excluded.source,hash=excluded.hash
      WHERE documents.hash<>excluded.hash OR documents.title<>excluded.title OR documents.cwd<>excluded.cwd`);
  }
  close() {
    this.db.close();
  }
  put(doc) {
    const text = redact(doc.text).trim();
    if (!text) return false;
    if (text.length > 1_000_000) throw new Error("Document is too large");
    return (
      this.putStatement.run(
        doc.id,
        doc.kind,
        doc.agent || "",
        doc.threadId || "",
        doc.cwd || "",
        doc.role || "",
        doc.title || "",
        text,
        tokens((doc.title || "") + " " + text).join(" "),
        doc.at || Date.now(),
        doc.source || "",
        digest(text),
      ).changes > 0
    );
  }
  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  remember(text, { cwd, global = false, agent = "unknown", threadId = "", id } = {}) {
    text = redact(text).trim();
    if (!text || text.length > 16_000) throw new Error("Memory must contain 1–16000 characters");
    const scope = normalizeScope(cwd, global);
    id ||=
      "memory:" +
      digest(scope + "\0" + text.normalize("NFKC").replace(/\s+/g, " ").trim()).slice(0, 24);
    if (!/^memory:[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid memory ID");
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT cwd FROM documents WHERE id=? AND kind=?")
        .get(id, "memory");
      if (previous && previous.cwd !== scope)
        throw new Error("Cannot move a memory across scopes by updating its ID");
      const changed = this.put({
        id,
        kind: "memory",
        cwd: scope,
        agent,
        threadId,
        text,
        source: "shared-memory",
        at: Date.now(),
      });
      if (changed)
        this.db
          .prepare(
            "INSERT INTO memory_events(id,action,agent,thread_id,at,text) VALUES(?,?,?,?,?,?)",
          )
          .run(id, "remember", agent, threadId, Date.now(), text);
      return { id, scope, changed };
    });
  }
  forget(id, agent = "unknown", threadId = "") {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM documents WHERE id=? AND kind='memory'").get(id);
      if (!row) return { id, removed: false };
      this.db
        .prepare("INSERT INTO memory_events(id,action,agent,thread_id,at,text) VALUES(?,?,?,?,?,?)")
        .run(id, "forget", agent, threadId, Date.now(), row.text);
      this.db.prepare("DELETE FROM documents WHERE id=? AND kind='memory'").run(id);
      return { id, removed: true };
    });
  }
  list({ cwd = process.cwd(), all = false, limit = 100 } = {}) {
    return this.db
      .prepare("SELECT * FROM documents WHERE kind='memory' ORDER BY updated_at DESC")
      .all()
      .filter((row) => all || scopeMatches(row.cwd, path.resolve(cwd)))
      .slice(0, Math.min(limit, 500));
  }
  search(query, { kind, cwd, all = false, limit = 8, excludeThreadId } = {}) {
    const terms = tokens(query).slice(0, 32);
    if (!terms.length) return [];
    const conditions = [],
      parameters = [];
    if (kind === "memory") {
      conditions.push("d.kind IN ('memory','native-memory')");
    } else if (kind) {
      conditions.push("d.kind=?");
      parameters.push(kind);
    }
    if (excludeThreadId) {
      conditions.push("d.thread_id<>?");
      parameters.push(excludeThreadId);
    }
    if (cwd && !all) {
      const scope = path.resolve(cwd);
      if (kind === "memory") {
        const ancestors = ["global"];
        let cursor = scope;
        while (true) {
          ancestors.push(cursor);
          const parent = path.dirname(cursor);
          if (parent === cursor) break;
          cursor = parent;
        }
        conditions.push(`d.cwd IN (${ancestors.map(() => "?").join(",")})`);
        parameters.push(...ancestors);
      } else {
        conditions.push("d.cwd=?");
        parameters.push(scope);
      }
    }
    const where = conditions.length ? " AND " + conditions.join(" AND ") : "";
    const rows = this.db
      .prepare(
        `SELECT d.*,bm25(documents_fts) AS rank FROM documents_fts
      JOIN documents d ON d.rowid=documents_fts.rowid WHERE documents_fts MATCH ?${where}
      ORDER BY rank LIMIT 300`,
      )
      .all(terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" OR "), ...parameters);
    const seen = new Set();
    return rows
      .filter((row) => {
        const key = row.cwd + "\0" + row.thread_id + "\0" + row.role + "\0" + row.hash;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((row) => ({
        ...row,
        score: -row.rank + (row.text.toLowerCase().includes(String(query).toLowerCase()) ? 5 : 0),
      }))
      .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map((row) => {
        const lower = row.text.toLowerCase();
        let position = lower.indexOf(String(query).toLowerCase());
        if (position < 0)
          position = Math.max(0, ...terms.map((t) => lower.indexOf(t)).filter((n) => n >= 0));
        const start = Math.max(0, position - 100);
        return {
          id: row.id,
          kind: row.kind,
          agent: row.agent,
          threadId: row.thread_id,
          cwd: row.cwd,
          role: row.role,
          title: row.title,
          at: row.updated_at,
          source: row.source,
          snippet: row.text.slice(start, start + 800),
          score: row.score,
        };
      });
  }
  read(id) {
    return (
      this.db
        .prepare(
          "SELECT id,kind,agent,thread_id AS threadId,cwd,role,title,text,updated_at AS at,source FROM documents WHERE id=?",
        )
        .get(id) || null
    );
  }
  fingerprint(source) {
    return this.db.prepare("SELECT fingerprint FROM sources WHERE path=?").get(source)?.fingerprint;
  }
  indexed(source, fingerprint) {
    this.db
      .prepare(
        "INSERT INTO sources VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,indexed_at=excluded.indexed_at",
      )
      .run(source, fingerprint, Date.now());
  }
  stats() {
    return {
      path: this.filename,
      documents: this.db
        .prepare("SELECT kind,count(*) AS count FROM documents GROUP BY kind")
        .all(),
      sources: this.db.prepare("SELECT count(*) AS count FROM sources").get().count,
    };
  }
}

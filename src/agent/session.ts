import { promises as fs } from "node:fs";
import path from "node:path";
import { EMPTY_USAGE, type Message, type Usage } from "../types.js";
import { oneLine } from "../util/text.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  title: string;
  messageCount: number;
}

export interface SessionInit {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  cwd: string;
  provider: string;
  model: string;
  title?: string;
  messages?: Message[];
  usage?: Usage;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 6);
}

export function newSessionId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
  return `${stamp}-${randomSuffix()}`;
}

export function sessionsDir(cwd: string): string {
  return path.join(cwd, ".anycode", "sessions");
}

export class Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  title: string;
  messages: Message[];
  usage: Usage;

  constructor(init: SessionInit) {
    const now = new Date().toISOString();
    this.id = init.id ?? newSessionId();
    this.createdAt = init.createdAt ?? now;
    this.updatedAt = init.updatedAt ?? now;
    this.cwd = init.cwd;
    this.provider = init.provider;
    this.model = init.model;
    this.title = init.title ?? "";
    this.messages = init.messages ?? [];
    this.usage = init.usage ?? { ...EMPTY_USAGE };
  }

  static create(options: { cwd: string; provider: string; model: string }): Session {
    return new Session(options);
  }

  static async load(cwd: string, id: string): Promise<Session> {
    const file = path.join(sessionsDir(cwd), `${id}.json`);
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw) as SessionInit & { messages?: Message[] };
    return new Session({ ...data, cwd: data.cwd ?? cwd });
  }

  touch(userText: string): void {
    this.updatedAt = new Date().toISOString();
    if (!this.title) this.title = oneLine(userText, 70);
  }

  toJSON(): SessionInit & { messageCount: number } {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      cwd: this.cwd,
      provider: this.provider,
      model: this.model,
      title: this.title,
      messages: this.messages,
      usage: this.usage,
      messageCount: this.messages.length,
    };
  }

  meta(): SessionMeta {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      cwd: this.cwd,
      provider: this.provider,
      model: this.model,
      title: this.title,
      messageCount: this.messages.length,
    };
  }

  async save(): Promise<string> {
    this.updatedAt = new Date().toISOString();
    const dir = sessionsDir(this.cwd);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this.id}.json`);
    await fs.writeFile(file, `${JSON.stringify(this.toJSON(), null, 2)}\n`, "utf8");
    return file;
  }
}

export async function listSessions(cwd: string, limit = 30): Promise<SessionMeta[]> {
  const dir = sessionsDir(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const metas: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const data = JSON.parse(raw) as Partial<SessionMeta> & { messages?: Message[] };
      if (!data.id) continue;
      metas.push({
        id: data.id,
        createdAt: data.createdAt ?? "",
        updatedAt: data.updatedAt ?? data.createdAt ?? "",
        cwd: data.cwd ?? cwd,
        provider: data.provider ?? "",
        model: data.model ?? "",
        title: data.title ?? "(untitled)",
        messageCount: data.messages?.length ?? data.messageCount ?? 0,
      });
    } catch {
      // ignore malformed session files
    }
  }

  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return metas.slice(0, limit);
}

export async function latestSession(cwd: string): Promise<Session | undefined> {
  const [meta] = await listSessions(cwd, 1);
  if (!meta) return undefined;
  return Session.load(cwd, meta.id);
}

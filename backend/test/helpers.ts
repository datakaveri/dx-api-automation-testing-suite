import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SequelizeResultsStore } from "../src/repositories/sequelizeResultsStore";
import type { CollectionState } from "../src/types";

// The real results store over an in-memory stand-in for the Sequelize model.
export function memoryStore(initial: Record<string, CollectionState> = {}) {
  const rows = new Map(Object.entries(initial));
  const model = {
    findAll: async () => [...rows].map(([collectionId, state]) => ({ collectionId, state })),
    upsert: async ({ collectionId, state }: { collectionId: string; state: CollectionState }) => {
      rows.set(collectionId, structuredClone(state));
    },
  };
  return { store: new SequelizeResultsStore(model as never), rows };
}

// The real settings store needs only findByPk and upsert from its model.
export function memorySettingsModel(value?: unknown) {
  const rows = new Map<string, unknown>(value === undefined ? [] : [["auto-rerun", value]]);
  return {
    rows,
    model: {
      findByPk: async (key: string) => (rows.has(key) ? { value: rows.get(key) } : null),
      upsert: async ({ key, value: next }: { key: string; value: unknown }) => {
        rows.set(key, next);
      },
    } as never,
  };
}

export interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

export function memoryLogger() {
  const entries: LogEntry[] = [];
  const log = (level: LogEntry["level"]) => (message: string, metadata?: Record<string, unknown>) => {
    entries.push({ level, message, metadata });
  };
  return { entries, info: log("info"), warn: log("warn"), error: log("error") };
}

// A throwaway collections directory: { "Folder/file.json": contents }.
export async function collectionsDir(files: Record<string, unknown>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "iudxqa-test-"));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const postmanCollection = (name: string, item: unknown[] = []) => ({
  info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item,
});

export const postmanEnvironment = (values: Array<{ key: string; value: string; type?: string }> = []) => ({
  name: "env",
  values: values.map((value) => ({ enabled: true, type: "default", ...value })),
});

export async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

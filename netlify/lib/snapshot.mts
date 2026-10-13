// On-demand snapshots of one workspace's data, taken just before something
// risky (an import, an undo). Copies every section of the workspace from
// visocex-data into the backups store, checks each copy by reading it back,
// and only then writes the manifest — a snapshot without a manifest never
// counts. The nightly backup (backup.mts) is separate and only touches daily/.
//
// Layout in the "visocex-backups" store:
//   snapshots/<tenantId>/<snapshotId>/<section>     — copy of <tenantId>__<section>, original metadata kept
//   snapshot-manifests/<tenantId>/<snapshotId>      — { id, tenantId, createdAt, createdBy, reason, sections[] }
//
// Snapshots older than KEEP_DAYS are removed when a new one is taken. Recent
// ones are never removed to make room: past MAX_RECENT a new snapshot is
// refused instead, so taking lots of snapshots can't push out the one taken
// before an import.

import { createHash, randomBytes } from "node:crypto";
import { BACKUP_STORE } from "./backup.mts";

export const KEEP_DAYS = 30;
export const MAX_RECENT = 50;
const DATA_STORE = "visocex-data";

type StoreFactory = (opts: any) => any;

const sha256 = (buf: ArrayBuffer | Uint8Array) => createHash("sha256").update(Buffer.from(buf as ArrayBuffer)).digest("hex");

function newSnapshotId(now: Date) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
}

export async function listSnapshots(getStore: StoreFactory, tenantId: string) {
  const backups = getStore({ name: BACKUP_STORE, consistency: "strong" });
  const { blobs } = await backups.list({ prefix: `snapshot-manifests/${tenantId}/` });
  const out = [];
  for (const { key } of blobs) {
    const m = await backups.get(key, { type: "json" });
    if (m) out.push(m);
  }
  return out.sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function deleteSnapshot(backups: any, tenantId: string, id: string) {
  const { blobs } = await backups.list({ prefix: `snapshots/${tenantId}/${id}/` });
  for (const { key } of blobs) await backups.delete(key);
  await backups.delete(`snapshot-manifests/${tenantId}/${id}`);
}

export class SnapshotRefused extends Error {}

export async function takeSnapshot(getStore: StoreFactory, tenantId: string, opts: { createdBy?: string; reason?: string; now?: Date } = {}) {
  const now = opts.now || new Date();
  const backups = getStore({ name: BACKUP_STORE, consistency: "strong" });
  const data = getStore({ name: DATA_STORE, consistency: "strong" });

  // Tidy up first: drop snapshots past KEEP_DAYS, then refuse if too many recent ones remain.
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const existing = await listSnapshots(getStore, tenantId);
  const expired = existing.filter((m: any) => m.createdAt < cutoff);
  for (const m of expired) await deleteSnapshot(backups, tenantId, m.id);
  if (existing.length - expired.length >= MAX_RECENT) {
    throw new SnapshotRefused(`This workspace already has ${MAX_RECENT} snapshots from the last ${KEEP_DAYS} days. Older ones are removed automatically after ${KEEP_DAYS} days.`);
  }

  const id = newSnapshotId(now);
  const prefix = `${tenantId}__`;
  const { blobs } = await data.list({ prefix });
  const sections: any[] = [];
  try {
    for (const { key } of blobs) {
      const res = await data.getWithMetadata(key, { type: "arrayBuffer" });
      if (!res) continue; // deleted between list and read
      const section = key.slice(prefix.length);
      const target = `snapshots/${tenantId}/${id}/${section}`;
      await backups.set(target, res.data, { metadata: res.metadata || {} });
      // Read the copy back: a snapshot only counts if every copy is intact.
      const back = await backups.get(target, { type: "arrayBuffer" });
      const hash = sha256(res.data);
      if (!back || sha256(back) !== hash) throw new Error(`copy of "${section}" didn't read back correctly`);
      let items: number | null = null;
      try { const v = JSON.parse(new TextDecoder().decode(res.data)); if (Array.isArray(v)) items = v.length; } catch { /* not JSON */ }
      sections.push({ section, bytes: res.data.byteLength, sha256: hash, items, version: (res.metadata && res.metadata.version) || null });
    }
  } catch (err) {
    // Leave nothing half-made behind.
    try { await deleteSnapshot(backups, tenantId, id); } catch { /* best effort */ }
    throw err;
  }

  const manifest = {
    id, tenantId,
    createdAt: now.toISOString(),
    createdBy: opts.createdBy || "",
    reason: String(opts.reason || "").slice(0, 200),
    sections: sections.sort((a, b) => a.section.localeCompare(b.section)),
    totalBytes: sections.reduce((n, s) => n + s.bytes, 0),
  };
  await backups.setJSON(`snapshot-manifests/${tenantId}/${id}`, manifest);
  return manifest;
}

// Daily backup of all workspace data into a separate Netlify Blobs store.
//
// Layout of the "visocex-backups" store:
//   daily/<YYYY-MM-DD>/<source store>/<original key>  — full copy, original metadata kept
//   manifests/<YYYY-MM-DD>                            — what was copied (counts per store/workspace)
//   assets/<original key>                             — uploaded files, copied once (they never change)
//   status/last-run, status/last-success              — written by the scheduled function
//
// Kept separate from the function itself so it can be tested against a fake
// store and reused by a manual "back up now" or restore script.

export const BACKUP_STORE = "visocex-backups";
// Copied in full every day. Session/invite/reset tokens are deliberately not
// backed up — they're short-lived and restoring them would revive old logins.
export const DAILY_SOURCES = ["visocex-data", "visocex-tenants", "visocex-report-jobs"];
// Uploaded files are immutable (random UUID keys, never overwritten), so they
// are copied incrementally instead of every day.
export const ASSET_SOURCE = "visocex-asset-files";
export const RETENTION_DAYS = 30;

type StoreFactory = (name: string) => any;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function daysBefore(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function runBackup(getStore: StoreFactory, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const backups = getStore(BACKUP_STORE);
  const manifest: any = { day, startedAt: now.toISOString(), stores: {}, workspaces: {} };

  let expected = 0;
  for (const name of DAILY_SOURCES) {
    const src = getStore(name);
    const { blobs } = await src.list();
    let copied = 0, bytes = 0;
    await mapLimit(blobs, 8, async ({ key }: { key: string }) => {
      const res = await src.getWithMetadata(key, { type: "arrayBuffer" });
      if (!res) return; // deleted between list and read
      await backups.set(`daily/${day}/${name}/${key}`, res.data, { metadata: res.metadata || {} });
      copied++;
      bytes += res.data.byteLength;
      if (name === "visocex-data") {
        const i = key.indexOf("__");
        const ws = i < 0 ? "(no workspace)" : key.slice(0, i);
        const w = (manifest.workspaces[ws] ||= { sections: 0, items: 0 });
        w.sections++;
        try {
          const v = JSON.parse(new TextDecoder().decode(res.data));
          if (Array.isArray(v)) w.items += v.length;
        } catch { /* non-JSON value: counted as a section only */ }
      }
    });
    manifest.stores[name] = { keys: copied, bytes };
    expected += copied;
  }

  // Check every copy actually landed before calling it a success.
  const { blobs: written } = await backups.list({ prefix: `daily/${day}/` });
  if (written.length !== expected) {
    throw new Error(`verification failed: expected ${expected} copies under daily/${day}/, found ${written.length}`);
  }

  const assets = getStore(ASSET_SOURCE);
  const { blobs: assetBlobs } = await assets.list();
  const { blobs: backedUpAssets } = await backups.list({ prefix: "assets/" });
  const have = new Set(backedUpAssets.map((b: { key: string }) => b.key.slice("assets/".length)));
  let newAssets = 0;
  await mapLimit(assetBlobs.filter((b: { key: string }) => !have.has(b.key)), 4, async ({ key }: { key: string }) => {
    const res = await assets.getWithMetadata(key, { type: "arrayBuffer" });
    if (!res) return;
    await backups.set(`assets/${key}`, res.data, { metadata: res.metadata || {} });
    newAssets++;
  });
  manifest.assets = { total: assetBlobs.length, newlyCopied: newAssets };

  manifest.finishedAt = new Date().toISOString();
  await backups.setJSON(`manifests/${day}`, manifest);

  // Keep the most recent RETENTION_DAYS days (today included).
  const cutoff = daysBefore(day, RETENTION_DAYS);
  const { directories } = await backups.list({ prefix: "daily/", directories: true });
  const pruned: string[] = [];
  for (const dir of directories as string[]) {
    const oldDay = dir.replace(/^daily\//, "").replace(/\/$/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(oldDay) || oldDay > cutoff) continue;
    const { blobs: old } = await backups.list({ prefix: `daily/${oldDay}/` });
    await mapLimit(old, 8, async ({ key }: { key: string }) => { await backups.delete(key); });
    await backups.delete(`manifests/${oldDay}`);
    pruned.push(oldDay);
  }
  manifest.pruned = pruned;
  return manifest;
}

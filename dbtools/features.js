/**
 * features.js — parts of the DB tools that are built but held back.
 *
 * TABLE_COPIES covers everything that copies a whole table: the panel's
 * 📸 Snapshot and 🗄 Backup, the snapshots and backup tables listed on the
 * manager page, the settings for them, and the Playback guard — which works by
 * snapshotting tables before a run. Off, none of it is offered and none of it
 * runs, including for sessions that already hold a snapshot or a backup. The
 * code stays; only the ways in are closed.
 *
 * Held back until snapshot storage (snapstore.js, IndexedDB instead of the
 * unlimitedStorage permission) has been through a real run against Adminer.
 */
export const TABLE_COPIES = false;

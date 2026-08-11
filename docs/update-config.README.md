# `update-config.json` — critical-release kill switch

Published at
<https://kt-hg.github.io/Fast-Recorder---Playback/update-config.json>
and fetched by every install once a day, alongside the Web Store version check
(`bg/remote-config.js`).

A version floor cannot live inside the extension: users running the broken build
would have to update in order to receive the rule telling them to update. This
file is that rule, hosted where the old build can still read it.

## One-time setup

GitHub → repo **Settings → Pages** → *Source*: **Deploy from a branch**,
branch `main`, folder **`/docs`**. Confirm the URL above returns JSON before
relying on it.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `minVersion` | `"1.2.3"` | Lowest version considered safe. Must be digits and dots (up to 4 parts). |
| `hardLock` | `true` / `false` | `true` locks every install below `minVersion` **immediately**, skipping the 30-day grace period. Strictly the boolean — `"true"` is ignored. |
| `message` | string | Shown in the banner, the toast and the notification. Max 240 chars, rendered as text. Empty falls back to a generic wording. |

## Shipping a critical fix

1. Publish the fixed version to the Web Store and wait until it is live —
   step 2 does nothing until the store actually serves the new version.
2. Set `minVersion` to the fixed version, `hardLock` to `true`, write a
   `message`, commit to `main`. Pages redeploys in about a minute.
3. Installs pick it up within a day (sooner if the user hits *Check for updates*
   in Settings). Chrome downloads the new CRX on its own schedule; once it has,
   the extension restarts itself to apply it — see `maybeAutoApply()`.
4. Once the release has rolled out, set `hardLock` back to `false`.

## Safety rules built into the client

These are deliberate: this file can disable the extension for everyone, so the
client refuses to act on it in any situation where locking would be a dead end.

* **No lock without a real update.** A hard lock only applies when Chrome has
  independently confirmed a newer version exists on the store. A wrong
  `minVersion` — or a compromised host — therefore cannot strand anyone on a
  version with nowhere to go.
* **Fail-open.** Unreachable, non-200, malformed or unparseable means *no lock*.
  A hosting outage must never brick installs.
* **Expiry.** A cached config that has not refreshed in 7 days stops applying,
  so deleting this file lifts the lock instead of freezing it forever.
* **Never on dev builds.** Unpacked installs cannot be version-checked, so they
  never lock.
* **Bounded auto-restart.** The self-apply reload runs only when Chrome reports
  the CRX already downloaded, at most once per 30 minutes and 3 times per
  version, and never during a recording or playback run.

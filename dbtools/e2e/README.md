# End-to-end test — Adminer rollback

`dbtools/selftest.mjs` covers the arithmetic: which SQL an undo produces, what a
predicate looks like when the primary key moved, which statements are refused.
It cannot cover the half of this feature that is a claim about somebody else's
HTML, and that half is where the bugs were:

* Adminer 4.8.1 emits **no** `<meta name="generator">`, so detection leans on the
  masthead in its menu instead.
* The driver is the **name** of a query parameter, not a value: `?sqlite=`,
  `?pgsql=host`, `?server=host` for MySQL. Reading it as `driver=` sent every
  request to the login page, which parses perfectly well as "no rows found".
* `textarea[name=query]` on the SQL page is **hidden** and holds the *previous*
  statement; the live one is in a `<pre contenteditable>` next to it.

So this runs a real Adminer over a real database, through the real extension, in
a real browser.

## Running it

```bash
# terminal 1 — Adminer 4.8.1 over a seeded SQLite database
bash dbtools/e2e/setup.sh

# terminal 2
npm install playwright        # once; or use an existing install
node dbtools/e2e/run.mjs
```

Both take an optional base URL: `node dbtools/e2e/run.mjs http://127.0.0.1:8123/index.php`.

The run loads the unpacked extension into Chromium, logs into Adminer, and
checks that:

1. the panel mounts and a session can be started;
2. editing a row through `?edit=` records the values it had;
3. a hand-written `UPDATE` on the SQL page snapshots the rows it is about to
   change, before it runs;
4. rolling the session back restores every value exactly — including a NULL that
   was replaced by text, and an empty string that must not come back as NULL;
5. deleting a row records enough to re-insert it;
6. a row changed by someone else in the meantime is reported as drift and left
   alone, while the rest of the session still rolls back;
7. the manager page lists the session, its changes and their before/after.

It reseeds the database itself, so it can be run repeatedly.

## When Adminer changes

If a new Adminer version breaks something, this run says which of the seven
above stopped working, and `dbtools/adapters/adminer.js` is the only file that
should need to change.

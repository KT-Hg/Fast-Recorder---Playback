#!/usr/bin/env bash
# setup.sh — a real Adminer to test against.
#
# The rollback feature is defined by Adminer's HTML: which input holds a column,
# how a NULL is spelled, where the query really lives on the SQL page. None of
# that can be asserted from a unit test, and every one of those answers turned
# out to be different from the obvious guess. So the end-to-end run drives an
# actual Adminer over an actual database.
#
# SQLite is used because it needs no server. Adminer refuses a passwordless
# login, which a SQLite database has no answer to, so index.php wraps it with a
# login override — local test scaffolding, never something to deploy.
#
# Usage:  bash dbtools/e2e/setup.sh [dir] [port]
set -euo pipefail

DIR="${1:-/tmp/adminer-e2e}"
PORT="${2:-8123}"
VERSION="4.8.1"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f adminer.php ]; then
  echo "Downloading Adminer $VERSION…"
  curl -sSL -o adminer.php \
    "https://github.com/vrana/adminer/releases/download/v$VERSION/adminer-$VERSION.php"
fi

cat > index.php <<'PHP'
<?php
// Local test scaffolding only: Adminer refuses to log in without a password and
// a SQLite file has none to give.
function adminer_object() {
  class TestAdminer extends Adminer {
    function login($login, $password) { return true; }
  }
  return new TestAdminer;
}
include './adminer.php';
PHP

php -r '
$db = new SQLite3("test.db");
$db->exec("CREATE TABLE IF NOT EXISTS m_generic (id INTEGER PRIMARY KEY, code TEXT, value TEXT, note TEXT, updated_at TEXT)");
$db->exec("DELETE FROM m_generic");
$seed = [[1,"TAX","10","thue"],[2,"CUR","VND",null],[3,"MST","0101","ma so thue"],[4,"LIM","100",""],[5,"FLG","Y","co"]];
foreach ($seed as $r) {
  $s = $db->prepare("INSERT INTO m_generic (id,code,value,note,updated_at) VALUES (?,?,?,?,?)");
  $s->bindValue(1,$r[0]); $s->bindValue(2,$r[1]); $s->bindValue(3,$r[2]);
  if ($r[3] === null) $s->bindValue(4, null, SQLITE3_NULL); else $s->bindValue(4, $r[3]);
  $s->bindValue(5, "2026-01-01 00:00:00");
  $s->execute();
}
echo "seeded " . $db->querySingle("SELECT COUNT(*) FROM m_generic") . " rows\n";
'

echo "Serving $DIR on http://127.0.0.1:$PORT/index.php  (Ctrl+C to stop)"
PHP_CLI_SERVER_WORKERS=8 php -S "127.0.0.1:$PORT" -t .

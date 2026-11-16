#!/usr/bin/env bash
# Screenshots of every panel view, in light and dark, into .orca/shots/p1, p2, p4, p5, p6 and p7.
#
# `orca plugin shot --act/--scenario/--theme` only works while Orca's window is hidden or
# minimized. Hide it (or switch to a session whose compositor can minimize it), run this, and keep
# the window hidden until it ends (about two minutes). Needs the dev replica set seeded and a saved
# connection named "Local dev (rs0)".
set -euo pipefail
cd "$(dirname "$0")/.."
ORCA=(env ELECTRON_RUN_AS_NODE=1 node /usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js)
KEY=local.orca-mongo-studio
WIDTH=${WIDTH:-420}
mkdir -p .orca/shots/p1 .orca/shots/p2 .orca/shots/p4 .orca/shots/p5 .orca/shots/p6 .orca/shots/p7

CONN=$("${ORCA[@]}" plugin dev request . connections.state --json |
  node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const c=r.result.result.connections.find(c=>c.name==="Local dev (rs0)");if(!c)process.exit(1);process.stdout.write("conn:"+encodeURIComponent(c.id))')
T='{"type":"Tree"}'
open_agg() { # db collection kind: the aggregation tab, from the tree's Aggregate button
  printf '{"expand":%s,"key":"%s"},{"expand":%s,"key":"%s/db:%s"},{"selectItem":%s,"key":"%s/db:%s/%s:%s"},{"press":{"text":"Aggregate"}}' \
    "$T" "$CONN" "$T" "$CONN" "$1" "$T" "$CONN" "$1" "$3" "$2"
}
open_coll() { # db collection kind
  printf '{"expand":%s,"key":"%s"},{"expand":%s,"key":"%s/db:%s"},{"activateItem":%s,"key":"%s/db:%s/%s:%s"}' \
    "$T" "$CONN" "$T" "$CONN" "$1" "$T" "$CONN" "$1" "$3" "$2"
}
ROWS='{"type":"Table","label":"Documents"}'
at_coll() { # db collection kind: the collection selected in the tree
  printf '{"expand":%s,"key":"%s"},{"expand":%s,"key":"%s/db:%s"},{"selectItem":%s,"key":"%s/db:%s/%s:%s"}' \
    "$T" "$CONN" "$T" "$CONN" "$1" "$T" "$CONN" "$1" "$3" "$2"
}
at_db() { # db
  printf '{"expand":%s,"key":"%s"},{"selectItem":%s,"key":"%s/db:%s"}' "$T" "$CONN" "$T" "$CONN" "$1"
}

shot() { # dir name acts
  for theme in dark light; do
    echo "== $1/$2-$theme"
    "${ORCA[@]}" plugin shot "$KEY" --width "$WIDTH" --theme "$theme" --act "[$3]" --out ".orca/shots/$1/$2-$theme.png" --json |
      node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const x=r.result??r;console.log(JSON.stringify({ok:r.ok,themeApplied:x.themeApplied,errors:x.errors,actions:x.actions,error:r.error?.message}))'
  done
}
scenario() { # name
  for theme in dark light; do
    "${ORCA[@]}" plugin shot . --scenario "$1" --theme "$theme" --width "$WIDTH" --out ".orca/shots/p1/scenario-$1-$theme.png" --json >/dev/null && echo "== scenario $1-$theme"
  done
}

# ---- Phase 1 ----
shot p1 tree "{\"expand\":$T,\"key\":\"$CONN\"},{\"expand\":$T,\"key\":\"$CONN/db:shop\"}"
shot p1 db-details "{\"expand\":$T,\"key\":\"$CONN\"},{\"selectItem\":$T,\"key\":\"$CONN/db:shop\"}"
shot p1 conn-details "{\"selectItem\":$T,\"key\":\"$CONN\"}"
shot p1 new-form '{"press":{"label":"New connection"}}'
shot p1 uri-mode '{"press":{"label":"New connection"}},{"select":{"label":"Edit as"},"value":"uri"}'
shot p1 delete "{\"selectItem\":$T,\"key\":\"$CONN\"},{\"press\":{\"label\":\"Delete connection\"}}"
shot p1 import '{"press":{"label":"Import connections"}}'
scenario empty
scenario noKeyring

# ---- Phase 2 ----
shot p2 table "$(open_coll shop orders coll)"
shot p2 tree "$(open_coll shop orders coll),{\"press\":{\"text\":\"Tree\"}},{\"expand\":{\"type\":\"Tree\",\"label\":\"Documents\"},\"key\":\"r0\"}"
shot p2 json "$(open_coll shop orders coll),{\"press\":{\"text\":\"JSON\"}}"
shot p2 builder "$(open_coll shop orders coll),{\"toggle\":{\"label\":\"Query Builder\"}},{\"press\":{\"text\":\"Condition\"}},{\"press\":{\"text\":\"Group\"}}"
shot p2 filter-error "$(open_coll shop orders coll),{\"type\":{\"label\":\"Filter\"},\"text\":\"{ status: 'shipped' \",\"submit\":true}"
shot p2 doc-editor "$(open_coll types_zoo everything coll),{\"activateRow\":$ROWS,\"key\":\"\\\"all-types\\\"\"}"
shot p2 field-editor "$(open_coll types_zoo everything coll),{\"selectRows\":$ROWS,\"keys\":[\"\\\"all-types\\\"\"]},{\"select\":{\"label\":\"Edit a field\"},\"value\":\"binary\"}"
shot p2 delete "$(open_coll types_zoo everything coll),{\"selectRows\":$ROWS,\"keys\":[\"\\\"edge-numbers\\\"\",\"\\\"big-array\\\"\"]},{\"press\":{\"text\":\"Delete 2\"}}"
shot p2 view "$(open_coll shop order_totals_by_month view)"
shot p2 history "$(open_coll shop orders coll),{\"toggle\":{\"label\":\"History and saved queries\"}}"

# ---- Phase 4 ----
VALUE='{"type":"Textarea","label":"Value"}'
GROUP="{\"type\":$VALUE,\"text\":\"{ status: 'shipped' }\",\"replace\":true},{\"select\":{\"label\":\"Add a stage\"},\"value\":\"\$group\"},{\"type\":$VALUE,\"text\":\"{ _id: '\$payment.method', n: { \$sum: 1 } }\",\"replace\":true,\"submit\":true}"
shot p4 agg-open "$(open_agg shop orders coll)"
shot p4 agg-stages "$(open_agg shop orders coll),$GROUP"
shot p4 agg-input "$(open_agg shop orders coll),$GROUP,{\"press\":{\"text\":\"Input\"}}"
shot p4 agg-results "$(open_agg shop orders coll),$GROUP,{\"press\":{\"text\":\"Run\"}}"
shot p4 agg-text "$(open_agg shop orders coll),$GROUP,{\"press\":{\"text\":\"Edit as text\"}}"
shot p4 agg-out "$(open_agg shop orders coll),{\"select\":{\"label\":\"Add a stage\"},\"value\":\"\$out\"},{\"press\":{\"text\":\"Run\"}}"
shot p4 agg-explain "$(open_agg shop orders coll),$GROUP,{\"press\":{\"text\":\"Explain\"}}"
shot p4 agg-view "$(open_agg shop orders coll),{\"toggle\":{\"label\":\"Create a view\"}}"
shot p4 explain-find "$(open_coll shop orders coll),{\"type\":{\"label\":\"Filter\"},\"text\":\"{ status: 'shipped' }\"},{\"press\":{\"label\":\"Explain the query\"}}"
shot p4 explain-raw "$(open_coll shop orders coll),{\"press\":{\"label\":\"Explain the query\"}},{\"press\":{\"text\":\"Raw\"}}"

# ---- Phase 5 ----
MANAGE='{"press":{"label":"Manage the collection: indexes, validation, rename, drop"}}'
SCHEMA='{"press":{"label":"Schema: sample the fields and their types"}}'
shot p5 manage "$(at_coll shop orders coll),$MANAGE"
shot p5 manage-index "$(at_coll shop orders coll),$MANAGE,{\"selectRows\":{\"type\":\"Table\",\"label\":\"Indexes\"},\"keys\":[\"i:status\"]}"
shot p5 new-index "$(at_coll shop orders coll),$MANAGE,{\"press\":{\"text\":\"New index\"}},{\"type\":{\"label\":\"Field 1\"},\"text\":\"total\"},{\"press\":{\"text\":\"Add a field\"}},{\"type\":{\"label\":\"Field 2\"},\"text\":\"title\"},{\"select\":{\"label\":\"Field 2 kind\"},\"value\":\"text\"}"
shot p5 validation "$(at_coll shop customers coll),$MANAGE,{\"toggle\":{\"label\":\"Validation\"}},{\"press\":{\"text\":\"Check documents\"}}"
shot p5 drop "$(at_coll shop orders coll),$MANAGE,{\"toggle\":{\"label\":\"Rename, clear and drop\"}},{\"press\":{\"text\":\"Drop collection\"}}"
shot p5 database "$(at_db shop),{\"press\":{\"text\":\"Manage\"}}"
shot p5 create-collection "$(at_db shop),{\"press\":{\"text\":\"Manage\"}},{\"toggle\":{\"label\":\"Create a collection\"}},{\"select\":{\"label\":\"Kind\"},\"value\":\"timeseries\"}"
shot p5 profiler "$(at_db shop),{\"press\":{\"text\":\"Manage\"}},{\"toggle\":{\"label\":\"Profiler\"}},{\"press\":{\"text\":\"Read entries\"}}"
shot p5 users "$(at_db shop),{\"press\":{\"text\":\"Users\"}},{\"selectRows\":{\"type\":\"Table\",\"label\":\"Users\"},\"keys\":[\"u:app\"]}"
shot p5 user-form "$(at_db shop),{\"press\":{\"text\":\"Users\"}},{\"press\":{\"text\":\"New user\"}}"
shot p5 server "{\"selectItem\":$T,\"key\":\"$CONN\"},{\"press\":{\"label\":\"Server status and operations\"}}"
shot p5 schema "$(at_coll shop orders coll),$SCHEMA,{\"selectItem\":{\"type\":\"Tree\",\"label\":\"Fields\"},\"key\":\"f:total\"}"
shot p5 schema-export "$(at_coll shop orders coll),$SCHEMA,{\"toggle\":{\"label\":\"Export the schema\"}}"

# ---- Phase 6 ----
IMPORT='{"press":{"label":"Import into this collection"}}'
EXPORT='{"press":{"label":"Export: JSON, CSV, BSON or another collection"}}'
COMPARE='{"press":{"label":"Compare with another collection"}}'
CSV="name,age,joined,zip\\nAda,36,2026-01-02,01234\\nGrace,45,2026-02-03,75001\\n"
shot p6 import "$(at_coll shop customers coll),$IMPORT"
shot p6 import-csv "$(at_coll shop customers coll),$IMPORT,{\"type\":{\"label\":\"Documents\"},\"text\":\"$CSV\"},{\"press\":{\"text\":\"Preview\"}},{\"selectRows\":{\"type\":\"Table\",\"label\":\"Columns\"},\"keys\":[\"age\"]}"
shot p6 import-folder "$(at_db shop),{\"press\":{\"label\":\"Import into this database: a file, pasted documents or a mongodump folder\"}},{\"select\":{\"label\":\"Source\"},\"value\":\"path\"}"
shot p6 export-json "$(at_coll shop orders coll),$EXPORT"
shot p6 export-csv "$(at_coll shop orders coll),$EXPORT,{\"select\":{\"label\":\"Format\"},\"value\":\"csv\"},{\"press\":{\"text\":\"Load the fields\"}}"
shot p6 export-done "$(at_coll shop orders coll),$EXPORT,{\"type\":{\"label\":\"Limit\"},\"text\":\"100\"},{\"press\":{\"type\":\"Button\",\"text\":\"Export\"}}"
shot p6 copy "$(at_coll shop orders coll),$EXPORT,{\"select\":{\"label\":\"Format\"},\"value\":\"collection\"}"
shot p6 export-db "$(at_db shop),{\"press\":{\"label\":\"Export or copy the whole database\"}}"
shot p6 paste "$(at_coll shop customers coll),{\"press\":{\"label\":\"Copy, to paste into another database or connection\"}},{\"selectItem\":$T,\"key\":\"$CONN/db:shop\"}"
shot p6 compare "$(at_coll shop customers coll),$COMPARE,{\"type\":{\"label\":\"Collection\"},\"text\":\"gold_customers\"},{\"press\":{\"type\":\"Button\",\"text\":\"Compare\"}}"
shot p6 compare-sync "$(at_coll shop customers coll),$COMPARE,{\"type\":{\"label\":\"Collection\"},\"text\":\"gold_customers\"},{\"press\":{\"type\":\"Button\",\"text\":\"Compare\"}},{\"toggle\":{\"label\":\"Sync\"}}"
shot p6 gridfs "{\"expand\":$T,\"key\":\"$CONN\"},{\"expand\":$T,\"key\":\"$CONN/db:shop\"},{\"selectItem\":$T,\"key\":\"$CONN/db:shop/bucket:attachments\"},{\"press\":{\"text\":\"Browse files\"}}"
shot p6 gridfs-upload "{\"expand\":$T,\"key\":\"$CONN\"},{\"expand\":$T,\"key\":\"$CONN/db:shop\"},{\"selectItem\":$T,\"key\":\"$CONN/db:shop/bucket:attachments\"},{\"press\":{\"text\":\"Browse files\"}},{\"toggle\":{\"label\":\"Upload a file\"}}"

# ---- Phase 7 ----
# Only views that save nothing: a shot must not leave tasks or connection changes behind.
shot p7 tasks-empty "{\"press\":{\"label\":\"Saved tasks\"}}"
shot p7 save-as-task "$(at_coll shop orders coll),$EXPORT,{\"select\":{\"label\":\"Save to\"},\"value\":\"path\"},{\"type\":{\"label\":\"Path\"},\"text\":\"/tmp/orders.json\"},{\"toggle\":{\"label\":\"Save as task\"}}"
shot p7 compare-save "$(at_coll shop customers coll),$COMPARE,{\"type\":{\"label\":\"Collection\"},\"text\":\"gold_customers\"},{\"press\":{\"type\":\"Button\",\"text\":\"Compare\"}},{\"toggle\":{\"label\":\"Save as task\"}}"
shot p7 read-only-switch "{\"selectItem\":$T,\"key\":\"$CONN\"},{\"press\":{\"label\":\"Edit connection\"}}"

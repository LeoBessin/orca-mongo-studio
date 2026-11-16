#!/usr/bin/env bash
# Screenshots of every panel view, in light and dark, into .orca/shots/p1 and .orca/shots/p2.
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
mkdir -p .orca/shots/p1 .orca/shots/p2

CONN=$("${ORCA[@]}" plugin dev request . connections.state --json |
  node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const c=r.result.result.connections.find(c=>c.name==="Local dev (rs0)");if(!c)process.exit(1);process.stdout.write("conn:"+encodeURIComponent(c.id))')
T='{"type":"Tree"}'
open_coll() { # db collection kind
  printf '{"expand":%s,"key":"%s"},{"expand":%s,"key":"%s/db:%s"},{"activateItem":%s,"key":"%s/db:%s/%s:%s"}' \
    "$T" "$CONN" "$T" "$CONN" "$1" "$T" "$CONN" "$1" "$3" "$2"
}
ROWS='{"type":"Table","label":"Documents"}'

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

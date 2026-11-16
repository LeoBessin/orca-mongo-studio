// The bundled shell thread's entry (see dev/build-worker.mjs): it gives the thread its own copy of
// `bson`, since an installed plugin has no node_modules to load it from, then runs the thread.
import * as bson from 'bson'

globalThis.__mongoStudioBson = bson
await import('../src/worker/shell-thread.mjs')

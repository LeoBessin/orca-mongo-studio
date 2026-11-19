// Runs a tab action and shows its error in that tab instead of losing it, next to the part of the
// tab the action belongs to (see NoticeAt).
import { say, type NoticeAt } from './collection-state'
import { errorText } from './state'

export function guard(tabId: string, run: () => Promise<unknown> | unknown, at: NoticeAt = 'top'): () => Promise<void> {
  return async () => {
    try {
      await run()
    } catch (error) {
      say(tabId, 'danger', errorText(error), at)
    }
  }
}

/** `guard` for the actions of one part of a tab, so a view file can use it as its `guard`. */
export function guardAt(at: NoticeAt): typeof guard {
  return (tabId, run, where = at) => guard(tabId, run, where)
}

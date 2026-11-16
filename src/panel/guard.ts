// Runs a tab action and shows its error in that tab instead of losing it.
import { say } from './collection-state'
import { errorText } from './state'

export function guard(tabId: string, run: () => Promise<unknown> | unknown): () => Promise<void> {
  return async () => {
    try {
      await run()
    } catch (error) {
      say(tabId, 'danger', errorText(error))
    }
  }
}

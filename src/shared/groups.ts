// Connection groups: how a group name is normalised wherever it comes in (save, import, storage),
// and the suggestions the connection form shows under its Group field. Orca has no combobox, so
// the form shows matching groups as buttons. Pure, so it is tested on its own: `npm test`.

/** A group as stored: a trimmed string, `''` for none. Older or hand-written data may hold
 *  `null`, a number or padded text; all of it reads as a string here so nothing downstream throws. */
export function normalizeGroup(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The distinct, non-empty group names on the given connections, sorted. */
export function existingGroups(connections: readonly { group: unknown }[]): string[] {
  return [...new Set(connections.map((c) => normalizeGroup(c.group)).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/** The existing spelling of `group` when one differs only in case, so `clients` joins `Clients`
 *  instead of starting a second group. */
export function canonicalGroup(group: string, groups: readonly string[]): string {
  if (!group || groups.includes(group)) return group
  const lower = group.toLowerCase()
  return groups.find((g) => g.toLowerCase() === lower) ?? group
}

export type GroupSuggestions = {
  /** The groups to show, at most `limit`. */
  names: string[]
  /** How many more qualified but were cut by the limit. */
  hidden: number
  /** Whether `names` are matches for what was typed, rather than every other group. */
  filtered: boolean
}

/**
 * The groups worth suggesting for `typed`. While it is empty, or already names an existing group,
 * that is every other group (so a connection already in one can still be moved). Otherwise it is
 * the groups that contain the typed text, or that the typed text starts with, ignoring case: `Cli`
 * offers `Clients`, `Clients` offers `Client`, but `Business` doesn't offer `US`. Names starting
 * with the typed text come first, then the rest, each alphabetical as given.
 */
export function suggestGroups(groups: readonly string[], typed: string, limit = 8): GroupSuggestions {
  const exact = typed.trim()
  const q = exact.toLowerCase()
  const others = groups.filter((g) => g !== exact)
  let pool = others
  const filtered = Boolean(q) && !groups.includes(exact)
  if (filtered) {
    const starts: string[] = []
    const rest: string[] = []
    for (const g of others) {
      const name = g.toLowerCase()
      if (name.startsWith(q)) starts.push(g)
      else if (name.includes(q) || q.startsWith(name)) rest.push(g)
    }
    pool = [...starts, ...rest]
  }
  const names = pool.slice(0, limit)
  return { names, hidden: pool.length - names.length, filtered }
}

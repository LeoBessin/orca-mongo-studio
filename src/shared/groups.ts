// Group-name suggestions for the connection form. Orca has no combobox, so the form shows the
// existing groups that match what was typed as buttons under the Group field. Pure, so it is
// tested on its own: `npm test`.

/** The distinct, non-empty group names on the given connections, sorted. */
export function existingGroups(connections: readonly { group: string }[]): string[] {
  return [...new Set(connections.map((c) => c.group.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/**
 * The groups worth suggesting for `typed`: all of them while it is empty, otherwise those that
 * contain it or that it contains, ignoring case, so `Client` offers `Clients` and `Clients`
 * offers `Client`. Names starting with it come first. A name typed exactly is already chosen and
 * not offered again.
 */
export function suggestGroups(groups: readonly string[], typed: string, limit = 8): string[] {
  const exact = typed.trim()
  const q = exact.toLowerCase()
  const others = groups.filter((g) => g !== exact)
  if (!q) return others.slice(0, limit)
  const matches = others.filter((g) => {
    const name = g.toLowerCase()
    return name.includes(q) || q.includes(name)
  })
  const starts = matches.filter((g) => g.toLowerCase().startsWith(q))
  const rest = matches.filter((g) => !g.toLowerCase().startsWith(q))
  return [...starts, ...rest].slice(0, limit)
}

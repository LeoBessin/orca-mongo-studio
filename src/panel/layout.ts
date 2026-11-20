// The panel's vertical spacing, from the outside in. A Box's gap says how its children relate:
// separate sections, fields or blocks within a section, or one control with what belongs to it.
// A nested Box takes a smaller gap than the one around it, so groups still read as groups.
import type { Gap } from 'orca'

export const GAP = {
  /** Between sections that each hold their own fields or blocks. */
  section: 'md',
  /** Between the labelled fields and blocks of one section. */
  group: 'sm',
  /** Within one control: a field and its hint or error, a caption and its table, a checkbox list. */
  tight: 'xs'
} as const satisfies Record<string, Gap>

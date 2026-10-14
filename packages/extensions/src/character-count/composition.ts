import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { StepMap } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

interface Range {
  from: number
  to: number
}

// Text written by the current IME composition, not yet checked against the limit
interface CompositionState {
  id: number
  ranges: Range[]
  sizeBefore: number
}

interface CompositionOptions {
  getLimit: () => number | null | undefined
  measure: (node: PMNode) => number
}

export const compositionPluginKey = new PluginKey<CompositionState | null>(
  'characterCountComposition',
)

const isLimited = (limit: number | null | undefined): limit is number =>
  limit !== null && limit !== undefined && limit !== 0

function isLowSurrogate(text: string) {
  const code = text.charCodeAt(0)

  return code >= 0xdc00 && code <= 0xdfff
}

function touches(part: Range, change: Range) {
  if (change.from === change.to) {
    return change.from > part.from && change.from < part.to
  }

  return change.from < part.to && change.to > part.from
}

// Leave out text other steps put inside or next to the composed text
function mapRanges(ranges: Range[], map: StepMap): Range[] {
  const changes: Range[] = []

  map.forEach((oldStart, oldEnd) => {
    changes.push({ from: oldStart, to: oldEnd })
  })

  const cutAround = (part: Range, change: Range): Range[] =>
    touches(part, change)
      ? [
          { from: part.from, to: Math.max(part.from, change.from) },
          { from: Math.min(part.to, change.to), to: part.to },
        ]
      : [part]

  return ranges
    .flatMap(range =>
      changes.reduce<Range[]>(
        (parts, change) => parts.flatMap(part => cutAround(part, change)),
        [range],
      ),
    )
    .map(part => ({ from: map.map(part.from, 1), to: map.map(part.to, -1) }))
    .filter(part => part.from < part.to)
}

function mergeRanges(ranges: Range[]): Range[] {
  return [...ranges]
    .sort((a, b) => a.from - b.from)
    .reduce<Range[]>((merged, range) => {
      const last = merged[merged.length - 1]

      if (last && range.from <= last.to) {
        last.to = Math.max(last.to, range.to)
        return merged
      }

      merged.push({ ...range })
      return merged
    }, [])
}

function applyToComposition(
  tr: Transaction,
  previous: CompositionState | null,
  composition: number | undefined,
  sizeBefore: () => number,
): CompositionState | null {
  let ranges = previous ? previous.ranges : []

  tr.mapping.maps.forEach(map => {
    ranges = mapRanges(ranges, map)

    if (composition) {
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (newStart < newEnd) {
          ranges.push({ from: newStart, to: newEnd })
        }
      })
    }

    ranges = mergeRanges(ranges)
  })

  if (!composition && !ranges.length) {
    return null
  }

  return {
    id: composition || (previous as CompositionState).id,
    ranges,
    sizeBefore: previous ? previous.sizeBefore : sizeBefore(),
  }
}

// Delete the last `count` composed positions, or return null if that splits a surrogate pair
function deleteLast(state: EditorState, ranges: Range[], target: Transaction, count: number) {
  let remaining = count

  for (const range of ranges) {
    const length = Math.min(remaining, range.to - range.from)
    const from = range.to - length

    if (length > 0 && from > range.from && isLowSurrogate(state.doc.textBetween(from, from + 1))) {
      return null
    }

    // Delete later ranges first to keep earlier positions valid
    target.delete(from, range.to)
    remaining -= length

    if (remaining === 0) {
      break
    }
  }

  return target
}

/**
 * Trims the text of the ended composition until the document fits the limit.
 * Returns `null` when no composition is tracked.
 */
export function trimComposition(
  state: EditorState,
  { getLimit, measure }: CompositionOptions,
): Transaction | null {
  const composition = compositionPluginKey.getState(state)

  if (!composition) {
    return null
  }

  const tr = state.tr.setMeta(compositionPluginKey, null).setMeta('composition', composition.id)
  const configuredLimit = getLimit()

  if (!isLimited(configuredLimit)) {
    return tr
  }

  // An over-limit document may keep its size, like other edits
  const limit = Math.max(configuredLimit, composition.sizeBefore)

  if (measure(state.doc) <= limit) {
    return tr
  }

  const size = state.doc.content.size
  const ranges = composition.ranges
    .map(range => ({ from: Math.min(range.from, size), to: Math.min(range.to, size) }))
    .filter(range => range.from < range.to)
    .reverse()
  const total = ranges.reduce((sum, range) => sum + range.to - range.from, 0)

  // Measure each candidate, a custom counter may not count positions
  for (let count = 1; count < total; count += 1) {
    const candidate = deleteLast(state, ranges, state.tr, count)

    if (candidate && measure(candidate.doc) <= limit) {
      return deleteLast(state, ranges, tr, count)
    }
  }

  return deleteLast(state, ranges, tr, total)
}

/**
 * Returns whether a composition is going on or waits to be checked.
 */
export function hasPendingComposition(
  view: EditorView,
  state: EditorState,
  transactions: readonly Transaction[],
) {
  return (
    view.composing ||
    !!compositionPluginKey.getState(state) ||
    transactions.some(transaction => transaction.getMeta('composition'))
  )
}

/**
 * Tracks the text an IME composition writes and trims it once the composition ends.
 */
export function createCompositionPlugin(options: CompositionOptions) {
  return new Plugin<CompositionState | null>({
    key: compositionPluginKey,
    state: {
      init: () => null,
      apply: (tr, previous, oldState) => {
        if (tr.getMeta(compositionPluginKey) !== undefined) {
          return tr.getMeta(compositionPluginKey)
        }

        const composition = isLimited(options.getLimit()) ? tr.getMeta('composition') : undefined

        if (!tr.docChanged || (!previous && !composition)) {
          return previous
        }

        return applyToComposition(tr, previous, composition, () => options.measure(oldState.doc))
      },
    },
    props: {
      handleDOMEvents: {
        compositionend: view => {
          // No transaction may follow, so check once ProseMirror has ended the composition
          setTimeout(() => {
            if (view.isDestroyed || view.composing) {
              return
            }

            const tr = trimComposition(view.state, options)

            if (tr) {
              view.dispatch(tr)
            }
          })

          return false
        },
      },
    },
  })
}

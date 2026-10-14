import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { CharacterCount, type CharacterCountOptions, UndoRedo } from '@tiptap/extensions'
import { afterEach, describe, expect, it } from 'vite-plus/test'

// Let ProseMirror timers and the composition check settle
function flushView(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 30)
  })
}

function startComposition(editor: Editor) {
  editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart'))
}

function endComposition(editor: Editor, data: string) {
  editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { data }))
}

function composeUpdate(editor: Editor, text: string, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.insertText(text, from, to).setMeta('composition', 1))
}

// Replay what ProseMirror dispatches while an IME composes at `pos`
async function compose(
  editor: Editor,
  pos: number,
  readings: string[],
  commit: string,
  { beforeEnd }: { beforeEnd?: () => void | Promise<void> } = {},
) {
  let length = 0

  startComposition(editor)
  ;[...readings, commit].forEach(text => {
    composeUpdate(editor, text, pos, pos + length)
    length = text.length
  })
  await beforeEnd?.()
  endComposition(editor, commit)
  await flushView()
}

describe('extension-character-count', () => {
  let mountedEditor: Editor | null = null

  const createEditor = (content: string, options: Partial<CharacterCountOptions>) => {
    mountedEditor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, UndoRedo, CharacterCount.configure(options)],
      content,
    })

    return mountedEditor
  }

  afterEach(async () => {
    await flushView()
    mountedEditor?.destroy()
    mountedEditor = null
  })

  describe('IME composition', () => {
    it('keeps the reading while composing even if it goes over the limit', () => {
      const editor = createEditor('<p>abc</p>', { limit: 5 })

      startComposition(editor)
      composeUpdate(editor, 'にほん', 4)

      expect(editor.getText()).toBe('abcにほん')
    })

    it('keeps a committed text that fits the limit', async () => {
      const editor = createEditor('<p>abc</p>', { limit: 5 })

      await compose(editor, 4, ['に', 'にほ', 'にほん'], '日本')

      expect(editor.getText()).toBe('abc日本')
    })

    it('trims a committed text to the limit', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      await compose(editor, 5, ['に', 'にほ', 'にほん'], '日本')

      expect(editor.getText()).toBe('abcd日')
    })

    it('trims the composed text when the last update arrives after compositionend', () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      startComposition(editor)
      composeUpdate(editor, 'にほん', 5)
      endComposition(editor, '日本')
      // ProseMirror can flush the last update after compositionend
      composeUpdate(editor, '日本', 5, 8)

      expect(editor.getText()).toBe('abcd日')
    })

    it('trims only the composed text when composing in the middle', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      await compose(editor, 3, ['に', 'にほ', 'にほん'], '日本')

      expect(editor.getText()).toBe('ab日cd')
    })

    it('trims the composed text even if the selection moved before the composition ended', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      await compose(editor, 5, ['にほんご'], '日本語', {
        beforeEnd: () => {
          editor.commands.setTextSelection(2)
        },
      })

      expect(editor.getText()).toBe('abcd日')
      expect(editor.state.selection.from).toBe(2)
    })

    it('keeps text another transaction inserted right after the composed text', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 6 })

      startComposition(editor)
      composeUpdate(editor, '日', 3)
      // Accepted, `ab日cd` fits the limit
      editor.view.dispatch(editor.state.tr.insertText('X', 4))
      composeUpdate(editor, '日本', 3, 4)
      endComposition(editor, '日本')
      await flushView()

      expect(editor.getText()).toBe('ab日Xcd')
    })

    it('keeps text another transaction inserted right before the composed text', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 6 })

      startComposition(editor)
      composeUpdate(editor, '日', 3)
      editor.view.dispatch(editor.state.tr.insertText('X', 3))
      composeUpdate(editor, '日本', 4, 5)
      endComposition(editor, '日本')
      await flushView()

      expect(editor.getText()).toBe('abX日cd')
    })

    it('keeps text another transaction inserted inside the composed text', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 7 })

      startComposition(editor)
      composeUpdate(editor, '日月', 3)
      // Accepted, `ab日月cd` fits the limit
      editor.view.dispatch(editor.state.tr.insertText('X', 4))
      composeUpdate(editor, '日本語', 3, 4)
      endComposition(editor, '日本語')
      await flushView()

      expect(editor.getText()).toBe('ab日本Xcd')
    })

    it('does not split a surrogate pair when trimming', async () => {
      const editor = createEditor('<p>abc</p>', { limit: 6 })

      await compose(editor, 4, ['えがお'], '😀😀')

      expect(editor.getText()).toBe('abc😀')
    })

    it('measures with a custom textCounter', async () => {
      const editor = createEditor('<p>abc</p>', {
        limit: 4,
        textCounter: text => [...new Intl.Segmenter().segment(text)].length,
      })

      await compose(editor, 4, ['えがお'], '😀😀')

      expect(editor.getText()).toBe('abc😀')
    })

    it('drops only the composed text when the document was already over the limit', async () => {
      const editor = createEditor('<p>abcdef</p>', { limit: 3, autoTrim: false })

      await compose(editor, 7, ['にほん'], '日本')

      expect(editor.getText()).toBe('abcdef')
    })

    it('keeps a composition that shrinks a document already over the limit', async () => {
      const editor = createEditor('<p>abcdef</p>', { limit: 3, autoTrim: false })

      // Replace `ef` with 日
      startComposition(editor)
      composeUpdate(editor, 'にほ', 5, 7)
      composeUpdate(editor, '日', 5, 7)
      endComposition(editor, '日')
      await flushView()

      expect(editor.getText()).toBe('abcd日')
    })

    it('does not take a composition for initial content that has to be trimmed', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      await compose(editor, 5, ['にほん'], '日本')

      expect(editor.getText()).toBe('abcd日')
    })

    it('does not trim the initial content when the selection changes during the first composition', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      await compose(editor, 5, ['にほんご'], '日本語', {
        beforeEnd: () => {
          editor.commands.setTextSelection(1)
        },
      })

      expect(editor.getText()).toBe('abcd日')
    })

    it('undoes the composition and its trimming in one step', async () => {
      const editor = createEditor('<p>abcd</p>', { limit: 5 })

      // Outlast the history group delay so only the composition id groups the trimming
      await compose(editor, 5, ['に', 'にほ', 'にほん'], '日本', {
        beforeEnd: () => new Promise(resolve => setTimeout(resolve, 600)),
      })
      editor.commands.undo()

      expect(editor.getText()).toBe('abcd')
    })

    it('leaves compositions alone without a limit', async () => {
      const editor = createEditor('<p>abcd</p>', {})

      await compose(editor, 5, ['にほん'], '日本')

      expect(editor.getText()).toBe('abcd日本')
    })
  })

  describe('without composition', () => {
    it('blocks typing beyond the limit', () => {
      const editor = createEditor('<p>abcde</p>', { limit: 5 })

      editor.view.dispatch(editor.state.tr.insertText('f', 6))

      expect(editor.getText()).toBe('abcde')
    })

    it('trims pasted text to the limit', () => {
      const editor = createEditor('<p>abc</p>', { limit: 5 })

      // Insert at the caret like a real paste
      editor.commands.setTextSelection(4)
      editor.view.dispatch(editor.state.tr.insertText('defg').setMeta('paste', true))

      expect(editor.getText()).toBe('abcde')
    })
  })
})

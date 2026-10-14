import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { focusEditorEnd, getEditor, setEditorContent } from '../../../test/helpers.js'

const demoName = 'CharacterCount'
const frameworkPaths = ['React', 'Vue']
const demoPath = '/src/Extensions'

// Matches the `limit` of the demos
const limit = 280

// Drive an IME composition through the Chrome DevTools Protocol
async function compose(cdp: CDPSession, steps: string[], commit: string) {
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  }
  await cdp.send('Input.insertText', { text: commit })
}

async function setContentAndFocusEnd(page: Page, text: string) {
  await setEditorContent(page, `<p>${text}</p>`)
  await focusEditorEnd(page)
  // `focus()` is async
  await expect(page.locator('.tiptap')).toBeFocused()
}

async function getText(page: Page) {
  const editor = await getEditor(page)
  return editor.evaluate((el: any) => el.editor.getText())
}

test.describe(`${demoPath}/${demoName}`, () => {
  frameworkPaths.forEach(frameworkPath => {
    const fullDemoPath = `${demoPath}/${demoName}/${frameworkPath}/`

    test.describe(`${frameworkPath}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto(fullDemoPath)
      })

      test('blocks typing beyond the limit', async ({ page }) => {
        await setContentAndFocusEnd(page, 'x'.repeat(limit - 1))
        await page.keyboard.type('ab')

        expect(await getText(page)).toBe(`${'x'.repeat(limit - 1)}a`)
      })

      test.describe('IME composition', () => {
        let cdp: CDPSession

        test.beforeEach(async ({ page, browserName }) => {
          test.skip(browserName !== 'chromium', 'IME composition is driven through CDP')
          cdp = await page.context().newCDPSession(page)
        })

        test.afterEach(async () => {
          await cdp?.detach()
        })

        test('keeps a committed text that fits even if the reading went over the limit', async ({
          page,
        }) => {
          const before = `${'x'.repeat(limit - 3)}a`
          await setContentAndFocusEnd(page, before)

          await compose(cdp, ['に', 'にほ', 'にほん', '日本'], '日本')

          await expect.poll(() => getText(page)).toBe(`${before}日本`)
        })

        test('trims a committed text to the limit without touching existing text', async ({
          page,
        }) => {
          const before = `${'x'.repeat(limit - 3)}ab`
          await setContentAndFocusEnd(page, before)

          await compose(cdp, ['に', 'にほ', 'にほん', '日本'], '日本')

          await expect.poll(() => getText(page)).toBe(`${before}日`)
        })

        test('shows the reading while composing at the limit, then drops it', async ({ page }) => {
          const before = 'x'.repeat(limit)
          await setContentAndFocusEnd(page, before)

          await cdp.send('Input.imeSetComposition', {
            text: 'にほん',
            selectionStart: 3,
            selectionEnd: 3,
          })
          await expect(page.locator('.tiptap p')).toHaveText(`${before}にほん`)

          await cdp.send('Input.insertText', { text: '日本' })

          await expect.poll(() => getText(page)).toBe(before)
          await expect(page.locator('.tiptap p')).toHaveText(before)
        })
      })
    })
  })
})

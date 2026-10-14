---
'@tiptap/extensions': patch
---

Fix `CharacterCount` breaking IME composition near the `limit`, and trim only the composed text once the composition ends.

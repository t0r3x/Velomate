/**
 * The kind of pointer behind the most recent press: 'mouse', 'touch' or 'pen'. One listener for
 * the whole app, so components can tell a tap from a click (a tap fires compatibility mouse and
 * click events too, so the click event alone cannot say which it was).
 */
let last = 'mouse'
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => { last = e.pointerType || 'mouse' }, { capture: true, passive: true })
}
export const lastPointerType = (): string => last

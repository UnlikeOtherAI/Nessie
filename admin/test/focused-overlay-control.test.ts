import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import { revealFocusedOverlayControl } from '../src/hooks/useFocusedOverlayControl.js'

const rect = (top: number, bottom: number): DOMRect => ({
  bottom,
  height: bottom - top,
  left: 0,
  right: 320,
  top,
  width: 320,
  x: 0,
  y: top,
  toJSON: () => ({}),
})

const overlayWithFocusedField = () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const panel = dom.window.document.createElement('div')
  const field = dom.window.document.createElement('input')
  panel.append(field)
  dom.window.document.body.append(panel)

  Object.defineProperty(dom.window, 'visualViewport', {
    configurable: true,
    value: { height: 340, offsetTop: 0 },
  })
  panel.getBoundingClientRect = () => rect(80, 760)

  return { field, panel }
}

test('a focused field below the visible mobile viewport scrolls only its overlay', () => {
  const { field, panel } = overlayWithFocusedField()
  field.getBoundingClientRect = () => rect(350, 390)

  revealFocusedOverlayControl(panel, field)

  assert.equal(panel.scrollTop, 62)
})

test('a focused field already visible above the keyboard leaves the overlay in place', () => {
  const { field, panel } = overlayWithFocusedField()
  panel.scrollTop = 48
  field.getBoundingClientRect = () => rect(140, 180)

  revealFocusedOverlayControl(panel, field)

  assert.equal(panel.scrollTop, 48)
})

test('a nested overlay scroller moves before the panel itself', () => {
  const { field, panel } = overlayWithFocusedField()
  const scroller = field.ownerDocument.createElement('div')
  scroller.style.overflowY = 'auto'
  field.remove()
  scroller.append(field)
  panel.append(scroller)
  scroller.getBoundingClientRect = () => rect(100, 450)
  field.getBoundingClientRect = () => rect(430, 470)

  revealFocusedOverlayControl(panel, field)

  assert.equal(scroller.scrollTop, 142)
  assert.equal(panel.scrollTop, 0)
})

/**
 * Offline smoke test for the client half.
 *
 * Runs the browser artifact's factory against a tiny React and a recording
 * context, so a broken registration or render is caught before DSH restarts.
 */
import assert from 'node:assert/strict'

let factory = null
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: fn }) {
      assert.equal(id, 'dsh-dumate-gateway')
      factory = fn
    },
  },
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  },
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [initial, () => {}],
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useEffect: () => {},
  Fragment: 'fragment',
}

// The artifact registers itself on load; the window shim above must exist first.
await import('../client.js')
assert.equal(typeof factory, 'function', 'client.js must register a lazy factory')

const module = factory(name => {
  assert.equal(name, 'react')
  return React
})

assert.deepEqual(module.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])

const registrations = []
const disposers = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  sidebarRightTabs: {
    register(definition) {
      registrations.push({ kind: 'tab-type', definition })
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      assert.equal(key, 'sidebar.right.pane.tab')
      callback()
      return () => {}
    },
    register(options, Component) {
      registrations.push({ kind: 'slot', options, Component })
      return () => {}
    },
  },
}

module.apply(ctx)

assert.equal(registrations.length, 2)
const [type, slot] = registrations
assert.equal(type.kind, 'tab-type')
assert.equal(type.definition.id, 'dsh-dumate-gateway')
assert.equal(type.definition.kind, 'dumateGateway')
assert.equal(type.definition.priority, 'extension')
assert.ok(Array.isArray(type.definition.guide) && type.definition.guide.length === 1)
// The sidebar renders `entry.title()` and `entry.description?.()`: strings render
// fine in a type-only test but throw in the live guide and blank the whole panel.
const [guide] = type.definition.guide
assert.equal(typeof guide.title, 'function', 'guide entry title must be a function')
assert.equal(typeof guide.title(), 'string')
if (guide.description !== undefined) {
  assert.equal(typeof guide.description, 'function', 'guide description must be a function')
  assert.equal(typeof guide.description(), 'string')
}
assert.equal(typeof type.definition.title, 'function', 'tab title must be a function')
assert.equal(slot.kind, 'slot')
assert.equal(slot.options.name, 'sidebar.right.pane.tab')
assert.equal(slot.options.key, 'dsh-dumate-gateway')
assert.equal(typeof slot.Component, 'function')

// Render the panel once with hooks stubbed: this catches typos in the tree even
// though effects (and therefore fetches) never run in this harness.
const tree = slot.Component({})
assert.equal(tree.type, 'div')

function walk(node, visit) {
  // Pure components in this panel take props and return nodes: expand them so
  // assertions see the real tree (svg, rect, input) rather than a component ref.
  // React carries children in props; this harness records them beside props.
  while (node !== null && typeof node === 'object' && !Array.isArray(node) && typeof node.type === 'function') {
    node = node.type({ ...(node.props ?? {}), children: node.children })
  }
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

const tags = []
const inputs = []
const svgs = []
walk(tree, node => {
  if (typeof node.type === 'string') tags.push(node.type)
  if (node.type === 'input') inputs.push(node.props)
  if (node.type === 'svg') svgs.push(node.props)
})

// The panel is a single column: strip, usage chart, latency, try card, actions,
// then two collapsed drawers. With no data yet the usage chart still renders
// seven empty bars, and both drawers stay closed, so exactly one input (the try
// box) is on screen.
assert.equal(svgs.length, 1, 'usage chart renders even without usage data')
assert.match(svgs[0]['aria-label'] ?? '', /seven days/i)
const rects = []
walk(tree, node => {
  if (node.type === 'rect') rects.push(node.props)
})
// One wash behind today plus seven baseline ticks while the ledger is empty.
assert.equal(rects.length, 8, 'usage chart draws today wash and one tick per day')
const ticks = rects.filter(rect => rect.height === 2)
assert.equal(ticks.length, 7, 'empty days draw a tick, not a bar')
const weekdayLabels = []
const proportion = []
walk(tree, node => {
  if (node.type === 'text' && node.props?.fontSize === 9) weekdayLabels.push(node.props)
  if (typeof node.props?.['aria-label'] === 'string' && /tokens in/i.test(node.props['aria-label'])) {
    proportion.push(node.props)
  }
})
assert.equal(weekdayLabels.length, 7, 'every day of the week gets a label')
assert.equal(proportion.length, 1, 'today split renders a proportion bar with an accessible label')
assert.equal(inputs.length, 1, 'only the try-it input is visible while drawers are closed')
assert.match(inputs[0].placeholder ?? '', /ask/i)
assert.ok(!tags.includes('ul'), 'the model list stays collapsed by default')

const selects = []
walk(tree, node => {
  if (node.type === 'select') selects.push(node)
})
assert.equal(selects.length, 1, 'the try card exposes a model picker')
assert.equal(selects[0].props.value, '', 'the picker starts on auto')
const options = selects[0].children.filter(child => child !== null && child?.type === 'option')
assert.equal(options.length, 1, 'with no catalog only the auto entry is offered')
assert.equal(options[0].props.value, '')
assert.equal(options[0].children[0], 'Auto (first model)')

const buttons = []
walk(tree, node => {
  if (node.type === 'button') buttons.push(node)
})
const probeButton = buttons.find(button => button.children?.[0] === 'Probe')
assert.ok(probeButton, 'the try card offers a one-click connection probe')
assert.equal(probeButton.props.type, 'button')

assert.equal(disposers.length, 2, 'both registrations must return a disposer')

console.log('client plugin: registrations and render ok')

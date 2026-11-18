/**
 * Images on the wire.
 *
 * The proxy accepts OpenAI `image_url` parts with `data:` URLs, but the harness
 * hands adapters an opaque `ImageAttachmentRef` instead of bytes. The adapter
 * asks the caller for a data URL per block and, when it cannot get one, keeps
 * the placeholder text. This test pins both paths plus the "no image means a
 * plain string" wire shape that the gateway has always sent.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toOpenAIMessages } from '../src/messages.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gateway-images-'))

const PNG = 'data:image/png;base64,iVBORw0KGgo='

const imageBlock = (name = 'shot.png') => ({
  type: 'image',
  attachment: {
    attachmentId: `att_${name}`,
    mediaType: 'image/png',
    bytes: 12,
    width: 800,
    height: 600,
    name,
  },
})

const resolver = ref => async block => {
  assert.equal(block.attachment.attachmentId, `att_${ref}`)
  return PNG
}

// 1. A user image becomes an image_url part next to the text, in order.
{
  const messages = await toOpenAIMessages({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        imageBlock('shot.png'),
        { type: 'text', text: 'answer in one line.' },
      ],
    }],
    resolveImage: resolver('shot.png'),
  })

  const parts = messages[0].content
  assert.ok(Array.isArray(parts), 'the content is a parts array once an image is present')
  assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' })
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: PNG } })
  assert.deepEqual(parts[2], { type: 'text', text: 'answer in one line.' })
}

// 2. Text-only user content stays a plain string, image solver or not.
{
  const [plain] = await toOpenAIMessages({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    resolveImage: resolver('unused'),
  })
  assert.equal(typeof plain.content, 'string')
  assert.equal(plain.content, 'hi')
}

// 3. No resolver, an offloaded block, a null return and a throw all degrade to
//    the placeholder without failing the turn.
{
  const [unresolved] = await toOpenAIMessages({
    messages: [{ role: 'user', content: [imageBlock('no-resolver.png')] }],
  })
  assert.equal(unresolved.content, '[image attachment]', 'no resolver keeps the placeholder')

  const [degraded] = await toOpenAIMessages({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: imageBlock('offloaded.png').attachment, offloaded: true },
        imageBlock('null.png'),
        imageBlock('throws.png'),
      ],
    }],
    resolveImage: async block => {
      if (block.attachment.attachmentId === 'att_null.png') return null
      if (block.attachment.attachmentId === 'att_throws.png') throw new Error('storage offline')
      return PNG
    },
  })
  assert.equal(typeof degraded.content, 'string', 'placeholders keep the string shape')
  assert.equal(degraded.content, '[image attachment][image attachment][image attachment]')
}

// 4. An image without any text still produces a parts array (no empty text part).
{
  const [message] = await toOpenAIMessages({
    messages: [{ role: 'user', content: [imageBlock('only.png')] }],
    resolveImage: resolver('only.png'),
  })
  assert.deepEqual(message.content, [{ type: 'image_url', image_url: { url: PNG } }])
}

// 5. An unusable ref (no attachmentId) never reaches the resolver.
{
  let calls = 0
  const [message] = await toOpenAIMessages({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { mediaType: 'image/png' } }] }],
    resolveImage: async () => {
      calls += 1
      return PNG
    },
  })
  assert.equal(calls, 0, 'a ref without an id is skipped')
  assert.equal(message.content, '[image attachment]')
}

// 6. Assistant and tool messages keep the text-only projection.
{
  const messages = await toOpenAIMessages({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, imageBlock('ignored.png')] },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
    ],
    resolveImage: resolver('ignored.png'),
  })
  assert.equal(messages[0].content, 'calling[image attachment]')
  assert.equal(messages[1].tool_call_id, 'call_1')
}

console.log('image checks passed')

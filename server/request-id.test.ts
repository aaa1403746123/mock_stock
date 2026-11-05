import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { createRequestId } from '../src/lib/request-id'

function withCrypto(value: unknown, check: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  try { check() }
  finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
}

test('request IDs use native randomUUID with its Crypto receiver when available', () => {
  const expected = '2b1e0db0-5304-44d6-b04c-03b9bba26263'
  const source = { randomUUID() { assert.equal(this, source); return expected } }
  withCrypto(source, () => assert.equal(createRequestId(), expected))
})

test('HTTP browsers without randomUUID generate valid distinct UUIDs using getRandomValues', () => {
  const source = { getRandomValues(bytes: Uint8Array) { assert.equal(this, source); return webcrypto.getRandomValues(bytes) } }
  withCrypto(source, () => {
    const ids = Array.from({ length: 1000 }, () => createRequestId())
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(new Set(ids).size, ids.length)
  })
})

test('browsers without Web Crypto still generate distinct request IDs within server length limits', () => {
  for (const source of [undefined, {}]) withCrypto(source, () => {
    const ids = Array.from({ length: 1000 }, () => createRequestId())
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.ok(id.length >= 8 && id.length <= 100)
  })
})

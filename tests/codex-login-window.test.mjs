import { test, expect } from 'bun:test'
import { NativeCodexAdapter } from '../apps/extension/src/background/codexAdapter.ts'
import { compatibleCodexConfig } from './helpers/codex-config.ts'

test('sign-in uses one centered popup, preserves the workspace, and closes only on matching success', async () => {
  const previous = globalThis.chrome
  const messages = new Set(), removed = new Set(), calls = []
  let completeDuringOpen = false
  const port = {
    onMessage: { addListener: listener => messages.add(listener) },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      if (message.id === undefined) return
      calls.push({ method: message.method, params: message.params })
      const result = message.method === 'account/login/start'
        ? { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?state=test' }
        : message.method === 'config/read' ? compatibleCodexConfig() : {}
      queueMicrotask(() => messages.forEach(listener => listener({ id: message.id, result })))
    }
  }
  globalThis.chrome = {
    runtime: { connectNative: () => port, sendMessage: async () => {} },
    windows: {
      getLastFocused: async () => ({ id: 7, left: 100, top: 50, width: 1440, height: 900 }),
      create: async options => {
        calls.push({ create: options })
        if (completeDuringOpen) messages.forEach(listener => listener({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } }))
        return { id: 8 }
      },
      update: async (id, options) => calls.push({ update: id, options }),
      remove: async id => { calls.push({ remove: id }); removed.forEach(listener => listener(id)) },
      onRemoved: { addListener: listener => removed.add(listener), removeListener: listener => removed.delete(listener) }
    }
  }
  try {
    const bridge = new NativeCodexAdapter()
    expect(await Promise.all([bridge.login(), bridge.login()])).toEqual([{ ok: true }, { ok: true }])
    expect(calls.filter(call => call.create)).toEqual([{ create: {
      url: 'https://auth.openai.com/authorize?state=test', type: 'popup', focused: true,
      width: 480, height: 720, left: 580, top: 140
    } }])
    await bridge.login()
    expect(calls.filter(call => call.method === 'account/login/start')).toHaveLength(1)
    expect(calls.at(-1)).toEqual({ update: 8, options: { focused: true } })
    for (const params of [{ loginId: 'old-login', success: true }, { loginId: 'login-1', success: false }]) {
      messages.forEach(listener => listener({ method: 'account/login/completed', params }))
      expect(calls.filter(call => call.remove)).toHaveLength(0)
    }
    messages.forEach(listener => listener({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.slice(-2)).toEqual([{ remove: 8 }, { update: 7, options: { focused: true } }])
    expect(calls.some(call => call.method === 'account/login/cancel')).toBe(false)
    expect(removed.size).toBe(0)

    await bridge.login()
    removed.forEach(listener => listener(8))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.at(-1)).toEqual({ method: 'account/login/cancel', params: { loginId: 'login-1' } })
    expect(removed.size).toBe(0)

    completeDuringOpen = true
    await bridge.login()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.slice(-2)).toEqual([{ remove: 8 }, { update: 7, options: { focused: true } }])
    expect(removed.size).toBe(0)
  } finally { globalThis.chrome = previous }
})

test('an unusable login response never opens an empty window or reports success', async () => {
  const previous = globalThis.chrome
  globalThis.chrome = { windows: { getLastFocused: async () => ({ id: 7 }) } }
  try {
    const bridge = new NativeCodexAdapter()
    bridge.request = async () => ({ type: 'chatgpt' })
    expect((await bridge.login()).ok).toBe(false)
  } finally { globalThis.chrome = previous }
})

test('a configured provider without OpenAI auth does not request subscription-only limits', async () => {
  const bridge = new NativeCodexAdapter(), calls = []
  bridge.request = async method => {
    calls.push(method)
    if (method === 'account/read') return { account: null, requiresOpenaiAuth: false }
    if (method === 'model/list') return { data: [{ id: 'test-provider-model', isDefault: true }] }
    throw new Error('This provider has no ChatGPT subscription endpoint')
  }
  expect(await bridge.connect()).toMatchObject({ ok: true, models: [{ id: 'test-provider-model', isDefault: true }] })
  expect(calls).toEqual(['account/read', 'model/list'])
})

test('connection loads every page of the Codex model catalog', async () => {
  const bridge = new NativeCodexAdapter(), calls = []
  bridge.request = async (method, params = {}) => {
    calls.push({ method, params })
    if (method === 'account/read') return { account: null, requiresOpenaiAuth: false }
    if (method !== 'model/list') throw new Error(`Unexpected request: ${method}`)
    return params.cursor === 'page-2'
      ? { data: [{ id: 'gpt-6-luna' }] }
      : { data: [{ id: 'gpt-6-astra' }], nextCursor: 'page-2' }
  }
  expect(await bridge.connect()).toMatchObject({ ok: true, models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }] })
  expect(calls).toEqual([
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'model/list', params: {} },
    { method: 'model/list', params: { cursor: 'page-2' } }
  ])
})

test('connection rejects a repeated model catalog cursor instead of returning a partial list', async () => {
  const bridge = new NativeCodexAdapter()
  bridge.request = async method => method === 'account/read'
    ? { account: null, requiresOpenaiAuth: false }
    : { data: [], nextCursor: 'same-page' }
  expect(await bridge.connect()).toMatchObject({ ok: false, error: 'Codex returned a repeated model-list cursor' })
})

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeClient } from './native-client'

/** Real installed relay → Codex → code-mode host → shell; only the model is a local fixture. */
export async function verifyToolExecution(command: string, origin: string, environment: Record<string, string | undefined>, home: string) {
  const configDirectory = join(home, '.codex'), cwd = join(home, 'tool-verification')
  await mkdir(configDirectory, { recursive: true }); await mkdir(cwd, { recursive: true })
  const marker = `galta-tool-proof-${crypto.randomUUID()}`
  await writeFile(join(cwd, 'proof.txt'), marker + '\n')
  const code = `for (const options of [
    {cmd:'cat proof.txt',shell:'/bin/bash'},
    {cmd:"rg --no-heading '^' proof.txt"}
  ]) {
    const result = await tools.exec_command({...options,workdir:${JSON.stringify(cwd)},login:false,max_output_tokens:1000});
    if (result.exit_code !== 0) throw Error(JSON.stringify(result));
    text(result.output);
  }`
  let requests = 0, toolOutput: unknown, fixtureError: Error | undefined
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return Response.json({ data: [] })
    const body = await request.json() as any
    requests++
    const first = requests === 1
    if (first && !JSON.stringify(body.input.filter((item: any) => item.type === 'additional_tools')).includes('"exec"')) fixtureError = new Error('Codex did not advertise the code-mode exec tool')
    if (!first) toolOutput = body.input.find((item: any) => item.type === 'custom_tool_call_output' && item.call_id === 'verify-shell')?.output
    const item = first
      ? { type: 'custom_tool_call', id: 'tool-verification', call_id: 'verify-shell', name: 'exec', input: code, status: 'completed' }
      : { type: 'message', id: 'verification-done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Verification complete.', annotations: [] }] }
    const response = { id: `response-${requests}`, object: 'response', created_at: 1, model: 'gpt-6-astra', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  let client: NativeClient | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    await writeFile(join(configDirectory, 'config.toml'), `model='gpt-6-astra'\nmodel_provider='fixture'\n[features]\ncode_mode_only=true\nunified_exec=true\n[model_providers.fixture]\nname='Local package verification'\nbase_url='http://127.0.0.1:${server.port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n`)
    let finish: (turn: any) => void = () => {}
    const completed = new Promise<any>(resolve => { finish = resolve })
    client = new NativeClient(command, origin, { ...environment, CODEX_HOME: configDirectory, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'galta' }, message => {
      if (message.method === 'turn/completed') finish(message.params.turn)
    })
    await client.request('initialize', { clientInfo: { name: 'galta_verification', version: '1' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {})
    const { thread } = await client.request('thread/start', { cwd, model: 'gpt-6-astra', ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run the local tool verification.', text_elements: [] }] })
    const turn = await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Code-mode shell verification timed out')), 30000) })])
    if (fixtureError) throw fixtureError
    if (turn.status !== 'completed' || requests !== 2) throw new Error(`Code-mode verification did not complete: ${JSON.stringify(turn)}`)
    const output = JSON.stringify(toolOutput)
    if (!output?.includes('Script completed') || output.split(marker).length !== 3) throw new Error(`Code-mode shell execution failed: ${output}`)
    console.log('PASS: installed code-mode host executed bash and file search and returned both file contents through native messaging.')
  } finally { clearTimeout(timer); await client?.close(); server.stop(true) }
}

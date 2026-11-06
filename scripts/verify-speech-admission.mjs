// Real workerd service bindings + SQLite admission, with fake account and AI.
// No network inference or real credentials. Run: node scripts/verify-speech-admission.mjs
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {realpathSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../',import.meta.url))
const require=createRequire(realpathSync(join(root,'apps/speech-worker/node_modules/wrangler/package.json')))
const {Miniflare,convertV4MiniflareOptions}=require('miniflare')
const directory=mkdtempSync(join(tmpdir(),'galta-speech-admission-'))
const fixture=join(directory,'fixture.ts'), compiled=join(directory,'fixture.js')
writeFileSync(fixture,`import worker from ${JSON.stringify(join(root,'apps/speech-worker/src/index.ts'))}
export { SpeechBudget } from ${JSON.stringify(join(root,'apps/speech-worker/src/budget.ts'))}
let calls = 0
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/calls') return Response.json({ calls })
    return worker.fetch(request, { ...env, ENABLED: 'true',
      SPEECH_LIMIT: { limit: async () => ({ success: true }) },
      AI: { run: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { text: 'fixture', segments: [{ words: [{ word: 'fixture', start: .1, end: .5 }] }] } } } })
  }
}
`)
// The pinned local workerd binary supports this date; production is also probed
// on deployment using its newer configured date.
const config={workers:[{name:'speech-fixture',modules:true,modulesRoot:directory,scriptPath:compiled,compatibilityDate:'2026-10-26',compatibilityFlags:['enable_request_signal'],serviceBindings:{ACCOUNT:'account-fixture'},durableObjects:{SPEECH_BUDGET:{className:'SpeechBudget',useSQLite:true}}},{name:'account-fixture',modules:true,script:`export default {fetch(request) { if (request.headers.get('Authorization') !== 'Bearer fixture-only') return Response.json(null); return Response.json({user:{id:'fixture-user',emailVerified:true},session:{userId:'fixture-user',expiresAt:new Date(Date.now()+600000).toISOString()}}) }}`}],durableObjectsPersist:directory}
const audio=Buffer.alloc(32044);audio.write('RIFF');audio.writeUInt32LE(32036,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(32000,40)
const input={id:randomUUID(),digest:createHash('sha256').update(audio).digest('hex')}
const headers={Origin:'http://127.0.0.1:4471','CF-Connecting-IP':'192.0.2.1'}
let mf;const result={}
try {
 execFileSync('bun',['build',fixture,'--target','browser','--external','cloudflare:workers','--outfile',compiled],{cwd:root,stdio:'pipe'})
 mf=new Miniflare(convertV4MiniflareOptions(config));await mf.ready
 const start=performance.now()
 const authorization=await mf.dispatchFetch('https://speech.galta.art/v1/authorize',{method:'POST',headers:{...headers,'Content-Type':'application/json',Authorization:'Bearer fixture-only'},body:JSON.stringify(input)})
 assert.equal(authorization.status,200);const grant=await authorization.json()
 result.authorizationMs=Math.round(performance.now()-start)
 const send=()=>mf.dispatchFetch('https://speech.galta.art/v1/transcribe',{method:'POST',headers:{...headers,'Content-Type':'audio/wav','X-Galta-Recording':input.id,Authorization:`Bearer ${grant.token}`},body:audio})
 result.statuses=await Promise.all(Array.from({length:24},async()=>{const r=await send();await r.arrayBuffer();return r.status}))
 assert.equal(result.statuses.filter(x=>x===200).length,1)
 assert.equal(result.statuses.filter(x=>x===403).length,23)
 result.inferenceCalls=(await (await mf.dispatchFetch('https://speech.galta.art/calls')).json()).calls
 assert.equal(result.inferenceCalls,1)
 await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions(config));await mf.ready
 result.replayAfterRestart=(await send()).status
 assert.equal(result.replayAfterRestart,403)
 result.afterRestartCalls=(await (await mf.dispatchFetch('https://speech.galta.art/calls')).json()).calls
 assert.equal(result.afterRestartCalls,0)
 result.passed=true;console.log(result)
}finally{await mf?.dispose();rmSync(directory,{recursive:true,force:true})}

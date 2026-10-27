import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

// The approved SVG is the source. This script preserves its contour; only the
// browser export adds its explicitly owned white exterior contour.
const root = resolve(import.meta.dir, '..')
const publicDirectory = resolve(root, 'apps/extension/src/public')
const pluginDirectory = resolve(root, 'plugins/galta/assets')
const evidence = resolve(root, 'docs/evidence/outline-mark-2026-10-10')
const outline = await readFile(resolve(publicDirectory, 'galta-logo-outline.svg'), 'utf8')
const expression = (await readFile(resolve(publicDirectory, 'galta-logo.svg'), 'utf8'))
  .replace(/<\?xml[^>]+>/, '')
  .replace(/width="[^"]+" height="[^"]+" viewBox="[^"]+"/, 'viewBox="70.22 86.18 272.88 248.74"')
const favicon = outline.replace(/(<svg[^>]+>)/, '$1<style>:root{color:#202020}@media(prefers-color-scheme:dark){:root{color:#f7f7f7}}</style>')
await writeFile(resolve(publicDirectory, 'galta-favicon.svg'), favicon)
await mkdir(evidence, { recursive: true })
await mkdir(pluginDirectory, { recursive: true })

// Codex's composer row is dark and consumes one static icon, so its contour is
// white. The browser toolbar has no stable light/dark asset slot. Its PNGs keep
// the black contour with a white exterior contour so the same identity remains
// legible on Dia's dark toolbar.
const pluginInks = {
  'logo.svg': '#202020',
  'logo-dark.svg': '#f7f7f7',
  'composer-icon.svg': '#ffffff',
}
assert(outline.includes('fill="currentColor"'))
for (const [file, ink] of Object.entries(pluginInks)) {
  await writeFile(resolve(pluginDirectory, file), outline.replace('fill="currentColor"', `fill="${ink}"`))
}
const outlinePath = outline.match(/<path fill="currentColor" fill-rule="evenodd" d="([^"]+)"\/>/)?.[1]
assert(outlinePath)
const outerPath = outlinePath.split(/\sZ\s+M/)[0] + ' Z'
assert(outerPath.length < outlinePath.length)
const sourceViewBox = outline.match(/viewBox="([^"]+)"/)?.[1]
assert(sourceViewBox)
const [sourceX, sourceY, sourceWidth, sourceHeight] = sourceViewBox.trim().split(/\s+/).map(Number)
assert(sourceX !== undefined && sourceY !== undefined && sourceWidth !== undefined && sourceHeight !== undefined)
assert([sourceX, sourceY, sourceWidth, sourceHeight].every(Number.isFinite))
// A browser toolbar can be dark, so the black contour needs a real white
// outer contour. Keep enough viewBox clearance for the stroke to survive at
// 16 px; the white layer is behind the unchanged black compound path.
const BROWSER_BACKING_PAD = 8
const BROWSER_BACKING_STROKE = 32
const browserViewBox = [
  sourceX - BROWSER_BACKING_PAD,
  sourceY - BROWSER_BACKING_PAD,
  sourceWidth + BROWSER_BACKING_PAD * 2,
  sourceHeight + BROWSER_BACKING_PAD * 2,
]
const browserIcon = outline
  .replace(/width="[^"]+" height="[^"]+" viewBox="[^"]+"/, `width="${browserViewBox[2]}" height="${browserViewBox[3]}" viewBox="${browserViewBox.join(' ')}"`)
  .replace(
    /<path fill="currentColor" fill-rule="evenodd" d="([^"]+)"\/>/,
    `<path fill="#ffffff" stroke="#ffffff" stroke-width="${BROWSER_BACKING_STROKE}" stroke-linejoin="round" d="${outerPath}"/><path fill="#000000" fill-rule="evenodd" d="$1"/>`,
  )
assert(browserIcon.includes('fill="#ffffff"'))
assert(browserIcon.includes(`stroke-width="${BROWSER_BACKING_STROKE}"`))
await writeFile(resolve(pluginDirectory, 'browser-icon.svg'), browserIcon)
const iconset = await mkdtemp(resolve(tmpdir(), 'galta-brand-iconset-'))
try {
  execFileSync('/usr/bin/swift', [resolve(root, 'scripts/render-icons.swift'), resolve(publicDirectory, 'icons'), iconset], { cwd: root, stdio: 'inherit' })
  await copyFile(resolve(iconset, 'icon_128x128.png'), resolve(evidence, 'native-app-icon.png'))
} finally { await rm(iconset, { recursive: true, force: true }) }

const sizes = [16, 20, 24, 32, 48, 64]
const mark = (svg: string, size: number) => `<span class="mark" style="width:${size}px">${svg}</span>`
const embedded = async (file: string) => `data:${file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${(await readFile(file)).toString('base64')}`
const browserIconPng = await embedded(resolve(publicDirectory, 'icons/32.png'))
const pluginLight = await embedded(resolve(pluginDirectory, 'logo.svg'))
const pluginDark = await embedded(resolve(pluginDirectory, 'logo-dark.svg'))
const composerIcon = await embedded(resolve(pluginDirectory, 'composer-icon.svg'))
await writeFile(resolve(evidence, 'preview.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Galta · 正式标识</title><style>
*{box-sizing:border-box}body{margin:0;background:#faf9f6;color:#202020;font:14px -apple-system,BlinkMacSystemFont,sans-serif}main{width:1080px;margin:auto;padding:42px 56px}header{display:flex;align-items:baseline;justify-content:space-between}h1{font-size:23px;letter-spacing:-.6px;font-weight:550;margin:0}header span{font-size:12px;color:#777}.hero{display:grid;grid-template-columns:1fr 1fr;gap:64px;margin:16px 0 36px}.example{text-align:center}.art{height:290px;display:flex;align-items:center;justify-content:center}h2{font-size:16px;font-weight:500;margin:10px 0}p{color:#777;font-size:12px;margin:0}.mark{display:inline-flex;line-height:0;flex:none}.mark svg{width:100%;height:auto;display:block}.bottom{border-top:1px solid #deded6;padding-top:28px;display:grid;grid-template-columns:1fr 300px;gap:45px}.sizes{display:flex;align-items:flex-end;gap:34px;height:100px}.size{display:flex;flex-direction:column;align-items:center;gap:16px}.size label{font-size:11px;color:#777}.hosts{display:grid;grid-template-columns:1fr 1fr;gap:8px}.host{height:130px;display:flex;align-items:center;justify-content:center;gap:24px;border:1px solid #deded6}.host img{object-fit:contain}.dark{background:#202020;color:#f7f7f7;border-color:#202020}.note{margin-top:18px;font-size:11px;color:#777}
</style><main><header><h1>Galta</h1><span>一个轮廓，两种表达</span></header><section class="hero"><div class="example"><div class="art">${mark(outline,246)}</div><h2>精修轮廓版</h2><p>浏览器扩展 · Codex 插件 · 浏览器标签</p></div><div class="example"><div class="art">${mark(expression,246)}</div><h2>表情版</h2><p>软件内部 · 网页剪藏 · Mac 应用</p></div></section><section class="bottom"><div><div class="sizes">${sizes.map(size=>`<div class="size">${mark(outline,size)}<label>${size}px</label></div>`).join('')}</div><div class="note">同一份精修轮廓 · 内部透明</div></div><div><div class="hosts"><div class="host"><img src="${browserIconPng}" width="16" height="16"><img src="${pluginLight}" width="32" height="32"></div><div class="host dark"><img src="${browserIconPng}" width="16" height="16"><img src="${pluginDark}" width="32" height="32"><img src="${composerIcon}" width="32" height="32"></div></div><div class="note">浏览器图标：黑色轮廓外加白色描边；Codex composer 使用纯白</div></div></section></main></html>`)

const browser = await chromium.launch({ executablePath: process.env.GALTA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width:1080, height:680 }, deviceScaleFactor:2 })
  await page.goto(`file://${resolve(evidence, 'preview.html')}`)
  await page.screenshot({ path:resolve(evidence, 'preview.png'), fullPage:true })
  for (const [name, ink] of [['galta-logo-outline.png','black'],['galta-logo-outline-white.png','white']] as const) {
    await page.setContent(`<style>body{margin:0;background:transparent}.export{width:1024px;height:1024px;display:grid;place-items:center;color:${ink}}.export svg{width:896px;height:auto}</style><div class="export">${outline}</div>`)
    await page.locator('.export').screenshot({path:resolve(evidence,name),omitBackground:true,scale:'css'})
  }
  const assets = []
  for (const file of [
    resolve(publicDirectory,'galta-logo-outline.svg'),
    resolve(publicDirectory,'galta-favicon.svg'),
    ...Object.keys(pluginInks).map(file => resolve(pluginDirectory, file)),
    resolve(pluginDirectory, 'browser-icon.svg'),
    ...[16,32,48,128].map(size => resolve(publicDirectory, `icons/${size}.png`)),
    resolve(evidence,'galta-logo-outline.png'),
    resolve(evidence,'galta-logo-outline-white.png'),
  ]) {
    const bytes = await readFile(file)
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    const isBrowserIcon = file === resolve(pluginDirectory, 'browser-icon.svg') || file.startsWith(resolve(publicDirectory, 'icons') + '/')
    const result = await page.evaluate(async ({data,mime}) => {
      const image=new Image();image.src=`data:${mime};base64,${data}`;await image.decode()
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512
      const context=canvas.getContext('2d')!;context.drawImage(image,0,0,512,512)
      const pixels=context.getImageData(0,0,512,512).data
      let opaquePixels=0,opaqueBlackPixels=0,opaqueWhitePixels=0,coveragePixels=0,maxAlpha=0
      for(let i=3;i<pixels.length;i+=4){
        const red=pixels[i-3]!,green=pixels[i-2]!,blue=pixels[i-1]!
        const alpha=pixels[i]!
        if(alpha===255){
          opaquePixels++
          if(red===0&&green===0&&blue===0)opaqueBlackPixels++
          if(red===255&&green===255&&blue===255)opaqueWhitePixels++
        }
        coveragePixels+=alpha/255
        maxAlpha=Math.max(maxAlpha,alpha)
      }
      return {width:image.naturalWidth,height:image.naturalHeight,centerAlpha:pixels[(256*512+256)*4+3],cornerAlpha:pixels[3],opaquePixels,opaqueBlackPixels,opaqueWhitePixels,coveragePixels,maxAlpha}
    }, {data:bytes.toString('base64'),mime})
    const centerAlpha = result.centerAlpha ?? 0
    if (isBrowserIcon) assert(centerAlpha > 0, `${file}: white backing`)
    else assert.equal(centerAlpha,0,`${file}: transparent counter`)
    assert.equal(result.cornerAlpha,0,`${file}: transparent background`)
    // At 16 px the thin diagonal edges are mostly antialiased. Measure ink
    // coverage rather than requiring a large area of completely opaque pixels.
    const maxCoverage = isBrowserIcon ? 512*512*0.7 : 512*512*0.4
    assert(result.coveragePixels>512*512*0.1 && result.coveragePixels<maxCoverage,`${file}: outline coverage ${result.coveragePixels}`)
    assert(result.maxAlpha>220,`${file}: visible ink`)
    if (file.startsWith(resolve(publicDirectory, 'icons') + '/')) {
      const size = Number(file.split('/').pop()!.replace('.png', ''))
      assert.equal(result.width, size)
      assert.equal(result.height, size)
    }
    if (file === resolve(publicDirectory, 'icons/32.png')) {
      assert(result.opaqueBlackPixels > 0, `${file}: black contour`)
      assert(result.opaqueWhitePixels > 0, `${file}: white backing`)
    }
    assets.push({path:file.slice(root.length+1),sha256:createHash('sha256').update(bytes).digest('hex'),...result})
  }
  await writeFile(resolve(evidence,'verification.json'),JSON.stringify({source:'apps/extension/src/public/galta-logo-outline.svg',sizes,assets},null,2)+'\n')
  console.log('Exported the approved outline to browser/plugin icons and favicon; retained the expressive native app icon.')
} finally { await browser.close() }

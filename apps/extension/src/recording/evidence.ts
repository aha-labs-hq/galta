import { RECORDING_LIMITS, type RecordingFrameRenderer } from '@galta/capture'

/** Agent-only evidence marks. Original recording pixels and canvas artwork are
 * never changed. Every mark is an observed path keyed to the temporal packet. */
export const renderRecordingEvidence: RecordingFrameRenderer = async (frame, moments) => {
  if (!moments.some(m => m.pointer.length)) return frame.dataUrl
  const image = await createImageBitmap(await (await fetch(frame.dataUrl)).blob())
  try {
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const labels: { x: number; y: number }[] = []
    const scale = Math.max(1, image.width / 1000)
    const hasSpeech = moments.some(m => m.kind !== 'pointer')
    // Quiet movement remains visible, but must not compete with speech-linked
    // evidence. Its exact times and coordinates remain in the temporal packet.
    const ordered = [...moments].sort((a, b) => Number(a.kind !== 'pointer') - Number(b.kind !== 'pointer'))
    for (const moment of ordered) {
      const quiet = hasSpeech && moment.kind === 'pointer'
      const points = moment.pointer.map(p => ({ t: p.t, x: (p.worldX - frame.view.x) / frame.view.width * image.width, y: (p.worldY - frame.view.y) / frame.view.height * image.height }))
      const anchor = points.filter(p => p.t <= (moment.start + moment.end) / 2).at(-1) ?? points[0]
      if (!anchor || !points.some(p => p.x >= 0 && p.x <= image.width && p.y >= 0 && p.y <= image.height)) continue
      ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))
      ctx.globalAlpha = quiet ? .22 : 1
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      ctx.lineWidth = (quiet ? 2 : 4) * scale; ctx.strokeStyle = '#000000'; ctx.stroke()
      ctx.lineWidth = (quiet ? 1 : 2) * scale; ctx.strokeStyle = quiet ? '#ffffff' : '#ffda55'; ctx.stroke()
      if (quiet) continue
      ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 3 * scale, 0, Math.PI * 2)
      ctx.fillStyle = '#ffda55'; ctx.fill(); ctx.strokeStyle = '#000000'; ctx.lineWidth = scale; ctx.stroke()
      const radius = 11 * scale
      const choices = [[24, -24], [24, 24], [-24, -24], [-24, 24], [0, -48], [0, 48]].map(([x, y]) => ({
        x: Math.max(radius, Math.min(image.width - radius, anchor.x + x! * scale)),
        y: Math.max(radius, Math.min(image.height - radius, anchor.y + y! * scale))
      }))
      const label = choices.find(p => labels.every(q => Math.hypot(p.x - q.x, p.y - q.y) >= radius * 2.5)) ?? choices[0]!
      labels.push(label)
      ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(label.x, label.y)
      ctx.strokeStyle = '#ffda55'; ctx.lineWidth = scale; ctx.stroke()
      ctx.beginPath(); ctx.arc(label.x, label.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = '#111111'; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.stroke()
      ctx.fillStyle = '#ffffff'; ctx.font = `600 ${12 * scale}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(moment.id), label.x, label.y)
    }
    ctx.globalAlpha = 1
    for (const quality of [.8, .65, .5]) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      if (blob.size > RECORDING_LIMITS.frameBytes) continue
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
      })
    }
    throw new Error('The annotated recording picture exceeds its size budget.')
  } finally { image.close() }
}

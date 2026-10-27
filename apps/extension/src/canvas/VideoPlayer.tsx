import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import { AssetURLs, type CanvasVideo, type CanvasAsset } from '@galta/canvas'
import { Button } from '@/components/ui/button'
import { formatDuration } from './video'
import './video.css'

type Playback = { time: number; volume: number; muted: boolean; rate: number; playing: boolean }
type Props = { video: CanvasVideo; source: CanvasAsset | undefined; poster: CanvasAsset | undefined; engaged: boolean; visible: boolean; selected: boolean; onExit: () => void }

/** Engine geometry stays outside this memoized renderer. Pointer movement and
 * camera updates do not rebuild media or scan the canvas's resource table. */
export const VideoPlayer = memo(function VideoPlayer({ video, source, poster, engaged, visible, selected, onExit }: Props) {
  const [failed, setFailed] = useState(false)
  const [posterURL, setPosterURL] = useState<string>()
  const playback = useRef<Playback>({ time: 0, volume: 1, muted: false, rate: 1, playing: true })
  const active = engaged && visible
  useEffect(() => {
    if (!engaged) playback.current.playing = true // The next explicit activation requests playback.
    setFailed(false)
  }, [engaged])
  useEffect(() => {
    const urls = new AssetURLs()
    setPosterURL(visible && poster ? urls.url(poster) : undefined)
    return () => urls.release()
  }, [poster, visible])
  const duration = formatDuration(video.duration)
  return <div className="excalidraw__embeddable canvas-video" data-theme="graphite" data-selected={selected ? 'true' : undefined} aria-label={`Video: ${video.name}`} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); onExit() }
  }} onKeyUp={event => event.stopPropagation()}>
    {active && source && !failed ? <VideoPlayback source={source} poster={posterURL} name={video.name} playback={playback} onError={() => setFailed(true)} /> : visible && <>
      {posterURL && <img src={posterURL} alt={video.name || 'Video poster'} draggable={false} decoding="async" />}
      {failed ? <div className="canvas-video-error" role="status"><span>Unable to play</span><Button type="button" variant="ghost" onClick={() => setFailed(false)}><RotateCcw aria-hidden="true" />Retry</Button></div> : <>
        <span className="canvas-video-play" aria-hidden="true"><Play fill="currentColor" /></span>
        <span className="canvas-video-duration" aria-label={`Duration ${duration}`}>{duration}</span>
      </>}
    </>}
  </div>
})

function VideoPlayback({ source, poster, name, playback, onError }: { source: CanvasAsset; poster: string | undefined; name: string; playback: RefObject<Playback>; onError: () => void }) {
  const player = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = player.current!, urls = new AssetURLs(), saved = playback.current
    const ready = () => {
      video.currentTime = saved.time < video.duration - .1 ? saved.time : 0
      video.volume = saved.volume; video.muted = saved.muted; video.playbackRate = saved.rate
      if (saved.playing) void video.play().catch(() => { /* Native controls remain available when autoplay is denied. */ })
    }
    video.addEventListener('loadedmetadata', ready, { once: true })
    video.src = urls.url(source)
    // A keyboard activation hands focus to the player; returning from a hidden
    // tab never takes focus from an input or another control.
    if (document.activeElement?.classList.contains('excalidraw')) video.focus({ preventScroll: true })
    return () => {
      if (video.readyState >= 1) playback.current = { time: video.currentTime, volume: video.volume, muted: video.muted, rate: video.playbackRate, playing: !video.paused && !video.ended }
      video.removeEventListener('loadedmetadata', ready)
      video.pause(); video.removeAttribute('src'); video.load(); urls.release()
    }
  }, [source, playback])
  return <video ref={player} poster={poster} controls playsInline preload="metadata" disablePictureInPicture disableRemotePlayback controlsList="nodownload noremoteplayback" aria-label={name || 'Canvas video'} onError={onError} />
}

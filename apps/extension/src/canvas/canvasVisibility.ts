import { createContext, useContext } from 'react'

/** Collection owns whether the editor is a working column or a hidden page. */
export const CanvasVisibility = createContext<boolean | null>(null)

export function useCanvasVisible() {
  const visible = useContext(CanvasVisibility)
  if (visible === null) throw new Error('Canvas visibility provider is missing')
  return visible
}

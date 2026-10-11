export const PI_MARK_VIEWBOX = '0 0 24 24'

export function createPiMarkSvg(size: number, className: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', PI_MARK_VIEWBOX)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)

  const text = document.createElementNS(ns, 'text')
  text.setAttribute('x', '12')
  text.setAttribute('y', '18')
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('font-family', 'ui-serif, Georgia, serif')
  text.setAttribute('font-size', '22')
  text.setAttribute('font-weight', '700')
  text.setAttribute('fill', 'currentColor')
  text.textContent = 'π'
  svg.append(text)
  return svg
}

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type * as Three from 'three'
import type { DeviceColour, Shot } from './content'
import { Desktop } from './device'

// The hero's desktop as a real 3D model (web/public/models/desktop.glb, CC BY 4.0
// — credited in the footer). three.js loads lazily so first paint never waits
// for it; until the model is ready, or where WebGL is unavailable, the SVG
// drawing shows instead. The model turns itself: tilted towards the copy in the
// hero, leaning after the pointer on hover, and flat in the full-screen view,
// where it can also be dragged round and a tap beside it dismisses the view.
// In the hero a fake cursor glides across the display and clicks to change the
// screenshot. The case takes the chosen colour, stands on a soft shadow, and its
// back carries the Nessie mark — a small Easter egg for whoever turns it round.

const modelUrl = '/models/desktop.glb'
const logoUrl = '/nessie-mark.svg'
// A negative quarter turn about Y faces the screen to the viewer. Turning a
// little further leans its left edge away, towards the copy.
const flatAngle = -Math.PI / 2
const tiltedAngle = flatAngle - 0.42
const hoverAngle = flatAngle - 0.26
// The screen's UVs cover only this horizontal band of its square texture; the
// band's top edge is at the higher v.
const screenBand = { top: 0.2394, bottom: 0.793 }
const textureSize = 2048
// The back logo: its centre height and its size, as fractions of the model.
const logoHeight = 0.69
const logoScale = 0.13
// The disc closing the old logo opening, as a fraction of the model's width.
const patchScale = 0.2
// Hover: how far the hero desktop leans after the pointer at the view's edge.
const wobbleYaw = 0.12
const wobblePitch = 0.06
// Dragging: radians per pixel, how far the model may tip, and how far a press
// may travel and still count as a tap.
const yawPerPixel = 0.01
const pitchPerPixel = 0.005
const maxPitch = 0.35
const tapSlop = 6
// The fake cursor: its size as a share of the screen width (large enough to read
// on the small hero display), the area its tip stays inside so the whole arrow
// remains on the display, and its timings.
const cursorSize = 0.07
const cursorArea = { left: 0.05, right: 0.88, top: 0.07, bottom: 0.84 }
const cursorMoveMs = 1100
const cursorClickMs = 380
const cursorSwapAt = 0.35

type Pose = 'tilted' | 'flat'

type SceneHandle = {
  setShot: (src: string) => void
  setAngle: (angle: number) => void
  setPitch: (pitch: number) => void
  setDragging: (dragging: boolean) => void
  setColour: (colour: DeviceColour) => void
  setCursorEnabled: (enabled: boolean) => void
  hitTest: (clientX: number, clientY: number) => boolean
  dispose: () => void
}

function angleFor(pose: Pose, hovered: boolean) {
  if (pose === 'flat') return flatAngle
  return hovered ? hoverAngle : tiltedAngle
}

function hasWebGl() {
  try {
    const probe = document.createElement('canvas')
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'))
  } catch {
    return false
  }
}

// An original arrow pointer: white with a navy outline and a soft shadow. Its
// tip sits near the canvas's top-left corner, which is where the shader anchors it.
function drawCursor(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) return
  const scale = canvas.width / 128
  context.scale(scale, scale)
  context.beginPath()
  context.moveTo(10, 8)
  context.lineTo(10, 104)
  context.lineTo(34, 82)
  context.lineTo(50, 118)
  context.lineTo(68, 110)
  context.lineTo(52, 75)
  context.lineTo(86, 75)
  context.closePath()
  context.shadowColor = 'rgba(0, 0, 0, 0.35)'
  context.shadowBlur = 8
  context.shadowOffsetY = 3
  context.fillStyle = '#ffffff'
  context.fill()
  context.shadowColor = 'transparent'
  context.lineJoin = 'round'
  context.lineWidth = 7
  context.strokeStyle = '#0b172a'
  context.stroke()
}

// Draws the cursor and its click ripple over the screenshot inside the screen's
// own shader, so moving it costs a few uniforms instead of re-uploading the
// 2048px screenshot texture every frame.
const cursorShaderHead = `
uniform sampler2D uCursor;
uniform vec2 uCursorUv;
uniform float uCursorSize;
uniform float uCursorOn;
uniform float uClick;
`

const cursorShaderBody = `
if (uCursorOn > 0.5) {
  vec2 offset = vec2(vMapUv.x - uCursorUv.x, uCursorUv.y - vMapUv.y);
  if (uClick > 0.0) {
    float radius = uClick * uCursorSize * 0.9;
    float edge = abs(length(offset) - radius);
    float ring = (1.0 - smoothstep(0.0, uCursorSize * 0.12, edge)) * (1.0 - uClick);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.01, 0.4, 0.98), ring * 0.6);
  }
  float press = 1.0 - 0.15 * sin(uClick * 3.14159);
  vec2 local = offset / (uCursorSize * press);
  if (local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0) {
    vec4 arrow = texture2D(uCursor, vec2(local.x, 1.0 - local.y));
    diffuseColor.rgb = mix(diffuseColor.rgb, arrow.rgb, arrow.a);
  }
}
`

type BackLogo = { patch: Three.MeshStandardMaterial; panel: Three.Material }

// Casts in from both sides of the centred model at logo height, off to one
// side: removing the manufacturer logo left an opening in the middle of the
// back shell, and a ray through it finds nothing. The side whose first hit is
// not the screen is the back. A disc in the panel's own material closes the
// opening, and the mark sits on the disc.
function addBackLogo(
  THREE: typeof Three,
  model: Three.Object3D,
  size: Three.Vector3,
  onLoad: () => void,
): BackLogo | null {
  const y = -size.y / 2 + logoHeight * size.y
  for (const side of [1, -1]) {
    const probe = new THREE.Vector3(side * size.x, y, size.z * 0.22)
    const hit = new THREE.Raycaster(probe, new THREE.Vector3(-side, 0, 0)).intersectObject(model, true)[0]
    if (!hit?.face || hit.object.userData.isScreen) continue

    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    if (normal.x * side < 0) normal.negate()
    // Project the panel's centre line onto the plane of the surface just hit.
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point)
    const centreRay = new THREE.Ray(new THREE.Vector3(side * size.x, y, 0), new THREE.Vector3(-side, 0, 0))
    const centre = centreRay.intersectPlane(plane, new THREE.Vector3())
    if (!centre) continue

    const place = (mesh: Three.Mesh, lift: number) => {
      const at = centre.clone().addScaledVector(normal, size.x * lift)
      model.add(mesh)
      mesh.position.copy(at).sub(model.position)
      mesh.updateMatrixWorld()
      mesh.lookAt(at.clone().add(normal))
    }

    const hitMaterial = (hit.object as Three.Mesh).material
    const panel = (Array.isArray(hitMaterial) ? hitMaterial[0] : hitMaterial) as Three.MeshStandardMaterial
    const patch = panel.clone()
    patch.polygonOffset = true
    patch.polygonOffsetFactor = -2
    place(new THREE.Mesh(new THREE.CircleGeometry((patchScale * size.z) / 2, 64), patch), 0.002)

    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // Not tone mapped, so the mark keeps its true brand colours.
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      roughness: 0.3,
      metalness: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    })
    const edge = logoScale * size.z
    place(new THREE.Mesh(new THREE.PlaneGeometry(edge, edge), material), 0.004)

    const image = new Image()
    image.onload = () => {
      const context = canvas.getContext('2d')
      if (!context) return
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
      const width = image.width * scale
      const height = image.height * scale
      context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      texture.needsUpdate = true
      onLoad()
    }
    image.src = logoUrl
    return { patch, panel }
  }
  return null
}

// A soft blurred ellipse on the floor under the stand, turning with the model.
// It is ignored by the full-screen tap test, so tapping it still dismisses.
function addFloorShadow(THREE: typeof Three, pivot: Three.Object3D, size: Three.Vector3) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, 'rgba(11, 23, 42, 0.62)')
    gradient.addColorStop(0.45, 'rgba(11, 23, 42, 0.28)')
    gradient.addColorStop(1, 'rgba(11, 23, 42, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 256, 256)
  }
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  shadow.rotation.x = -Math.PI / 2
  // After lying flat, the plane's x runs front to back and its y across the width.
  shadow.scale.set(size.x * 1.25, size.z * 0.5, 1)
  shadow.position.set(0, -size.y / 2, 0)
  shadow.renderOrder = -1
  shadow.userData.ignoreHit = true
  pivot.add(shadow)
}

async function createScene(host: HTMLElement, startAngle: number, colour: DeviceColour): Promise<SceneHandle | null> {
  if (!hasWebGl()) return null
  const THREE = await import('three')
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js')

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Neutral tone mapping keeps the pale case colours true; ACES pushed the
  // chin to white wherever it faced the light head-on.
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.domElement.className = 'n-device-canvas'
  renderer.domElement.setAttribute('aria-hidden', 'true')

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 1
  const key = new THREE.DirectionalLight(0xffffff, 0.85)
  key.position.set(-2, 3, 4)
  scene.add(key)

  let model: Three.Group
  try {
    model = (await new GLTFLoader().loadAsync(modelUrl)).scene
  } catch {
    renderer.dispose()
    pmrem.dispose()
    return null
  }

  let yaw = startAngle
  let targetYaw = startAngle
  let pitch = 0
  let targetPitch = 0
  let dragging = false
  let dirty = true
  let frame = 0
  let requestedShot = ''
  let shownShot = false
  let cursorEnabled = true
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Screenshots are painted into the screen's UV band on a canvas texture.
  const canvas = document.createElement('canvas')
  canvas.width = textureSize
  canvas.height = textureSize
  const context = canvas.getContext('2d')
  const texture = new THREE.CanvasTexture(canvas)
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy()

  const cursorCanvas = document.createElement('canvas')
  cursorCanvas.width = 256
  cursorCanvas.height = 256
  drawCursor(cursorCanvas)
  const cursorTexture = new THREE.CanvasTexture(cursorCanvas)
  cursorTexture.colorSpace = THREE.SRGBColorSpace
  const cursorUniforms = {
    uCursor: { value: cursorTexture },
    uCursorUv: { value: new THREE.Vector2() },
    uCursorSize: { value: cursorSize },
    uCursorOn: { value: 1 },
    uClick: { value: 0 },
  }
  const screenMaterial = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  screenMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cursorUniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${cursorShaderHead}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${cursorShaderBody}`)
  }

  // The cursor's tip, in screen coordinates: 0–1 from the display's left and top.
  const cursor = {
    x: 0.62,
    y: 0.55,
    fromX: 0.62,
    fromY: 0.55,
    toX: 0.62,
    toY: 0.55,
    phase: 'idle' as 'idle' | 'moving' | 'clicking',
    start: 0,
    pending: null as HTMLImageElement | null,
  }
  const placeCursor = () => {
    const v = screenBand.bottom - cursor.y * (screenBand.bottom - screenBand.top)
    cursorUniforms.uCursorUv.value.set(cursor.x, v)
  }
  placeCursor()

  // The model's light blue material is the chin and stand, dark blue the rear
  // shell; both are repainted in the chosen case colour.
  const fronts: Three.MeshStandardMaterial[] = []
  const backs: Three.MeshStandardMaterial[] = []
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const material = object.material as Three.MeshStandardMaterial
    if (material.name === 'Screen') {
      object.material = screenMaterial
      object.userData.isScreen = true
    } else if (material.name === 'LightBlue' && !fronts.includes(material)) {
      fronts.push(material)
    } else if (material.name === 'DarkBlue' && !backs.includes(material)) {
      backs.push(material)
    }
  })
  // Kept mostly non-metallic: as a strong metal the flat chin mirrors the white
  // studio light head-on and the case colour washes out in the full-screen view.
  for (const material of [...fronts, ...backs]) {
    material.metalness = Math.min(material.metalness, 0.15)
    material.metalnessMap = null
    material.roughness = Math.max(material.roughness, 0.45)
    material.needsUpdate = true
  }
  const paint = (next: DeviceColour) => {
    for (const material of fronts) material.color.set(next.front)
    for (const material of backs) material.color.set(next.back)
  }
  paint(colour)

  // Centre the model on its bounds, mark its back, and scale its largest side to 1.
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  model.position.sub(box.getCenter(new THREE.Vector3()))
  model.updateMatrixWorld(true)
  const backLogo = addBackLogo(THREE, model, size, () => {
    dirty = true
  })
  if (backLogo) {
    const group = fronts.some((material) => material === backLogo.panel) ? fronts : backs
    group.push(backLogo.patch)
  }
  const pivot = new THREE.Group()
  pivot.add(model)
  addFloorShadow(THREE, pivot, size)
  pivot.scale.setScalar(1 / Math.max(size.x, size.y, size.z))
  pivot.rotation.y = startAngle
  scene.add(pivot)

  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 50)
  camera.position.set(0, 0.02, 2.25)
  camera.lookAt(0, 0, 0)

  const drawShot = (image: HTMLImageElement) => {
    if (!context) return
    const bandTop = screenBand.top * textureSize
    const bandHeight = (screenBand.bottom - screenBand.top) * textureSize
    const scale = Math.max(textureSize / image.width, bandHeight / image.height)
    const width = image.width * scale
    const height = image.height * scale
    context.fillStyle = '#0b172a'
    context.fillRect(0, 0, textureSize, textureSize)
    // The screen's UVs run bottom-up, so the image is flipped about the band's
    // centre line or it renders upside down.
    context.save()
    context.translate(0, 2 * bandTop + bandHeight)
    context.scale(1, -1)
    context.drawImage(image, (textureSize - width) / 2, bandTop + (bandHeight - height) / 2, width, height)
    context.restore()
    texture.needsUpdate = true
    shownShot = true
    dirty = true
  }

  // Glide to a random spot at least a quarter of the display away, then click;
  // the new screenshot lands a moment into the click.
  const clickTo = (image: HTMLImageElement) => {
    let toX = cursor.x
    let toY = cursor.y
    for (let attempt = 0; attempt < 12 && Math.hypot(toX - cursor.x, toY - cursor.y) < 0.25; attempt++) {
      toX = cursorArea.left + Math.random() * (cursorArea.right - cursorArea.left)
      toY = cursorArea.top + Math.random() * (cursorArea.bottom - cursorArea.top)
    }
    Object.assign(cursor, { fromX: cursor.x, fromY: cursor.y, toX, toY, phase: 'moving', start: performance.now() })
    cursor.pending = image
  }

  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    if (width === 0 || height === 0) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    dirty = true
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  const tick = () => {
    frame = requestAnimationFrame(tick)
    const ease = reduceMotion ? 1 : dragging ? 0.35 : 0.09
    const yawDelta = targetYaw - yaw
    const pitchDelta = targetPitch - pitch
    if (Math.abs(yawDelta) > 0.0005 || Math.abs(pitchDelta) > 0.0005) {
      yaw += yawDelta * ease
      pitch += pitchDelta * ease
      pivot.rotation.set(pitch, yaw, 0)
      dirty = true
    }
    if (cursor.phase !== 'idle') {
      const now = performance.now()
      if (cursor.phase === 'moving') {
        const t = Math.min(1, (now - cursor.start) / cursorMoveMs)
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
        cursor.x = cursor.fromX + (cursor.toX - cursor.fromX) * eased
        cursor.y = cursor.fromY + (cursor.toY - cursor.fromY) * eased
        if (t >= 1) Object.assign(cursor, { phase: 'clicking', start: now })
      } else {
        const t = Math.min(1, (now - cursor.start) / cursorClickMs)
        cursorUniforms.uClick.value = t
        if (t >= cursorSwapAt && cursor.pending) {
          drawShot(cursor.pending)
          cursor.pending = null
        }
        if (t >= 1) {
          cursor.phase = 'idle'
          cursorUniforms.uClick.value = 0
        }
      }
      placeCursor()
      dirty = true
    }
    if (!dirty) return
    dirty = false
    renderer.render(scene, camera)
  }

  host.appendChild(renderer.domElement)
  tick()

  return {
    setShot(src) {
      requestedShot = src
      const image = new Image()
      image.onload = () => {
        if (requestedShot !== src) return
        if (!shownShot || !cursorEnabled || reduceMotion) drawShot(image)
        else clickTo(image)
      }
      image.src = src
    },
    setAngle(next) {
      targetYaw = next
    },
    setPitch(next) {
      targetPitch = next
    },
    setDragging(next) {
      dragging = next
    },
    setColour(next) {
      paint(next)
      dirty = true
    },
    setCursorEnabled(enabled) {
      cursorEnabled = enabled
      cursorUniforms.uCursorOn.value = enabled ? 1 : 0
      if (!enabled) {
        if (cursor.pending) drawShot(cursor.pending)
        cursor.pending = null
        cursor.phase = 'idle'
        cursorUniforms.uClick.value = 0
      }
      dirty = true
    },
    hitTest(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect()
      const point = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      const ray = new THREE.Raycaster()
      ray.setFromCamera(point, camera)
      return ray.intersectObject(pivot, true).some((hit) => !hit.object.userData.ignoreHit)
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      pivot.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) {
          ;(material as Three.MeshStandardMaterial).map?.dispose()
          material.dispose()
        }
      })
      cursorTexture.dispose()
      texture.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

type DeviceViewProps = {
  shot: Shot
  idPrefix: string
  pose: Pose
  colour: DeviceColour
  hovered?: boolean
  interactive?: boolean
  onDismiss?: () => void
}

type Drag = { x: number; y: number; yaw: number; pitch: number; onModel: boolean; moved: boolean }

export function DeviceView({
  shot,
  idPrefix,
  pose,
  colour,
  hovered = false,
  interactive = false,
  onDismiss,
}: DeviceViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<SceneHandle | null>(null)
  const latest = useRef({ src: shot.src, angle: angleFor(pose, hovered), colour })
  const orientation = useRef({ yaw: angleFor(pose, hovered), pitch: 0 })
  const drag = useRef<Drag | null>(null)
  const [ready, setReady] = useState(false)

  latest.current = { src: shot.src, angle: angleFor(pose, hovered), colour }

  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    let cancelled = false
    // Every view starts tilted, so the full-screen one visibly swings flat.
    void createScene(element, tiltedAngle, latest.current.colour).then((scene) => {
      if (!scene) return
      if (cancelled) {
        scene.dispose()
        return
      }
      handle.current = scene
      scene.setShot(latest.current.src)
      scene.setAngle(latest.current.angle)
      scene.setColour(latest.current.colour)
      setReady(true)
    })
    return () => {
      cancelled = true
      handle.current?.dispose()
      handle.current = null
    }
  }, [])

  useEffect(() => {
    handle.current?.setShot(shot.src)
  }, [shot.src, ready])

  useEffect(() => {
    handle.current?.setColour(colour)
  }, [colour, ready])

  // The fake cursor belongs to the small hero display only.
  useEffect(() => {
    handle.current?.setCursorEnabled(!interactive)
  }, [interactive, ready])

  useEffect(() => {
    const yaw = angleFor(pose, hovered)
    orientation.current = { yaw, pitch: 0 }
    handle.current?.setAngle(yaw)
    handle.current?.setPitch(0)
  }, [pose, hovered, ready])

  // iPad Safari turns a touch into its own page pan or zoom — cancelling the
  // pointer stream — unless the touch is claimed with a non-passive listener.
  useEffect(() => {
    const element = host.current
    if (!interactive || !element) return undefined
    const claim = (event: TouchEvent) => event.preventDefault()
    element.addEventListener('touchstart', claim, { passive: false })
    element.addEventListener('touchmove', claim, { passive: false })
    return () => {
      element.removeEventListener('touchstart', claim)
      element.removeEventListener('touchmove', claim)
    }
  }, [interactive])

  // Hero hover: lean a little after the pointer.
  const onHoverMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hovered || !handle.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const y = ((event.clientY - rect.top) / rect.height) * 2 - 1
    handle.current.setAngle(angleFor(pose, true) + x * wobbleYaw)
    handle.current.setPitch(y * wobblePitch)
  }

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!handle.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const onModel = handle.current.hitTest(event.clientX, event.clientY)
    drag.current = { x: event.clientX, y: event.clientY, ...orientation.current, onModel, moved: false }
    handle.current.setDragging(true)
  }

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || !handle.current) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) > tapSlop) start.moved = true
    const yaw = start.yaw + dx * yawPerPixel
    const pitch = Math.max(-maxPitch, Math.min(maxPitch, start.pitch + dy * pitchPerPixel))
    orientation.current = { yaw, pitch }
    handle.current.setAngle(yaw)
    handle.current.setPitch(pitch)
  }

  // A tap that misses the model dismisses, wherever it lands in the view's box.
  const onDragEnd = () => {
    const ended = drag.current
    drag.current = null
    handle.current?.setDragging(false)
    if (ended && !ended.moved && !ended.onModel) onDismiss?.()
  }

  const onDragCancel = () => {
    drag.current = null
    handle.current?.setDragging(false)
  }

  const classes = ['n-device-view', ready && 'n-device-ready', interactive && 'n-device-draggable']
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      onPointerCancel={interactive ? onDragCancel : undefined}
      onPointerDown={interactive ? onDragStart : undefined}
      onPointerMove={interactive ? onDragMove : onHoverMove}
      onPointerUp={interactive ? onDragEnd : undefined}
      ref={host}
    >
      <Desktop idPrefix={idPrefix} shot={shot} tint={colour} />
    </div>
  )
}

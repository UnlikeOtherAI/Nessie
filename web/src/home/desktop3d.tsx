import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type * as Three from 'three'
import type { Shot } from './content'
import { Desktop } from './device'

// The hero's desktop as a real 3D model (web/public/models/desktop.glb, CC BY 4.0
// — credited in the footer). three.js loads lazily so first paint never waits
// for it; until the model is ready, or where WebGL is unavailable, the SVG
// drawing shows instead. The model turns itself: tilted towards the copy in the
// hero, a little less on hover, and flat in the full-screen view, where it can
// also be dragged round. The back of the case carries the Nessie mark — a small
// Easter egg for whoever turns it around.

const modelUrl = '/models/desktop.glb'
const logoUrl = '/nessie-mark.svg'
// A negative quarter turn about Y faces the screen to the viewer. Turning a
// little further leans its left edge away, towards the copy.
const flatAngle = -Math.PI / 2
const tiltedAngle = flatAngle - 0.42
const hoverAngle = flatAngle - 0.26
// The screen's UVs cover only this horizontal band of its square texture.
const screenBand = { top: 0.2394, bottom: 0.793 }
const textureSize = 2048
// The back logo: its centre height and its size, as fractions of the model.
const logoHeight = 0.69
const logoScale = 0.13
// Dragging: radians per pixel, and how far the model may tip up or down.
const yawPerPixel = 0.01
const pitchPerPixel = 0.005
const maxPitch = 0.35

type Pose = 'tilted' | 'flat'

type SceneHandle = {
  setShot: (src: string) => void
  setAngle: (angle: number) => void
  setPitch: (pitch: number) => void
  setDragging: (dragging: boolean) => void
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

// Casts in from both sides of the centred model at logo height. The side whose
// first hit is not the screen is the back; the mark sits just off that surface.
function addBackLogo(THREE: typeof Three, model: Three.Object3D, size: Three.Vector3, onLoad: () => void) {
  const y = -size.y / 2 + logoHeight * size.y
  for (const side of [1, -1]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(side * size.x, y, 0), new THREE.Vector3(-side, 0, 0))
    const hit = ray.intersectObject(model, true)[0]
    if (!hit?.face || hit.object.userData.isScreen) continue

    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    if (normal.x * side < 0) normal.negate()
    const point = hit.point.clone().addScaledVector(normal, size.x * 0.003)

    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      roughness: 0.3,
      metalness: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    })
    const edge = logoScale * size.z
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(edge, edge), material)
    model.add(decal)
    decal.position.copy(point).sub(model.position)
    decal.updateMatrixWorld()
    decal.lookAt(point.clone().add(normal))

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
    return
  }
}

async function createScene(host: HTMLElement, startAngle: number): Promise<SceneHandle | null> {
  if (!hasWebGl()) return null
  const THREE = await import('three')
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js')

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.domElement.className = 'n-device-canvas'
  renderer.domElement.setAttribute('aria-hidden', 'true')

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  const key = new THREE.DirectionalLight(0xffffff, 1.1)
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

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const material = object.material as Three.MeshStandardMaterial
    if (material.name === 'Screen') {
      object.material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
      object.userData.isScreen = true
    } else if (material.name === 'LightBlue') {
      material.color.set('#b9d1fb')
    } else if (material.name === 'DarkBlue') {
      material.color.set('#8fb0ea')
    }
  })

  // Centre the model on its bounds, mark its back, and scale its largest side to 1.
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  model.position.sub(box.getCenter(new THREE.Vector3()))
  model.updateMatrixWorld(true)
  addBackLogo(THREE, model, size, () => {
    dirty = true
  })
  const pivot = new THREE.Group()
  pivot.add(model)
  pivot.scale.setScalar(1 / Math.max(size.x, size.y, size.z))
  pivot.rotation.y = startAngle
  scene.add(pivot)

  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 50)
  camera.position.set(0, 0.02, 2.25)
  camera.lookAt(0, 0, 0)

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
        if (requestedShot !== src || !context) return
        const bandTop = screenBand.top * textureSize
        const bandHeight = (screenBand.bottom - screenBand.top) * textureSize
        const scale = Math.max(textureSize / image.width, bandHeight / image.height)
        const width = image.width * scale
        const height = image.height * scale
        context.fillStyle = '#0b172a'
        context.fillRect(0, 0, textureSize, textureSize)
        // The screen's UVs run bottom-up, so the image is flipped about the
        // band's centre line or it renders upside down.
        context.save()
        context.translate(0, 2 * bandTop + bandHeight)
        context.scale(1, -1)
        context.drawImage(image, (textureSize - width) / 2, bandTop + (bandHeight - height) / 2, width, height)
        context.restore()
        texture.needsUpdate = true
        dirty = true
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
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) {
          ;(material as Three.MeshStandardMaterial).map?.dispose()
          material.dispose()
        }
      })
      texture.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

type DeviceViewProps = { shot: Shot; idPrefix: string; pose: Pose; hovered?: boolean; interactive?: boolean }

export function DeviceView({ shot, idPrefix, pose, hovered = false, interactive = false }: DeviceViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<SceneHandle | null>(null)
  const latest = useRef({ src: shot.src, angle: angleFor(pose, hovered) })
  const orientation = useRef({ yaw: angleFor(pose, hovered), pitch: 0 })
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  const [ready, setReady] = useState(false)

  latest.current = { src: shot.src, angle: angleFor(pose, hovered) }

  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    let cancelled = false
    // Every view starts tilted, so the full-screen one visibly swings flat.
    void createScene(element, tiltedAngle).then((scene) => {
      if (!scene) return
      if (cancelled) {
        scene.dispose()
        return
      }
      handle.current = scene
      scene.setShot(latest.current.src)
      scene.setAngle(latest.current.angle)
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
    const yaw = angleFor(pose, hovered)
    orientation.current = { yaw, pitch: 0 }
    handle.current?.setAngle(yaw)
    handle.current?.setPitch(0)
  }, [pose, hovered, ready])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!handle.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, ...orientation.current }
    handle.current.setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || !handle.current) return
    const yaw = start.yaw + (event.clientX - start.x) * yawPerPixel
    const pitch = Math.max(-maxPitch, Math.min(maxPitch, start.pitch + (event.clientY - start.y) * pitchPerPixel))
    orientation.current = { yaw, pitch }
    handle.current.setAngle(yaw)
    handle.current.setPitch(pitch)
  }

  const endDrag = () => {
    drag.current = null
    handle.current?.setDragging(false)
  }

  const classes = ['n-device-view', ready && 'n-device-ready', interactive && 'n-device-draggable']
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      onPointerCancel={interactive ? endDrag : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? endDrag : undefined}
      ref={host}
    >
      <Desktop idPrefix={idPrefix} shot={shot} />
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type * as Three from 'three'
import type { Shot } from './content'
import { Desktop } from './device'

// The hero's desktop as a real 3D model (web/public/models/desktop.glb, CC BY 4.0
// — credited in the footer). three.js loads lazily so first paint never waits
// for it; until the model is ready, or where WebGL is unavailable, the SVG
// drawing shows instead. The model turns itself: tilted towards the copy in the
// hero, a little less on hover, and flat in the full-screen view.

const modelUrl = '/models/desktop.glb'
// A negative quarter turn about Y faces the screen to the viewer (+π/2 shows
// the back). Turning a little further leans its left edge away, towards the
// copy. The back panel is never shown from any of these poses.
const flatAngle = -Math.PI / 2
const tiltedAngle = flatAngle - 0.42
const hoverAngle = flatAngle - 0.26
// The screen's UVs cover only this horizontal band of its square texture.
const screenBand = { top: 0.2394, bottom: 0.793 }
const textureSize = 2048

type Pose = 'tilted' | 'flat'

type SceneHandle = {
  setShot: (src: string) => void
  setAngle: (angle: number) => void
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

  // Centre the model on its bounds and scale its largest side to 1.
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  model.position.sub(box.getCenter(new THREE.Vector3()))
  const pivot = new THREE.Group()
  pivot.add(model)
  pivot.scale.setScalar(1 / Math.max(size.x, size.y, size.z))
  pivot.rotation.y = startAngle
  scene.add(pivot)

  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 50)
  camera.position.set(0, 0.02, 2.25)
  camera.lookAt(0, 0, 0)

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
    } else if (material.name === 'LightBlue') {
      material.color.set('#b9d1fb')
    } else if (material.name === 'DarkBlue') {
      material.color.set('#8fb0ea')
    }
  })

  let angle = startAngle
  let target = startAngle
  let dirty = true
  let frame = 0
  let requestedShot = ''
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
    const delta = target - angle
    if (Math.abs(delta) > 0.0005) {
      angle = reduceMotion ? target : angle + delta * 0.09
      pivot.rotation.y = angle
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
      target = next
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      })
      texture.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

type DeviceViewProps = { shot: Shot; idPrefix: string; pose: Pose; hovered?: boolean }

export function DeviceView({ shot, idPrefix, pose, hovered = false }: DeviceViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<SceneHandle | null>(null)
  const latest = useRef({ src: shot.src, angle: angleFor(pose, hovered) })
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
    handle.current?.setAngle(angleFor(pose, hovered))
  }, [pose, hovered, ready])

  return (
    <div className={ready ? 'n-device-view n-device-ready' : 'n-device-view'} ref={host}>
      <Desktop idPrefix={idPrefix} shot={shot} />
    </div>
  )
}

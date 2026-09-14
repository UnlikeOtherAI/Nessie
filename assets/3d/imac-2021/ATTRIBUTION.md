# Desktop computer 3D model

## Credit

"iMac 2021" by [DatSketch](https://sketchfab.com/DatSketch), from
[Sketchfab](https://sketchfab.com/3d-models/imac-2021-304cb06ffb554883a7a642b2b56754c1),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The public site credits the model in its footer (`modelCredit` in
`web/src/home/content.ts`). Keep that credit wherever the model is shown.

## Changes from the original

- The manufacturer logo modelled on the back of the case (two small loose
  parts in the light blue material) was deleted in Blender from the GLB, the
  `.blend`, and the FBX, which was re-exported from the cleaned `.blend`.
- `web/public/models/desktop.glb` is the author's Sketchfab glTF export with the
  screen material's texture replaced by a plain placeholder image.
- At runtime `web/src/home/desktop3d.tsx` recolours the body and stand, paints
  Nessie screenshots onto the screen, and places the Nessie mark on the back.

## Contents

- `source/iMacBYDATSKETCH.blend` — the author's Blender scene.
- `source/iMac.fbx` — the author's FBX export.
- `textures/` — the author's camera, noise and steel textures.

## Left out on purpose

- `1-740x740.jpg`, the original screen wallpaper: a third-party desktop image,
  not the model author's work. The `.blend` refers to it by path, so the
  scene opens with that one texture missing.
- The Blender autosave (`.blend1`) and the duplicate OBJ, MTL and GLB exports.

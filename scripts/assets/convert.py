"""
Convert source models (FBX, OBJ or .blend) into the GLB files the game loads.

    blender -b --factory-startup -P scripts/assets/convert.py -- <out_dir> <model>...

Only meshes are kept (source files sometimes carry their preview camera and
lights). Scale, orientation and pivots are left alone: the game fits each
model at load time (see src/fps/models.ts).
"""

import os
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) < 2:
    sys.exit("usage: blender -b -P convert.py -- <out_dir> <model>...")
out_dir, sources = args[0], args[1:]
os.makedirs(out_dir, exist_ok=True)

for src in sources:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(src)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=src)
    else:
        sys.exit(f"unsupported model format: {src}")

    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            bpy.data.objects.remove(obj)

    out = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_apply=True,
        export_texcoords=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")

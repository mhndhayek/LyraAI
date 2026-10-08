"""blender -b --python build.py -- AvatarSample_B.vrm out_<variant> <prefix>
Swaps painted textures into B, renders front/back/bust, exports <prefix>.vrm with Lyra metadata."""
import bpy, sys, os, math, mathutils
argv = sys.argv[sys.argv.index("--") + 1:]
src, texdir, prefix = argv[0], argv[1], argv[2]
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
print("IMPORT", bpy.ops.import_scene.vrm(filepath=src))

for f in sorted(os.listdir(texdir)):
    name = f[:-4]
    if name.endswith('_short'): continue
    im = bpy.data.images.get(name)
    if not im: print("MISSING", name); continue
    new = bpy.data.images.load(os.path.abspath(os.path.join(texdir, f)))
    assert tuple(new.size) == tuple(im.size), (name, new.size[:], im.size[:])
    im.pixels.foreach_set(new.pixels[:]); im.update(); im.pack()
    bpy.data.images.remove(new)
    print("SWAPPED", name)

# Short top locks (bangs/crown islands that never drop below the chin) -> pink-only material.
short_png = os.path.join(texdir, 'F00_000_Hair_00_02_short.png')
if os.path.exists(short_png):
    import bmesh
    o = bpy.data.objects['Hair001']; me = o.data
    mi = next(i for i, m in enumerate(me.materials) if m.name == 'F00_000_Hair_00_HAIR_02')
    base = me.materials[mi]; short = base.copy(); short.name = 'F00_000_Hair_00_HAIR_02_short'
    img = bpy.data.images.load(os.path.abspath(short_png)); img.name = 'F00_000_Hair_00_02_short'; img.pack()
    t = short.vrm_addon_extension.mtoon1
    t.pbr_metallic_roughness.base_color_texture.index.source = img
    t.extensions.vrmc_materials_mtoon.shade_multiply_texture.index.source = img
    me.materials.append(short); si = len(me.materials) - 1
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    mw = o.matrix_world; seen = set(); n_isl = n_short = 0
    for f in bm.faces:
        if f.index in seen or f.material_index != mi: continue
        isl, stack = [], [f]; seen.add(f.index)
        while stack:
            g = stack.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen and h.material_index == mi: seen.add(h.index); stack.append(h)
        n_isl += 1
        zmin = min((mw @ v.co).z for g in isl for v in g.verts)
        if zmin > float(os.environ.get('SHORT_Z', '1.30')):
            n_short += 1
            for g in isl: g.material_index = si
    bm.to_mesh(me); bm.free(); me.update()
    print("SHORT islands", n_short, "of", n_isl)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ext = arm.data.vrm_addon_extension
print("SPEC", ext.spec_version)
meta = ext.vrm0.meta
meta.title = "Lyra"; meta.author = "mhndhayek (recolour of VRoid Project AvatarSample_B)"
meta.version = "0.1"; meta.reference = "VRoid Project AvatarSample_B"
print("META", meta.title, meta.allowed_user_name, meta.license_name, meta.other_license_url)

scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == "MESH" and not o.hide_render]
mins = mathutils.Vector((1e9,) * 3); maxs = mathutils.Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        for i in range(3): mins[i] = min(mins[i], w[i]); maxs[i] = max(maxs[i], w[i])
ctr = (mins + maxs) / 2; H = maxs.z - mins.z
cd = bpy.data.cameras.new("cam"); cd.type = "ORTHO"; cd.clip_end = 200
cam = bpy.data.objects.new("cam", cd); scene.collection.objects.link(cam); scene.camera = cam
sd = bpy.data.lights.new("sun", "SUN"); sd.energy = 3.0
sun = bpy.data.objects.new("sun", sd); scene.collection.objects.link(sun)
wd = bpy.data.worlds.new("w"); wd.use_nodes = True
wd.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.83, 0.86, 1); scene.world = wd
scene.render.engine = "BLENDER_EEVEE"
try: scene.eevee.taa_render_samples = 24
except Exception: pass
scene.view_settings.view_transform = "Standard"; scene.render.image_settings.file_format = "PNG"

def shoot(back, cz, scale, px, path):
    if back:
        cam.location = (ctr.x, ctr.y + 10, cz); cam.rotation_euler = (math.radians(90), 0, math.radians(180))
        sun.rotation_euler = (math.radians(60), 0, math.radians(165))
    else:
        cam.location = (ctr.x, ctr.y - 10, cz); cam.rotation_euler = (math.radians(90), 0, 0)
        sun.rotation_euler = (math.radians(60), 0, math.radians(-15))
    cd.ortho_scale = scale; scene.render.resolution_x = scene.render.resolution_y = px
    scene.render.filepath = path; bpy.ops.render.render(write_still=True); print("RENDERED", path)

span = H * 1.06
shoot(False, ctr.z, span, 900, prefix + "_front.png")
shoot(True, ctr.z, span, 900, prefix + "_back.png")
bust = H * 0.30
shoot(False, maxs.z - bust * 0.52, bust, 900, prefix + "_bust.png")

for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT'): bpy.data.objects.remove(o, do_unlink=True)
print("EXPORT", bpy.ops.export_scene.vrm(filepath=prefix + ".vrm"))
bpy.ops.wm.save_as_mainfile(filepath=prefix + ".blend")
print("DONE")

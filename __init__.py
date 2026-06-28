"""ComfyUI VRM Scene Editor (VRMシーンエディタ).

Adds a launch button next to the ComfyUI settings button (same place as LoRA
Manager). The button opens a standalone editor page that loads and displays a
VRM / GLB / GLTF model with three.js + @pixiv/three-vrm.

Routes:
  GET  /vrm-scene-editor          -> editor/index.html
  GET  /vrm-scene-editor-assets/* -> static files under editor/ (JS, vendor libs)
  GET  /vrm-scene-models/*        -> static files under models/ (user VRM library)
  GET  /vrm-scene-editor/models   -> list of VRM/GLB files in models/vrm
  GET  /vrm-scene-editor/thumbnail?file=X -> a VRM's embedded thumbnail image
  POST /vrm-scene-editor/save-thumbnail   -> save a rendered <name>.png next to a model
  POST /vrm-scene-editor/save-scene       -> save models/scene/<name>.json + .png thumbnail
  POST /vrm-scene-editor/capture  -> save {camera}_{type}.png + register it
  GET  /vrm-scene-editor/default-folder -> the default output folder path
  GET  /vrm-scene-editor/channels -> list of registered camera/type captures

Graph node:
  VRMSceneCapture -- selects a capture by (camera, type) from the in-process
  registry, loads it as IMAGE/MASK, and previews it in the node.
"""

import base64
import binascii
import datetime
import json
import re
import struct
import time
from pathlib import Path

from aiohttp import web

# Tell ComfyUI where the front-end extension (the launch button JS) lives.
WEB_DIRECTORY = "./web"

# Path the launch button opens, and where the editor assets are served.
VRM_SCENE_EDITOR_PATH = "/vrm-scene-editor"
VRM_SCENE_EDITOR_ASSETS_PATH = "/vrm-scene-editor-assets"

_EDITOR_DIR = Path(__file__).parent / "editor"
_INDEX_HTML = _EDITOR_DIR / "index.html"

# User asset library under models/. Drop VRM/GLB files into models/vrm to load
# them from the editor; the sibling folders hold poses / hand poses / scenes.
_MODELS_DIR = Path(__file__).parent / "models"
_MODEL_SUBDIRS = ("vrm", "pose", "hand_pose", "scene")
_MODEL_LIB_DIR = _MODELS_DIR / "vrm"
_SCENE_DIR = _MODELS_DIR / "scene"
# Pose files (VRoid Studio *.vroidpose / *.json) live under models/pose so their
# thumbnails are served by the same /vrm-scene-models static mount.
_POSE_DIR = _MODELS_DIR / "pose"
_POSE_EXTS = (".vroidpose", ".json")
_MODEL_EXTS = (".vrm", ".glb", ".gltf")
_MODELS_ASSETS_PATH = "/vrm-scene-models"


def _ensure_model_dirs():
    """Create models/ and its category subfolders if they don't exist yet."""
    for sub in _MODEL_SUBDIRS:
        try:
            (_MODELS_DIR / sub).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            print(f"{_LOG_PREFIX} could not create models/{sub}: {exc}")


_GLB_MAGIC = b"glTF"
_GLB_CHUNK_JSON = 0x4E4F534A  # "JSON"
_GLB_CHUNK_BIN = 0x004E4942   # "BIN\0"


def _extract_vrm_thumbnail(path: Path):
    """Return (image_bytes, mime) of a VRM's embedded thumbnail, or None.

    VRM1 stores meta.thumbnailImage (image index); VRM0 stores meta.texture
    (texture index -> textures[].source). The image lives in the GLB BIN chunk
    via a bufferView. Reads only the header + JSON + the thumbnail bytes.
    """
    try:
        with path.open("rb") as f:
            header = f.read(12)
            if len(header) < 12 or header[:4] != _GLB_MAGIC:
                return None  # not a binary glTF (e.g. a .gltf text file)
            ch = f.read(8)
            if len(ch) < 8:
                return None
            clen, ctype = struct.unpack("<II", ch)
            if ctype != _GLB_CHUNK_JSON:
                return None
            gltf = json.loads(f.read(clen).decode("utf-8"))
            ch2 = f.read(8)
            if len(ch2) < 8:
                return None
            _blen, btype = struct.unpack("<II", ch2)
            if btype != _GLB_CHUNK_BIN:
                return None
            bin_start = f.tell()

            ext = gltf.get("extensions", {}) or {}
            img_idx = None
            meta1 = (ext.get("VRMC_vrm") or {}).get("meta")
            if meta1 and isinstance(meta1.get("thumbnailImage"), int):
                img_idx = meta1["thumbnailImage"]
            else:
                meta0 = (ext.get("VRM") or {}).get("meta")
                tex = meta0.get("texture") if meta0 else None
                if isinstance(tex, int) and tex >= 0:
                    textures = gltf.get("textures", [])
                    if 0 <= tex < len(textures):
                        img_idx = textures[tex].get("source")
            if not isinstance(img_idx, int):
                return None

            images = gltf.get("images", [])
            if not (0 <= img_idx < len(images)):
                return None
            image = images[img_idx]
            bv_idx = image.get("bufferView")
            if not isinstance(bv_idx, int):
                return None  # external-URI images not supported
            bvs = gltf.get("bufferViews", [])
            if not (0 <= bv_idx < len(bvs)):
                return None
            bv = bvs[bv_idx]
            f.seek(bin_start + bv.get("byteOffset", 0))
            img_bytes = f.read(bv.get("byteLength", 0))
            if not img_bytes:
                return None
            return img_bytes, image.get("mimeType", "image/png")
    except (OSError, ValueError, KeyError, struct.error):
        return None

# data:image/png;base64,.... prefix that browsers prepend to canvas.toDataURL().
_DATA_URL_RE = re.compile(r"^data:image/[a-z0-9.+-]+;base64,", re.IGNORECASE)

# Filename-safe token: keep letters/digits/_/-, collapse everything else to "_".
_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_\-]+")

# Image types a camera can render. canny/openpose come later.
CAPTURE_TYPES = ["image", "mask", "mask(hands)", "seg", "depth", "normal", "openpose(body)", "openpose(hands)", "openpose(body+hands)"]

# Cameras the node can switch between (camera1 .. camera9).
CAMERAS = [f"camera{i}" for i in range(1, 10)]

# In-process registry of the latest capture per (camera, type), shared between
# the HTTP route (writer) and the graph node (reader) -- same process.
#   _REGISTRY[camera][type] = {"path": str, "token": str}
_REGISTRY: dict[str, dict[str, dict]] = {}


def _safe_token(value, default: str) -> str:
    token = _UNSAFE_RE.sub("_", (value or "").strip())
    return token or default


def _default_output_folder() -> Path:
    """ComfyUI's output directory, or a local fallback if unavailable."""
    try:
        import folder_paths  # provided by ComfyUI at runtime

        return Path(folder_paths.get_output_directory())
    except Exception:
        return _EDITOR_DIR.parent / "captures"


# Subfolder under ComfyUI's temp dir for live-preview copies served via /view.
_PREVIEW_SUBFOLDER = "vrm_scene_editor"


def _write_temp_preview(camera: str, image_type: str, png_bytes: bytes):
    """Write a served copy to ComfyUI's temp dir so the open graph can preview
    a capture *before* execution. Returns a /view descriptor (filename/subfolder/
    type) or None if the temp dir is unavailable. Overwrites per (camera, type)."""
    try:
        import folder_paths

        base = Path(folder_paths.get_temp_directory())
    except Exception:
        return None

    folder = base / _PREVIEW_SUBFOLDER
    name = f"{camera}_{image_type}.png"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(png_bytes)
    except OSError:
        return None
    return {"filename": name, "subfolder": _PREVIEW_SUBFOLDER, "type": "temp"}


_LOG_PREFIX = "[VRM Scene Editor]"


def _register_routes():
    """Register the editor page + static asset routes on ComfyUI's server."""
    try:
        from server import PromptServer
    except Exception as exc:  # pragma: no cover - ComfyUI not available
        print(f"{_LOG_PREFIX} PromptServer unavailable, routes NOT registered: {exc}")
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        print(f"{_LOG_PREFIX} PromptServer.instance is None, routes NOT registered")
        return

    _ensure_model_dirs()  # make models/vrm etc. before the static route binds

    @instance.routes.get(VRM_SCENE_EDITOR_PATH)
    async def _vrm_scene_editor_page(_request):
        if not _INDEX_HTML.exists():
            return web.Response(status=404, text="VRM Scene Editor index.html not found")
        # Never cache the page itself: it carries the ?v= cache-buster for main.js,
        # so a stale index.html would keep loading an old main.js even after edits.
        return web.FileResponse(_INDEX_HTML, headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        })

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/default-folder")
    async def _vrm_scene_editor_default_folder(_request):
        return web.json_response({"folder": str(_default_output_folder())})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/channels")
    async def _vrm_scene_editor_channels(_request):
        channels = [
            {"camera": cam, "type": t, "path": entry["path"], "token": entry["token"], "preview": entry.get("preview")}
            for cam, types in _REGISTRY.items()
            for t, entry in types.items()
        ]
        return web.json_response({"channels": channels})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/models")
    async def _vrm_scene_editor_models(_request):
        """List the VRM/GLB/GLTF files the user dropped into models/vrm."""
        models = []
        if _MODEL_LIB_DIR.is_dir():
            for p in sorted(_MODEL_LIB_DIR.iterdir()):
                if p.is_file() and p.suffix.lower() in _MODEL_EXTS:
                    png = p.with_suffix(".png")  # saved render thumbnail (same name, .png)
                    models.append({
                        "name": p.stem, "file": p.name, "ext": p.suffix.lower(),
                        "thumb": png.name if png.is_file() else None,
                    })
        return web.json_response({"models": models, "dir": str(_MODEL_LIB_DIR)})

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/save-thumbnail")
    async def _vrm_scene_editor_save_thumbnail(request):
        """Save a rendered thumbnail next to its model as <name>.png for reuse."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        name = data.get("file", "")
        image = data.get("image", "")
        if not name or "/" in name or "\\" in name:
            return web.json_response({"error": "invalid file name"}, status=400)
        if Path(name).suffix.lower() not in _MODEL_EXTS:
            return web.json_response({"error": "unsupported extension"}, status=400)
        if not isinstance(image, str) or not image:
            return web.json_response({"error": "missing image data"}, status=400)
        out = _MODEL_LIB_DIR / (Path(name).stem + ".png")
        try:
            out.resolve().relative_to(_MODEL_LIB_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        try:
            png_bytes = base64.b64decode(_DATA_URL_RE.sub("", image), validate=True)
        except (binascii.Error, ValueError):
            return web.json_response({"error": "image is not valid base64 PNG"}, status=400)
        try:
            out.write_bytes(png_bytes)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "thumb": out.name})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/thumbnail")
    async def _vrm_scene_editor_thumbnail(request):
        """Return the embedded thumbnail of one VRM in models/vrm (404 if none)."""
        name = request.rel_url.query.get("file", "")
        if not name or "/" in name or "\\" in name:
            return web.Response(status=400, text="invalid file name")
        if Path(name).suffix.lower() not in _MODEL_EXTS:
            return web.Response(status=400, text="unsupported extension")
        p = _MODEL_LIB_DIR / name
        try:
            p.resolve().relative_to(_MODEL_LIB_DIR.resolve())
        except ValueError:
            return web.Response(status=403, text="access denied")
        if not p.is_file():
            return web.Response(status=404, text="not found")
        thumb = _extract_vrm_thumbnail(p)
        if not thumb:
            return web.Response(status=404, text="no thumbnail")
        img_bytes, mime = thumb
        return web.Response(body=img_bytes, content_type=mime)

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/save-scene")
    async def _vrm_scene_editor_save_scene(request):
        """Save a scene as models/scene/<name>.json (+ <name>.png thumbnail)."""
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        name = (payload.get("name") or "").strip()
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return web.json_response({"error": "invalid scene name"}, status=400)
        data = payload.get("data")
        if not isinstance(data, dict):
            return web.json_response({"error": "missing scene data"}, status=400)
        _ensure_model_dirs()
        scene_dir = _MODELS_DIR / "scene"
        json_path = scene_dir / (name + ".json")
        try:
            json_path.resolve().relative_to(scene_dir.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        try:
            json_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            thumb = payload.get("thumbnail")
            if isinstance(thumb, str) and thumb:
                png = base64.b64decode(_DATA_URL_RE.sub("", thumb), validate=True)
                (scene_dir / (name + ".png")).write_bytes(png)
        except (OSError, binascii.Error, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "name": name})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/scenes")
    async def _vrm_scene_editor_scenes(_request):
        """List saved scenes in models/scene (<name>.json, optional <name>.png thumbnail)."""
        scenes = []
        if _SCENE_DIR.is_dir():
            for p in sorted(_SCENE_DIR.iterdir()):
                if p.is_file() and p.suffix.lower() == ".json":
                    png = p.with_suffix(".png")
                    scenes.append({
                        "name": p.stem, "file": p.name,
                        "thumb": png.name if png.is_file() else None,
                        "mtime": p.stat().st_mtime,
                    })
            scenes.sort(key=lambda s: s["mtime"], reverse=True)  # newest first
        return web.json_response({"scenes": scenes, "dir": str(_SCENE_DIR)})

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/delete-scene")
    async def _vrm_scene_editor_delete_scene(request):
        """Delete a saved scene (models/scene/<name>.json and its .png thumbnail)."""
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        name = (payload.get("file") or payload.get("name") or "").strip()
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return web.json_response({"error": "invalid scene name"}, status=400)
        stem = Path(name).stem  # accept "<name>" or "<name>.json"
        try:
            for suffix in (".json", ".png"):
                p = _SCENE_DIR / (stem + suffix)
                p.resolve().relative_to(_SCENE_DIR.resolve())
                if p.is_file():
                    p.unlink()
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "name": stem})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/scene")
    async def _vrm_scene_editor_scene(request):
        """Return one saved scene's JSON from models/scene (no path traversal)."""
        name = request.rel_url.query.get("file", "")
        if not name or "/" in name or "\\" in name:
            return web.json_response({"error": "invalid file name"}, status=400)
        if Path(name).suffix.lower() != ".json":
            return web.json_response({"error": "unsupported extension"}, status=400)
        p = _SCENE_DIR / name
        try:
            p.resolve().relative_to(_SCENE_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        if not p.is_file():
            return web.json_response({"error": "file not found"}, status=404)
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.Response(text=text, content_type="application/json")

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/poses")
    async def _vrm_scene_editor_poses(_request):
        """List pose files (*.vroidpose / *.json) in models/pose, with thumbnail name if present."""
        poses = []
        if _POSE_DIR.is_dir():
            for p in sorted(_POSE_DIR.iterdir()):
                if p.is_file() and p.suffix.lower() in _POSE_EXTS:
                    png = p.with_suffix(".png")  # saved pose thumbnail (same stem, .png)
                    poses.append({
                        "name": p.stem, "file": p.name, "ext": p.suffix.lower(),
                        "thumb": png.name if png.is_file() else None,
                    })
        return web.json_response({"poses": poses, "dir": str(_POSE_DIR)})

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/save-pose-thumbnail")
    async def _vrm_scene_editor_save_pose_thumbnail(request):
        """Save a rendered pose thumbnail next to its pose file as <name>.png."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        name = data.get("file", "")
        image = data.get("image", "")
        if not name or "/" in name or "\\" in name:
            return web.json_response({"error": "invalid file name"}, status=400)
        if Path(name).suffix.lower() not in _POSE_EXTS:
            return web.json_response({"error": "unsupported extension"}, status=400)
        if not isinstance(image, str) or not image:
            return web.json_response({"error": "missing image data"}, status=400)
        out = _POSE_DIR / (Path(name).stem + ".png")
        try:
            out.resolve().relative_to(_POSE_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        try:
            png_bytes = base64.b64decode(_DATA_URL_RE.sub("", image), validate=True)
            out.write_bytes(png_bytes)
        except (OSError, binascii.Error, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "thumb": out.name})

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/save-pose")
    async def _vrm_scene_editor_save_pose(request):
        """Save the current pose as models/pose/<name>.json (editor's generic format)."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        name = data.get("name", "")
        pose = data.get("pose")
        if not isinstance(pose, dict) or not isinstance(pose.get("bones"), dict):
            return web.json_response({"error": "missing pose data"}, status=400)
        stem = _UNSAFE_RE.sub("_", str(name)).strip("_") or "pose"
        out = _POSE_DIR / (stem + ".json")
        try:
            out.resolve().relative_to(_POSE_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        # 同名があれば連番を付けて上書きを防ぐ（pose -> pose-2 -> pose-3 ...）。
        if out.exists():
            n = 2
            while (_POSE_DIR / f"{stem}-{n}.json").exists():
                n += 1
            out = _POSE_DIR / f"{stem}-{n}.json"
        try:
            _POSE_DIR.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(pose, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "file": out.name})

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/delete-pose")
    async def _vrm_scene_editor_delete_pose(request):
        """Delete a pose file in models/pose (and its .png thumbnail)."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        name = (data.get("file") or "").strip()
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return web.json_response({"error": "invalid file name"}, status=400)
        if Path(name).suffix.lower() not in _POSE_EXTS:
            return web.json_response({"error": "unsupported extension"}, status=400)
        stem = Path(name).stem
        try:
            for path in (_POSE_DIR / name, _POSE_DIR / (stem + ".png")):
                path.resolve().relative_to(_POSE_DIR.resolve())
                if path.is_file():
                    path.unlink()
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "name": stem})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/pose")
    async def _vrm_scene_editor_pose(request):
        """Return the raw text of one pose file in pose/ (no path traversal)."""
        name = request.rel_url.query.get("file", "")
        if not name or "/" in name or "\\" in name:
            return web.json_response({"error": "invalid file name"}, status=400)
        if Path(name).suffix.lower() not in _POSE_EXTS:
            return web.json_response({"error": "unsupported extension"}, status=400)
        p = _POSE_DIR / name
        try:
            p.resolve().relative_to(_POSE_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        if not p.is_file():
            return web.json_response({"error": "file not found"}, status=404)
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.Response(text=text, content_type="application/json")

    @instance.routes.post(VRM_SCENE_EDITOR_PATH + "/capture")
    async def _vrm_scene_editor_capture(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)

        image = data.get("image", "")
        if not isinstance(image, str) or not image:
            return web.json_response({"error": "missing image data"}, status=400)

        # Strip the data-URL prefix and decode the base64 PNG payload.
        b64 = _DATA_URL_RE.sub("", image)
        try:
            png_bytes = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            return web.json_response({"error": "image is not valid base64 PNG"}, status=400)

        camera = _safe_token(data.get("camera"), "camera1")
        image_type = _safe_token(data.get("type"), "image")

        # Camera angle at capture time (for VRMSceneCaptureAngle). Optional/back-compat.
        def _num(v, d=0.0):
            try:
                return float(v)
            except (TypeError, ValueError):
                return d
        angle = {"rotate": _num(data.get("rotate")), "vertical": _num(data.get("vertical")), "zoom": _num(data.get("zoom"))}

        folder_str = (data.get("folder") or "").strip()
        folder = Path(folder_str) if folder_str else _default_output_folder()
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return web.json_response(
                {"error": f"cannot create folder: {exc}"}, status=400
            )

        # Deterministic name per (camera, type); existing files are overwritten.
        out_path = folder / f"{camera}_{image_type}.png"
        try:
            out_path.write_bytes(png_bytes)
        except OSError as exc:
            return web.json_response({"error": f"cannot write file: {exc}"}, status=400)

        # Register the capture so the graph node can resolve it. The token changes
        # every capture so the node's IS_CHANGED re-runs on a fresh shot.
        token = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        preview = _write_temp_preview(camera, image_type, png_bytes)
        _REGISTRY.setdefault(camera, {})[image_type] = {
            "path": str(out_path),
            "token": token,
            "preview": preview,
            "angle": angle,
        }

        # Live push to the open ComfyUI graph: matching VRMSceneCapture nodes
        # update their preview immediately, no Queue needed (LoRA-Manager style).
        pushed = False
        try:
            instance.send_sync(
                "vrm_capture",
                {
                    "camera": camera,
                    "type": image_type,
                    "path": str(out_path),
                    "token": token,
                    "preview": preview,
                    "angle": angle,
                },
            )
            pushed = True
        except Exception as exc:  # pragma: no cover - push is best-effort
            print(f"{_LOG_PREFIX} send_sync('vrm_capture') failed: {exc}")

        print(
            f"{_LOG_PREFIX} capture {camera}/{image_type} -> {out_path} "
            f"(preview={'ok' if preview else 'none'}, pushed={pushed})"
        )

        return web.json_response(
            {"path": str(out_path), "camera": camera, "type": image_type, "token": token}
        )

    # Serve main.js, vendor/, utils/ as static files. Relative imports inside
    # the JS modules resolve correctly under this prefix.
    instance.routes.static(VRM_SCENE_EDITOR_ASSETS_PATH, str(_EDITOR_DIR))
    # Serve the user model library (models/) so the editor can load by URL.
    instance.routes.static(_MODELS_ASSETS_PATH, str(_MODELS_DIR))

    print(f"{_LOG_PREFIX} routes registered (page, capture, channels, poses, models) at {VRM_SCENE_EDITOR_PATH}")


_register_routes()


class VRMSceneCapture:
    """Resolve a capture by (camera, type), output it as IMAGE/MASK, preview it.

    The image is produced in the VRM Scene Editor (a separate page) and saved by
    the /capture route, which records its path in `_REGISTRY`. This node reads
    that registry in-process -- no HTTP round-trip -- so selecting a matching
    camera + type loads the freshest shot.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "camera": (CAMERAS, {"default": "camera1"}),
                "type": (CAPTURE_TYPES, {"default": "image"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "path")
    FUNCTION = "load"
    CATEGORY = "VRM Scene Editor"
    OUTPUT_NODE = True  # always run so the in-node preview refreshes

    @classmethod
    def _lookup(cls, camera, image_type):
        cam = _safe_token(camera, "camera1")
        typ = _safe_token(image_type, "image")
        return _REGISTRY.get(cam, {}).get(typ), cam, typ

    @classmethod
    def IS_CHANGED(cls, camera, type):
        entry, _cam, _typ = cls._lookup(camera, type)
        # token changes per capture -> re-run; "none" is stable so an empty
        # camera/type doesn't force endless re-runs.
        return entry["token"] if entry else "none"

    def load(self, camera, type):
        import numpy as np
        import torch
        from PIL import Image, ImageOps

        entry, cam, typ = self._lookup(camera, type)
        path = entry.get("path") if entry else None
        # 切り替え先に撮影画像が無い -> エラーにせず空(黒)画像を返し、プレビューも空にする。
        if not entry or not path or not Path(path).is_file():
            empty = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return {"ui": {"images": []}, "result": (empty, "")}

        img = ImageOps.exif_transpose(Image.open(path))

        # Each type is an image (the 'mask' type's IMAGE *is* the silhouette).
        # No separate MASK output -- use a core "Image To Mask" node if needed.
        rgb = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
        image = torch.from_numpy(rgb)[None, ...]  # [1, H, W, 3]

        return {"ui": {"images": _preview(img)}, "result": (image, path)}


def _preview(pil_img):
    """Save a copy to ComfyUI's temp dir and return it as a node preview entry."""
    try:
        import folder_paths

        temp_dir = Path(folder_paths.get_temp_directory())
    except Exception:
        temp_dir = _EDITOR_DIR.parent / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    name = f"vrm_preview_{int(time.time() * 1000)}.png"
    pil_img.convert("RGBA").save(temp_dir / name, compress_level=4)
    return [{"filename": name, "subfolder": "", "type": "temp"}]


def _angle_to_prompt(rotate, vertical, zoom, add_angle_prompt=True):
    """Map camera rotate/vertical/zoom to easy multiAngle-style prompt words.

    Same vocabulary/thresholds as ComfyUI-Easy-Use's `easy multiAngle`, so the
    output plugs into the same angle-aware models (ANIMA / Qwen 等).
    """
    r = float(rotate) % 360.0
    if r < 22.5 or r >= 337.5: h = "front view"
    elif r < 67.5: h = "front-right view"
    elif r < 112.5: h = "right side view"
    elif r < 157.5: h = "back-right view"
    elif r < 202.5: h = "back view"
    elif r < 247.5: h = "back-left view"
    elif r < 292.5: h = "left side view"
    else: h = "front-left view"
    v = float(vertical)
    if v < -75: vd = "bottom-looking-up perspective, extreme worm's eye"
    elif v < -45: vd = "ultra-low angle"
    elif v < -15: vd = "low angle"
    elif v < 15: vd = "eye level"
    elif v < 45: vd = "high angle"
    elif v < 75: vd = "bird's eye view"
    else: vd = "top-down perspective, looking straight down"
    z = float(zoom)
    if z < 2: d = "extreme wide shot"
    elif z < 4: d = "wide shot"
    elif z < 6: d = "medium shot"
    elif z < 8: d = "close-up"
    else: d = "extreme close-up"
    if add_angle_prompt:
        return f"{h}, {vd}, {d} (horizontal: {int(round(r))}, vertical: {int(round(v))}, zoom: {z:.1f})"
    return f"{h}, {vd}, {d}"


class VRMSceneCaptureAngle:
    """VRM Scene Capture に、カメラアングルのスライダーを足したノード。

    撮影画像をプレビューしつつ、rotate/vertical/zoom から easy multiAngle と
    同じ語彙のプロンプト(STRING)と EASY_MULTI_ANGLE 互換の params を出力する。
    スライダーは撮影時にエディタのカメラ角度で自動セットされる(web拡張)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "camera": (CAMERAS, {"default": "camera1"}),
                "type": (CAPTURE_TYPES, {"default": "image"}),
                "rotate": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 360.0, "step": 1.0, "display": "slider"}),
                "vertical": ("FLOAT", {"default": 0.0, "min": -90.0, "max": 90.0, "step": 1.0, "display": "slider"}),
                "zoom": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 10.0, "step": 0.1, "display": "slider"}),
                "add_angle_prompt": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "EASY_MULTI_ANGLE")
    RETURN_NAMES = ("image", "path", "string", "params")
    FUNCTION = "load"
    CATEGORY = "VRM Scene Editor"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, camera, type, rotate, vertical, zoom, add_angle_prompt):
        entry, _c, _t = VRMSceneCapture._lookup(camera, type)
        tok = entry["token"] if entry else "none"
        return f"{tok}|{rotate}|{vertical}|{zoom}|{add_angle_prompt}"

    def load(self, camera, type, rotate, vertical, zoom, add_angle_prompt):
        import numpy as np
        import torch
        from PIL import Image, ImageOps

        prompt = _angle_to_prompt(rotate, vertical, zoom, add_angle_prompt)
        params = [{
            "rotate": int(round(float(rotate))), "vertical": int(round(float(vertical))),
            "zoom": float(zoom), "add_angle_prompt": bool(add_angle_prompt),
        }]

        entry, cam, typ = VRMSceneCapture._lookup(camera, type)
        path = entry.get("path") if entry else None
        if not entry or not path or not Path(path).is_file():
            empty = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return {"ui": {"images": []}, "result": (empty, "", prompt, params)}

        img = ImageOps.exif_transpose(Image.open(path))
        rgb = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
        image = torch.from_numpy(rgb)[None, ...]
        return {"ui": {"images": _preview(img)}, "result": (image, path, prompt, params)}


NODE_CLASS_MAPPINGS = {"VRMSceneCapture": VRMSceneCapture, "VRMSceneCaptureAngle": VRMSceneCaptureAngle}
NODE_DISPLAY_NAME_MAPPINGS = {"VRMSceneCapture": "VRM Scene Capture", "VRMSceneCaptureAngle": "VRM Scene Capture Angle"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print(f"{_LOG_PREFIX} loaded: node 'VRMSceneCapture' registered, types={CAPTURE_TYPES}")

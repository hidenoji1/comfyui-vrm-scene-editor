"""ComfyUI VRM Scene Editor (VRMシーンエディタ).

Adds a launch button next to the ComfyUI settings button (same place as LoRA
Manager). The button opens a standalone editor page that loads and displays a
VRM / GLB / GLTF model with three.js + @pixiv/three-vrm.

Routes:
  GET  /vrm-scene-editor          -> editor/index.html
  GET  /vrm-scene-editor-assets/* -> static files under editor/ (JS, vendor libs)
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
import re
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

# Bundled pose files (VRoid Studio *.vroidpose / *.json) the editor can load.
_POSE_DIR = Path(__file__).parent / "pose"
_POSE_EXTS = (".vroidpose", ".json")

# data:image/png;base64,.... prefix that browsers prepend to canvas.toDataURL().
_DATA_URL_RE = re.compile(r"^data:image/png;base64,", re.IGNORECASE)

# Filename-safe token: keep letters/digits/_/-, collapse everything else to "_".
_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_\-]+")

# Image types a camera can render. canny/openpose come later.
CAPTURE_TYPES = ["image", "mask", "mask(hands)", "depth", "normal", "openpose(body)", "openpose(hands)", "openpose(body+hands)"]

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

    @instance.routes.get(VRM_SCENE_EDITOR_PATH)
    async def _vrm_scene_editor_page(_request):
        if not _INDEX_HTML.exists():
            return web.Response(status=404, text="VRM Scene Editor index.html not found")
        return web.FileResponse(_INDEX_HTML)

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/default-folder")
    async def _vrm_scene_editor_default_folder(_request):
        return web.json_response({"folder": str(_default_output_folder())})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/channels")
    async def _vrm_scene_editor_channels(_request):
        channels = [
            {"camera": cam, "type": t, "path": entry["path"], "token": entry["token"]}
            for cam, types in _REGISTRY.items()
            for t, entry in types.items()
        ]
        return web.json_response({"channels": channels})

    @instance.routes.get(VRM_SCENE_EDITOR_PATH + "/poses")
    async def _vrm_scene_editor_poses(_request):
        """List the pose files (*.vroidpose / *.json) bundled in pose/."""
        poses = []
        if _POSE_DIR.is_dir():
            for p in sorted(_POSE_DIR.iterdir()):
                if p.is_file() and p.suffix.lower() in _POSE_EXTS:
                    poses.append({"name": p.stem, "file": p.name, "ext": p.suffix.lower()})
        return web.json_response({"poses": poses, "dir": str(_POSE_DIR)})

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

    print(f"{_LOG_PREFIX} routes registered (page, capture, channels, poses) at {VRM_SCENE_EDITOR_PATH}")


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
                "camera": ("STRING", {"default": "camera1"}),
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
        # No match -> NaN forces a re-run (and the clear error below) every time.
        return entry["token"] if entry else float("nan")

    def load(self, camera, type):
        import numpy as np
        import torch
        from PIL import Image, ImageOps

        entry, cam, typ = self._lookup(camera, type)
        if not entry:
            raise RuntimeError(
                f"VRM Scene Capture: no capture for camera='{cam}', type='{typ}'. "
                f"VRMシーンエディタで該当カメラ/タイプを撮影してください。"
            )

        path = entry["path"]
        if not Path(path).is_file():
            raise FileNotFoundError(f"VRM Scene Capture: file missing: {path}")

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


NODE_CLASS_MAPPINGS = {"VRMSceneCapture": VRMSceneCapture}
NODE_DISPLAY_NAME_MAPPINGS = {"VRMSceneCapture": "VRM Scene Capture"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print(f"{_LOG_PREFIX} loaded: node 'VRMSceneCapture' registered, types={CAPTURE_TYPES}")

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Live preview push for the VRM Scene Capture node (LoRA-Manager style).
// When the editor captures a frame, the backend fires a "vrm_capture" WebSocket
// event; here we find every VRMSceneCapture node whose camera + function match
// and refresh its in-node image immediately -- no Queue needed.

const NODE_CLASS = "VRMSceneCapture";

// Must mirror _safe_token() in __init__.py so editor-side and node-side keys match.
const safeToken = (value, fallback) =>
    ((value ?? "").toString().trim().replace(/[^A-Za-z0-9_\-]+/g, "_")) || fallback;

const widgetValue = (node, name) => node.widgets?.find((w) => w?.name === name)?.value;

function nodeMatches(node, camera, imageType) {
    if ((node.comfyClass || node.type) !== NODE_CLASS) return false;
    return (
        safeToken(widgetValue(node, "camera"), "camera1") === camera &&
        safeToken(widgetValue(node, "type"), "image") === imageType
    );
}

function previewUrl(preview, token) {
    // Append the token so the browser doesn't serve a stale cached copy
    // (the temp filename is reused per camera/function and overwritten).
    const params = new URLSearchParams({
        filename: preview.filename,
        subfolder: preview.subfolder || "",
        type: preview.type || "temp",
        t: token || "",
    });
    return api.apiURL(`/view?${params.toString()}`);
}

function applyPreview(node, url) {
    const img = new Image();
    img.onload = () => {
        node.imgs = [img];
        node.imageIndex = 0;
        if (typeof node.setSizeForImage === "function") node.setSizeForImage();
        app.graph?.setDirtyCanvas(true, true);
    };
    img.onerror = () => console.warn("[VRM Scene] preview failed to load:", url);
    img.src = url;
}

function clearPreview(node) {
    node.imgs = [];
    node.imageIndex = 0;
    app.graph?.setDirtyCanvas(true, true);
}

// On camera/type switch: pull the matching capture from the registry and refresh
// the node image immediately; if none exists, show empty (no error).
async function reloadNodePreview(node) {
    const camera = safeToken(widgetValue(node, "camera"), "camera1");
    const imageType = safeToken(widgetValue(node, "type"), "image");
    let data;
    try {
        const res = await api.fetchApi("/vrm-scene-editor/channels");
        data = await res.json();
    } catch (_) { return; }
    const ch = (data.channels ?? []).find((c) => c.camera === camera && c.type === imageType);
    if (ch && ch.preview) applyPreview(node, previewUrl(ch.preview, ch.token));
    else clearPreview(node); // 画像が無ければ空表示
}

app.registerExtension({
    name: "VrmSceneEditor.CaptureLive",
    // Reload the in-node preview whenever the camera/type dropdown changes.
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = origCreated?.apply(this, arguments);
            const node = this;
            for (const name of ["camera", "type"]) {
                const w = node.widgets?.find((x) => x?.name === name);
                if (!w) continue;
                const prev = w.callback;
                w.callback = function () {
                    const r = prev?.apply(this, arguments);
                    reloadNodePreview(node); // 切り替えたタイミングでリロード
                    return r;
                };
            }
            return ret;
        };
    },
    setup() {
        api.addEventListener("vrm_capture", (event) => {
            const detail = event?.detail ?? {};
            const { camera, type: imageType, preview, token } = detail;
            if (!camera || !imageType || !preview) return;

            const url = previewUrl(preview, token);
            const nodes = app.graph?._nodes ?? [];
            let updated = 0;
            for (const node of nodes) {
                if (nodeMatches(node, camera, imageType)) {
                    applyPreview(node, url);
                    updated++;
                }
            }
            if (updated === 0) {
                console.debug(`[VRM Scene] capture ${camera}/${imageType} received, no matching node`);
            }
        });
    },
});

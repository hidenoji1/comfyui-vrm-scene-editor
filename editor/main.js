// VRM Scene Editor -- standalone viewer (step 1: load & display a VRM).
// Relative imports resolve against this file's served location
// (/vrm-scene-editor-assets/), so vendor/ and utils/ must sit alongside it.
import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "./vendor/three-vrm.module.js";
import { TransformControls } from "./vendor/TransformControls.js";

// 外部VRMファイルの読み込みを許可するか。false にすると「VRM 読込」ボタン・
// ファイル選択・ドラッグ&ドロップをすべて無効化し、同梱サンプル専用になる。
// （起動時の同梱モデル読み込みは別経路なので影響しない。）
const ALLOW_FILE_LOAD = false;

const viewport = document.getElementById("viewport");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("vrm-input");
const loadBtn = document.getElementById("load-btn");
const resetBtn = document.getElementById("reset-btn");
const captureBtn = document.getElementById("capture-btn");
const captureFrame = document.getElementById("capture-frame");
const saveFolderInput = document.getElementById("save-folder");
const captureResSelect = document.getElementById("capture-res");
const transparentBgInput = document.getElementById("transparent-bg");
const previewCanvas = document.getElementById("preview-canvas");
const previewCtx = previewCanvas ? previewCanvas.getContext("2d") : null;

// Header status text was removed from the UI; keep setStatus as a safe no-op
// so existing callers (load/capture progress) don't throw. Toasts still surface
// the important messages.
const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

// ---- Toast notifications ----
// LoRA-Manager-style transient messages: slide in at top-right, auto-dismiss.
const toastContainer = document.getElementById("toast-container");

function showToast(message, type = "info", duration = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    // Next frame so the initial (hidden) state is painted before transitioning in.
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
        el.classList.remove("show");
        el.addEventListener("transitionend", () => el.remove(), { once: true });
    }, duration);
}

// ---- Renderer ----
// alpha:true lets us render a transparent-background capture; preserveDrawingBuffer
// keeps the buffer readable by toDataURL() after a render.
// antialias:false on purpose -- AA is the master "アンチエイリアス" toggle (SSAA via
// renderPost). Hardware MSAA here would always smooth edges and make the toggle moot.
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

// ---- Scene & camera ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2b2b);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(0, 1.3, 4);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.0, 0);
// Damping = camera inertia. Off for an immediate, snappy stop.
orbit.enableDamping = false;

// ---- Mouse sensitivity settings (persisted) ----
const SETTINGS_KEY = "vrmSceneEditor.controlSpeeds";
const DEFAULT_SPEEDS = { rotate: 1.0, zoom: 1.0, pan: 1.0 };

const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const settingsReset = document.getElementById("settings-reset");
const rollInput = document.getElementById("roll-angle");
const rollVal = document.getElementById("roll-val");
const sliders = {
    rotate: { input: document.getElementById("rotate-speed"), val: document.getElementById("rotate-val") },
    zoom: { input: document.getElementById("zoom-speed"), val: document.getElementById("zoom-val") },
    pan: { input: document.getElementById("pan-speed"), val: document.getElementById("pan-val") },
};

function loadSpeeds() {
    try {
        return { ...DEFAULT_SPEEDS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch {
        return { ...DEFAULT_SPEEDS };
    }
}

function applySpeeds(speeds, save = true) {
    orbit.rotateSpeed = speeds.rotate;
    orbit.zoomSpeed = speeds.zoom;
    orbit.panSpeed = speeds.pan;
    for (const key of Object.keys(sliders)) {
        sliders[key].input.value = String(speeds[key]);
        sliders[key].val.textContent = Number(speeds[key]).toFixed(1);
    }
    if (save) localStorage.setItem(SETTINGS_KEY, JSON.stringify(speeds));
}

function currentSpeeds() {
    return {
        rotate: parseFloat(sliders.rotate.input.value),
        zoom: parseFloat(sliders.zoom.input.value),
        pan: parseFloat(sliders.pan.input.value),
    };
}

for (const key of Object.keys(sliders)) {
    sliders[key].input.addEventListener("input", () => applySpeeds(currentSpeeds()));
}
settingsBtn.addEventListener("click", () => { settingsPanel.hidden = !settingsPanel.hidden; });
settingsReset.addEventListener("click", () => applySpeeds({ ...DEFAULT_SPEEDS }));

applySpeeds(loadSpeeds(), false);

// ---- Camera roll (banking) ----
// OrbitControls keeps the camera level (fixed up vector), so roll is applied
// separately: after each orbit.update() resets the orientation, we spin the
// camera around its own line of sight. Stored in radians.
let rollAngle = 0;

function setRoll(deg) {
    rollAngle = THREE.MathUtils.degToRad(deg);
    rollInput.value = String(deg);
    rollVal.textContent = `${Math.round(deg)}°`;
}

rollInput.addEventListener("input", () => setRoll(parseFloat(rollInput.value)));

// Arrow keys ←/→ nudge the roll (holding a key auto-repeats). Ignored while a
// form control is focused so typing a folder path / dragging the slider still
// behaves normally.
const ROLL_KEY_STEP = 3; // degrees per press
window.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    e.preventDefault();
    const deg = THREE.MathUtils.radToDeg(rollAngle);
    const step = e.key === "ArrowRight" ? ROLL_KEY_STEP : -ROLL_KEY_STEP;
    setRoll(THREE.MathUtils.clamp(deg + step, -180, 180));
});

// ---- Dynamic cursor reflecting the active camera operation ----
// Mirrors OrbitControls' default mapping: left = rotate, right = pan,
// middle = dolly/zoom, Ctrl/Shift/Meta + left = pan.
const canvasEl = renderer.domElement;
const IDLE_CURSOR = "grab";
canvasEl.style.cursor = IDLE_CURSOR;

// No standard CSS "rotate" cursor exists, so build a custom one: a circular
// arrow SVG embedded as a data URI (black halo + white fill = visible on any
// background). Hotspot at the 16,16 center; falls back to "grabbing".
const ROTATE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" ' +
    'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<g stroke="#000" stroke-width="4.5"><path d="M19 12a7 7 0 1 1-2.05-4.95"/>' +
    '<path d="M17 3.5v4.2h-4.2"/></g>' +
    '<g stroke="#fff" stroke-width="2"><path d="M19 12a7 7 0 1 1-2.05-4.95"/>' +
    '<path d="M17 3.5v4.2h-4.2"/></g></svg>';
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_SVG)}") 16 16, grabbing`;

// Custom 4-way pan cursor at the same 32px size/style as the rotate cursor,
// since the OS "move" cursor is small and can't be resized. Falls back to "move".
const PAN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" ' +
    'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<g stroke="#000" stroke-width="4.5"><path d="M12 4V20M4 12H20' +
    'M9 7L12 4L15 7M9 17L12 20L15 17M7 9L4 12L7 15M17 9L20 12L17 15"/></g>' +
    '<g stroke="#fff" stroke-width="2"><path d="M12 4V20M4 12H20' +
    'M9 7L12 4L15 7M9 17L12 20L15 17M7 9L4 12L7 15M17 9L20 12L17 15"/></g></svg>';
const PAN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PAN_SVG)}") 16 16, move`;

// Custom zoom/dolly cursor: a vertical double-headed arrow (drag up/down to
// dolly), same 32px size/style as the others. Falls back to "ns-resize".
const ZOOM_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" ' +
    'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<g stroke="#000" stroke-width="4.5"><path d="M12 4V20' +
    'M8 8L12 4L16 8M8 16L12 20L16 16"/></g>' +
    '<g stroke="#fff" stroke-width="2"><path d="M12 4V20' +
    'M8 8L12 4L16 8M8 16L12 20L16 16"/></g></svg>';
const ZOOM_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ZOOM_SVG)}") 16 16, ns-resize`;

function operationCursor(e) {
    if (e.button === 1) return ZOOM_CURSOR;              // middle drag -> zoom (dolly)
    if (e.button === 2) return PAN_CURSOR;               // right drag  -> pan
    if (e.button === 0) {                                // left drag
        return (e.ctrlKey || e.metaKey || e.shiftKey) ? PAN_CURSOR : ROTATE_CURSOR; // pan vs rotate
    }
    return IDLE_CURSOR;
}

canvasEl.addEventListener("pointerdown", (e) => { canvasEl.style.cursor = operationCursor(e); });
// Reset on release even if the pointer left the canvas.
window.addEventListener("pointerup", () => { canvasEl.style.cursor = IDLE_CURSOR; });

// ---- Lights (default / non-studio) ----
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
dirLight.position.set(2, 4, 3);
dirLight.castShadow = false; // no shadow receiver in default mode -> skip its (invisible) shadow map for perf
scene.add(dirLight);

// ---- Ground grid ----
const grid = new THREE.GridHelper(10, 20, 0x666666, 0x3c3c3c);
scene.add(grid);

// ---- Studio look preset (3-point lights + soft ground shadow + studio backdrop) ----
// Lighting affects the captured avatar; the backdrop + ground shadow are presentation-only
// and hidden during capture so transparent PNGs / depth・normal・mask passes stay clean.
const STUDIO_KEY = "vrmSceneEditor.studioLook";
const STUDIO_BRIGHT_KEY = "vrmSceneEditor.studioBright";
let studioLook = localStorage.getItem(STUDIO_KEY) !== "0"; // default on
let studioBright = parseFloat(localStorage.getItem(STUDIO_BRIGHT_KEY)); if (!isFinite(studioBright)) studioBright = 1.0;
const STUDIO_SHADOW_KEY = "vrmSceneEditor.studioShadow";
let studioShadow = localStorage.getItem(STUDIO_SHADOW_KEY) === "1"; // soft ground shadow = the heavy part; default OFF for perf
const STUDIO_INT = { key: 1.3, fill: 0.45, rim: 1.0, amb: 0.35 };

const keyLight = new THREE.DirectionalLight(0xffffff, STUDIO_INT.key);
keyLight.position.set(2.2, 3.2, 2.6);
keyLight.target.position.set(0, 1, 0);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 0.5; keyLight.shadow.camera.far = 12;
keyLight.shadow.camera.left = -2; keyLight.shadow.camera.right = 2;
keyLight.shadow.camera.top = 3; keyLight.shadow.camera.bottom = -0.3;
keyLight.shadow.bias = -0.0005; keyLight.shadow.radius = 4;
scene.add(keyLight); scene.add(keyLight.target);
const fillLight = new THREE.DirectionalLight(0xdfe8ff, STUDIO_INT.fill);
fillLight.position.set(-2.6, 1.6, 2.2);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, STUDIO_INT.rim);
rimLight.position.set(-1.2, 2.6, -2.6);
scene.add(rimLight);
const ambLight = new THREE.AmbientLight(0xffffff, STUDIO_INT.amb);
scene.add(ambLight);

const studioFloor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.28 }));
studioFloor.rotation.x = -Math.PI / 2;
studioFloor.receiveShadow = true;
scene.add(studioFloor);

const darkBG = new THREE.Color(0x2b2b2b);
let refImageActive = false; // true while a reference underlay image is shown (live bg goes transparent)
const STUDIO_BG_KEY = "vrmSceneEditor.studioBg";
let studioBgColor = new THREE.Color(0xd7dbe2);
try { const s = localStorage.getItem(STUDIO_BG_KEY); if (s) studioBgColor.set(s); } catch (_) {}
let studioBG = null;
// Build the backdrop as a gentle vertical gradient derived from the chosen base color
// (lighter at the top, slightly darker at the bottom) so it keeps a studio feel.
function buildStudioBG() {
    const top = studioBgColor.clone().lerp(new THREE.Color(0xffffff), 0.14);
    const bot = studioBgColor.clone().lerp(new THREE.Color(0x000000), 0.12);
    const cv = document.createElement("canvas"); cv.width = 4; cv.height = 512;
    const ctx = cv.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, "#" + top.getHexString()); g.addColorStop(0.55, "#" + studioBgColor.getHexString()); g.addColorStop(1, "#" + bot.getHexString());
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 512);
    if (studioBG) studioBG.dispose();
    studioBG = new THREE.CanvasTexture(cv); studioBG.colorSpace = THREE.SRGBColorSpace;
}
buildStudioBG();
function setStudioBgColor(hex) {
    studioBgColor.set(hex);
    localStorage.setItem(STUDIO_BG_KEY, "#" + studioBgColor.getHexString());
    buildStudioBG();
    if (studioLook) scene.background = studioBG;
}

function applyStudioLook(on) {
    hemiLight.visible = !on; dirLight.visible = !on;
    keyLight.visible = on; fillLight.visible = on; rimLight.visible = on; ambLight.visible = on;
    keyLight.intensity = STUDIO_INT.key * studioBright;
    fillLight.intensity = STUDIO_INT.fill * studioBright;
    rimLight.intensity = STUDIO_INT.rim * studioBright;
    ambLight.intensity = STUDIO_INT.amb * studioBright;
    keyLight.castShadow = studioShadow;          // off -> no shadow map rendered (big perf win)
    studioFloor.visible = on && studioShadow;
    grid.visible = !on;
    updateLiveBackground(); // respects 背景画像 mode (transparent live bg) vs studio/dark
}
// Live-view background: transparent while a reference image underlay is shown
// (so the DOM <img> behind the canvas is visible), otherwise studio or dark.
function updateLiveBackground() {
    if (refImageActive) { scene.background = null; renderer.setClearColor(0x000000, 0); }
    else scene.background = studioLook ? studioBG : darkBG;
}
applyStudioLook(studioLook);

const studioLookInput = document.getElementById("studio-look");
if (studioLookInput) {
    studioLookInput.checked = studioLook;
    studioLookInput.addEventListener("change", () => { studioLook = studioLookInput.checked; localStorage.setItem(STUDIO_KEY, studioLook ? "1" : "0"); applyStudioLook(studioLook); });
}
const studioBrightInput = document.getElementById("studio-bright");
const studioBrightVal = document.getElementById("studio-bright-val");
if (studioBrightInput) {
    studioBrightInput.value = String(studioBright);
    if (studioBrightVal) studioBrightVal.textContent = studioBright.toFixed(2);
    studioBrightInput.addEventListener("input", () => { studioBright = parseFloat(studioBrightInput.value) || 1; if (studioBrightVal) studioBrightVal.textContent = studioBright.toFixed(2); localStorage.setItem(STUDIO_BRIGHT_KEY, String(studioBright)); if (studioLook) applyStudioLook(true); });
}
const studioShadowInput = document.getElementById("studio-shadow");
if (studioShadowInput) {
    studioShadowInput.checked = studioShadow;
    studioShadowInput.addEventListener("change", () => { studioShadow = studioShadowInput.checked; localStorage.setItem(STUDIO_SHADOW_KEY, studioShadow ? "1" : "0"); applyStudioLook(studioLook); });
}

// ---- Loader ----
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

// Multi-model: every loaded model lives in loadedModels; currentVRM/currentModel/
// modelRoot/modelTilt always point at the ACTIVE (editable) one. Switching active
// rebuilds the (single) bone-control set for that model.
let loadedModels = []; // [{ id, vrm, model, root, tilt, name }]
let _modelIdSeq = 0;   // unique id per loaded model (for per-camera include lists)
let currentVRM = null;
let currentModel = null;
let modelRoot = null;      // wrapper Group (position + yaw); the root move/yaw rig transforms THIS
let modelTilt = null;      // inner Group (pitch/roll) inside modelRoot; the tilt rig transforms THIS
const clock = new THREE.Clock();

// ---- Pose editing: FK handles + Pole-Vector IK -------------------------------
// FK: a blue control sphere on each humanoid joint of the *normalized* rig
// (getNormalizedBoneNode -- world-aligned rest axes => intuitive rotation). Drag
// a sphere to rotate that one bone; vrm.update() (every frame) copies the
// normalized pose onto the raw bones / mesh that every capture reads.
// IK: Unity-style Two-Bone IK. A green *target* ball at each hand/foot + an
// orange *hint* (pole) ball at each elbow/knee. Drag a ball directly in the
// current view plane (up/down/left/right at the angle you're looking from) and
// the chain re-solves. Target = where the tip goes; hint = the bend direction;
// Hint Weight = how strongly the hint steers the bend. Drag-to-solve: the pose
// holds on release, and when idle the balls snap back onto the limb (world-
// anchored "always-on" IK is a later toggle). Everything runs on the normalized rig.

// FK handles for every humanoid joint EXCEPT the hand/foot tips (those are IK targets).
const FK_BONES = [
    "spine", "chest", "neck", "head",
    "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
    "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
    "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
    "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
    "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
    "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
    "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
    "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
    "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
    "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
    "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
    "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
    "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
];
// Densely-packed joints (fingers/toes/eyes) get a smaller handle.
const FK_SMALL_RE = /Thumb|Index|Middle|Ring|Little|Toes|Eye/;

// ---- 手のポーズ (hand pose): VRoid-Studio-style preset + weight per hand. ----
// 7 presets x 左/右, each blended from the rest pose by a 0..1 weight (slerp).
// We STAMP the finger bones on change only (NOT every frame), so the existing
// per-finger FK rotation rings still work on top -- pick a base hand shape with a
// preset, then refine individual fingers with the rings. Re-stamped only when the
// preset/weight changes for that hand (matches VRoid; rings survive between stamps).
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"]; // preset.fingers order
const THUMB_JOINTS = ["Metacarpal", "Proximal", "Distal"];
const FINGER_JOINTS = ["Proximal", "Intermediate", "Distal"];
// Each preset: per-finger { curl:[base,mid,tip] flexion°, splay:° } in the order
// [Thumb, Index, Middle, Ring, Little]. curl = fold toward the palm; splay =
// abduction (fan apart) about the palm normal, applied at the base joint only.
// Values DERIVED FROM VRoid Studio's own hand-pose AnimationClips (L_Hand_Grip/
// Open/Open_Index/Open_V/Gao/Good, extracted from VRoidStudio data.unity3d as
// Mecanim humanoid muscle values). Each non-"natural" pose = the natural rest +
// VRoid's exact per-finger muscle delta from L_Hand_Natural, scaled to degrees
// (muscle-delta x 45 -> curl, x 15 -> splay). So the relative per-finger shape is
// VRoid-faithful; only the global muscle->degree scale was calibrated visually.
const HAND_PRESETS = {
    natural: { fingers: [ // VRoid natural (rest baseline)
        { curl: [8, 6, 4], splay: 0 },     // Thumb
        { curl: [10, 12, 8], splay: 2 },   // Index
        { curl: [10, 14, 10], splay: 0 },  // Middle
        { curl: [12, 16, 10], splay: -2 }, // Ring
        { curl: [14, 18, 12], splay: -5 }  // Little
    ] },
    fist: { fingers: [ // VRoid Grip (グー)
        { curl: [34, 17, 102], splay: -7 }, // Thumb
        { curl: [61, 91, 98], splay: -5 },  // Index
        { curl: [53, 83, 102], splay: -5 }, // Middle
        { curl: [49, 72, 91], splay: -5 },  // Ring
        { curl: [46, 64, 57], splay: -7 }   // Little
    ] },
    open: { fingers: [ // VRoid Open (パー)
        { curl: [-9, -11, 6], splay: 0 },   // Thumb
        { curl: [3, 10, -3], splay: 8 },    // Index
        { curl: [-9, 1, -5], splay: -7 },   // Middle
        { curl: [-10, -8, -4], splay: 25 }, // Ring
        { curl: [-10, -7, -32], splay: 12 } // Little
    ] },
    thumbsup: { fingers: [ // VRoid Good (いいね)
        { curl: [-35, -21, -20], splay: -3 }, // Thumb
        { curl: [52, 91, 98], splay: 7 },     // Index
        { curl: [41, 83, 92], splay: 11 },    // Middle
        { curl: [42, 72, 91], splay: -11 },   // Ring
        { curl: [45, 70, 56], splay: -10 }    // Little
    ] },
    peace: { fingers: [ // VRoid Open_V (Vサイン)
        { curl: [41, 28, 101], splay: -9 }, // Thumb
        { curl: [2, 9, -3], splay: 19 },    // Index
        { curl: [-9, 1, -5], splay: -7 },   // Middle
        { curl: [42, 72, 44], splay: -11 }, // Ring
        { curl: [45, 70, 6], splay: -10 }   // Little
    ] },
    claw: { fingers: [ // VRoid Gao (がおー)
        { curl: [-29, -33, 93], splay: 2 },  // Thumb
        { curl: [-19, 64, 47], splay: 12 },  // Index
        { curl: [-40, 63, 47], splay: -9 },  // Middle
        { curl: [-37, 52, 68], splay: 39 },  // Ring
        { curl: [-33, 50, 37], splay: 24 }   // Little
    ] },
    point: { fingers: [ // VRoid Open_Index (指差し)
        { curl: [34, 17, 102], splay: -7 }, // Thumb
        { curl: [-8, 3, -8], splay: 8 },    // Index
        { curl: [53, 83, 102], splay: -5 }, // Middle
        { curl: [49, 72, 91], splay: -5 },  // Ring
        { curl: [46, 64, 57], splay: -7 }   // Little
    ] },
};
const HAND_PRESET_ORDER = ["natural", "fist", "open", "thumbsup", "peace", "claw", "point"];
const HAND_PRESET_LABELS = { natural: "自然", fist: "拳", open: "開く", thumbsup: "いいね", peace: "Vサイン", claw: "がおー", point: "指差し" };
const clamp01 = (v) => Math.max(0, Math.min(1, isFinite(v) ? v : 1));
const FINGER_GRIP_CURL_THRESHOLD = 30;
const FINGER_GRIP_MAX_CURL = 125;
const FINGER_GRIP_MID_BOOST = 1.08;
const FINGER_GRIP_TIP_BOOST = 1.28;
// scratch quats for applyHandPose (avoid per-call allocation)
const _hpOffset = new THREE.Quaternion(), _hpCurl = new THREE.Quaternion(), _hpTarget = new THREE.Quaternion();
const _hpThumbEuler = new THREE.Euler(0, 0, 0, "XYZ");
const HAND_POSE_KEY = "vrmSceneEditor.handPose";
function loadHandPoseState() {
    const mk = (s) => ({ preset: s && HAND_PRESETS[s.preset] ? s.preset : "natural", weight: s ? clamp01(s.weight) : 1 });
    try {
        const s = JSON.parse(localStorage.getItem(HAND_POSE_KEY));
        if (s) return { left: mk(s.left), right: mk(s.right) };
    } catch (_) {}
    return { left: mk(null), right: mk(null) };
}
let handPoseState = loadHandPoseState();
function saveHandPoseState() { localStorage.setItem(HAND_POSE_KEY, JSON.stringify(handPoseState)); }
// Captured "completed grip" poses: per side, per preset, a map boneName -> [x,y,z,w] (the full-grip
// local quaternion). When present, applyHandPose slerps rest->captured by weight instead of using the
// procedural curl. Authored by posing the hand with the FK handles, then pressing "握りを記憶".
const HAND_CAPTURE_KEY = "vrmSceneEditor.handCapture";
function loadCapturedHandPoses() {
    try { const s = JSON.parse(localStorage.getItem(HAND_CAPTURE_KEY)); if (s && s.left && s.right) return s; } catch (_) {}
    return { left: {}, right: {} };
}
let capturedHandPoses = loadCapturedHandPoses();
function saveCapturedHandPoses() { localStorage.setItem(HAND_CAPTURE_KEY, JSON.stringify(capturedHandPoses)); }
function gripCurlDeg(curlDeg, joint) {
    if (curlDeg <= FINGER_GRIP_CURL_THRESHOLD) return curlDeg;
    const boost = joint === 1 ? FINGER_GRIP_MID_BOOST : joint === 2 ? FINGER_GRIP_TIP_BOOST : 1;
    return Math.min(FINGER_GRIP_MAX_CURL, curlDeg * boost);
}
// [superseded] Old hardcoded-euler thumb fold. Kept for easy revert; applyHandPose now folds the
// thumb about a model-derived curlAxis (see setupHandPose / the thumbRef "wrap" axis). Unused.
function thumbPoseEulerDeg(side, spec, joint) {
    const sideSign = side === "left" ? -1 : 1;
    const curl = spec.curl || [0, 0, 0];
    const baseCurl = curl[0] || 0;
    const midCurl = curl[1] || 0;
    const tipCurl = curl[2] || 0;
    const close = clamp01(Math.max(baseCurl, 0) / 40);
    const open = clamp01(Math.max(-baseCurl, 0) / 25);
    const splay = spec.splay || 0;

    // VRM1 thumb chain maps to older VRM/Kalidokit-style thumb joints as:
    // Metacarpal = Proximal, Proximal = Intermediate, Distal = Distal.
    let e;
    if (joint === 0) {
        e = {
            x: 8 * close - 8 * open,
            y: sideSign * (46 * close - 28 * open + splay),
            z: sideSign * (14 * close + 8 * open),
        };
    } else if (joint === 1) {
        e = {
            x: 0.55 * midCurl + 10 * close,
            y: sideSign * (8 * close),
            z: sideSign * (0.18 * midCurl + 4 * close),
        };
    } else {
        e = {
            x: 0.42 * tipCurl + 8 * close,
            y: sideSign * (6 * close),
            z: sideSign * (0.16 * tipCurl + 3 * close),
        };
    }
    return e;
}
// Two-bone IK chains: tip (target) + the two bones to rotate. `key` ties each to
// its anchor checkbox; `label` is UI text. The "chest" chain is a spine IK
// (spine+chest bend to place upperChest) -- anchoring it keeps the upper body put
// while the hips move (waist S-curve). Array order = anchored-solve order: legs +
// spine (upstream) before arms (which hang off the chest).
const IK_CHAINS = [
    { key: "leftFoot",  label: "左足", tip: "leftFoot",   root: "leftUpperLeg",  mid: "leftLowerLeg"  },
    { key: "rightFoot", label: "右足", tip: "rightFoot",  root: "rightUpperLeg", mid: "rightLowerLeg" },
    { key: "chest",     label: "胸",   tip: "upperChest", root: "spine",         mid: "chest"         },
    { key: "leftHand",  label: "左手", tip: "leftHand",   root: "leftUpperArm",  mid: "leftLowerArm"  },
    { key: "rightHand", label: "右手", tip: "rightHand",  root: "rightUpperArm", mid: "rightLowerArm" },
];
const FK_COLOR = 0x33aaff;        // blue   = FK joint
const IK_TARGET_COLOR = 0x33dd88; // green  = IK target ring (un-anchored)
const IK_ANCHOR_COLOR = 0xff66bb; // pink   = IK target ring when anchored (pinned in world)
const IK_TARGET_FILL = 0xffffff;  // white  = IK target fill (grab body = whole circle)
const IK_HINT_COLOR = 0xff9a3c;   // orange = IK hint / pole (elbow/knee)
const HOVER_COLOR = 0xffd23f;     // yellow = hover
const R_FK = 0.018, R_FK_SMALL = 0.008, R_TARGET = 0.030, R_HINT = 0.02;
const DRAG_SENSITIVITY = 0.01;    // radians of FK rotation per pixel dragged
// VRoid-style: draw the hand/foot IK target offset out along the limb's extension
// (so it clears the fingertips/foot -- the wrist/ankle keeps its own blue FK
// rotation handle), with a guide line back to the joint. The solve compensates.
// Hand offset runs along the forearm (past the fingertips); foot along the knee->
// ankle (leg) line. Hands need more distance to clear the fingers.
const IK_HAND_OFFSET = 0.22;      // m the hand target floats past the wrist (clears fingers)
const IK_FOOT_OFFSET = 0.18;      // m the foot target floats past the ankle (down the leg line)

// Hip (pelvis = body root) controls: 1 position ball (translate the pelvis) + 2
// twist balls (a left/right "handlebar" that rotates the pelvis). These replace
// the hips FK handle.
const HIP_POS_COLOR = 0xcc55ff;   // magenta = move the pelvis
const HIP_TWIST_COLOR = 0xff5566; // red L/R pair = twist the pelvis
const HIP_ROTATE_COLOR = 0xa64dff; // purple = pelvis ball while in rotate mode (green = move)
const R_HIP_POS = 0.03, R_HIP_TWIST = 0.022;
const HIP_TWIST_DIST = 0.18;      // how far the twist balls sit to each side (m)

// Shoulder (clavicle) controls: 1 cyan ball just outboard of each shoulder joint.
// Dragging it aim-rotates the clavicle (shrug up/down, forward/back); the whole
// arm follows. The inner blue FK shoulder handle is KEPT (user's call) for fine work.
const SHOULDER_CHAINS = [
    { bone: "leftShoulder", child: "leftUpperArm" },
    { bone: "rightShoulder", child: "rightUpperArm" },
];
const SHOULDER_COLOR = 0x19e0ff;   // cyan = shoulder aim
const R_SHOULDER = 0.022;
const SHOULDER_BALL_OFFSET = 0.06; // m beyond the shoulder joint along the clavicle axis

// Eye gaze: 1 white ball the eyes look at. It drives the VRM's built-in lookAt
// (vrm.lookAt.target = ball), so both eyes follow it. It holds its world position
// (NOT snapped to a bone) -- it's a gaze target you place.
const GAZE_COLOR = 0xffffff;  // white = look-at target
const R_GAZE = 0.02;
const GAZE_DIST = 0.4;        // default distance in front of the face (m)
// Eye-contact (toggled in 設定; persisted).
const CAMERA_GAZE_KEY = "vrmSceneEditor.cameraGaze";
let cameraGaze = localStorage.getItem(CAMERA_GAZE_KEY) === "1"; // eyes track the camera
const EYES_LINKED_KEY = "vrmSceneEditor.eyesLinked";
let eyesLinked = localStorage.getItem(EYES_LINKED_KEY) !== "0"; // ON(default)=both eyes share one ball; OFF=per-eye balls
const EYE_AIM_MAX = 0.7; // max per-eye deviation from face-front (rad) so unlinked eyes don't pop
// Expression slider range (設定; persisted). Default 0..1.2 so weights can over-drive (大げさ) past 1.
const EXPR_MIN_KEY = "vrmSceneEditor.exprMin";
const EXPR_MAX_KEY = "vrmSceneEditor.exprMax";
let exprMin = parseFloat(localStorage.getItem(EXPR_MIN_KEY)); if (!isFinite(exprMin)) exprMin = 0;
let exprMax = parseFloat(localStorage.getItem(EXPR_MAX_KEY)); if (!isFinite(exprMax)) exprMax = 1.2;

const BONE_EDIT_KEY = "vrmSceneEditor.boneEdit";
const HINT_WEIGHT_KEY = "vrmSceneEditor.hintWeight";
let boneEditEnabled = localStorage.getItem(BONE_EDIT_KEY) !== "0"; // default on
let hintWeight = parseFloat(localStorage.getItem(HINT_WEIGHT_KEY) ?? "1") || 1;

let boneHandles = [];      // FK: [{ mesh, bone, name, initialQuat }]
const lockedBones = new Set(); // locked FK bone nodes: not selectable, angle frozen (bone-tree checkbox)
let handPoseBones = { left: [], right: [] }; // hand pose: [{ node, finger, joint, restQuat, curlAxis, splayAxis, opposeAxis }]
let HANDPOSE_DEBUG = false; // [debug] log thumb geometry/curl to the browser console; set true to re-enable
let ikProxies = [];        // flat list of target+hint proxy meshes (ray/visibility)
let ikChains = [];         // [{ rootNode, midNode, tipNode, target(mesh), hint(mesh) }]
let hipCtrl = null;        // { node, pos, twistL, twistR, initialQuat, initialPos }
let hipMode = "move";      // pelvis ball mode (right-click to switch): "move" (drag=translate) | "rotate" (show the ring)
let shoulderCtrls = [];    // [{ boneNode, childNode, ball }]
let gazeCtrl = null;       // { ball, ballL, ballR, lEye, rEye, restL, restR, initialPos* } -- drives gaze
let gazePanelCheck = null, linkPanelCheck = null; // 目の動き section checkboxes (rebuilt each model)
let draggedHandle = null;  // FK bone being rotated
let hoveredMesh = null;    // currently highlighted handle/proxy mesh
let hoveredBaseColor = FK_COLOR;
let draggedProxy = null;   // IK target/hint ball being dragged in the view plane
let _dragPrevX = 0;
let _dragPrevY = 0;

// Scratch objects (reused; created once to avoid per-frame allocation).
const _qParent = new THREE.Quaternion();
const _qBone = new THREE.Quaternion();
const _ikR = new THREE.Vector3(), _ikM = new THREE.Vector3(), _ikE = new THREE.Vector3();
const _ikDir = new THREE.Vector3(), _ikCur = new THREE.Vector3(), _ikPole = new THREE.Vector3();
const _ikHp = new THREE.Vector3(), _ikElbow = new THREE.Vector3(), _ikTclamp = new THREE.Vector3();
const _ikM2 = new THREE.Vector3(), _ikE2 = new THREE.Vector3();
const _ikTmp1 = new THREE.Vector3(), _ikTmp2 = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const _dampQ = new THREE.Quaternion(); // partial (damped) rotation for the spine CCD
const _sR = new THREE.Vector3(), _sM = new THREE.Vector3(), _sT = new THREE.Vector3();
const _sDir = new THREE.Vector3(), _sPerp = new THREE.Vector3();
const _effTarget = new THREE.Vector3(); // IK target minus the visual offset
const _o1 = new THREE.Vector3(), _o2 = new THREE.Vector3(), _oDir = new THREE.Vector3();
const _pickList = [];
const _dragPlane = new THREE.Plane();   // camera-facing plane for view-space proxy drag
const _dragHit = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _hipWorld = new THREE.Vector3(), _hipX = new THREE.Vector3();
const _hipTmp = new THREE.Vector3(), _hipTmp2 = new THREE.Vector3();
const _hipQ = new THREE.Quaternion();

function makeHandleMesh(color, r, renderOrder) {
    const geo = new THREE.SphereGeometry(r, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    return mesh;
}

// A hollow ring (an outline ○) used for IK targets so they read as an outline circle
// rather than a solid ball. Billboarded each frame (snapProxies) to face the camera, so
// it always shows as a clean ○ and stays grabbable on the band from any angle.
function makeRingMesh(color, outer, renderOrder) {
    const geo = new THREE.RingGeometry(outer * 0.6, outer, 36);
    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    return mesh;
}

// IK target = a white fill disc (the grab body: the WHOLE circle is raycastable, and it
// draws the white interior) with the green ○ ring as a child on top (the visible frame).
// snapProxies billboards the disc -> the ring child inherits its position/rotation/scale.
function makeTargetMesh(ringColor, fillColor, outer, renderOrder) {
    const geo = new THREE.CircleGeometry(outer, 36);
    const mat = new THREE.MeshBasicMaterial({
        color: fillColor, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(geo, mat);
    disc.renderOrder = renderOrder;
    disc.frustumCulled = false;
    const ring = makeRingMesh(ringColor, outer, renderOrder + 1); // green frame, drawn on top
    disc.add(ring);
    disc.userData.ring = ring;
    return disc;
}

// A thin guide line (2 points) from an offset IK target back to its joint.
function makeGuideLine(color) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 998;
    line.frustumCulled = false;
    return line;
}

function clearBoneControls() {
    draggedProxy = null;
    deselectFK();
    for (const h of boneHandles) {
        if (h.mesh.parent) h.mesh.parent.remove(h.mesh);
        h.mesh.geometry.dispose();
        h.mesh.material.dispose();
    }
    for (const p of ikProxies) {
        scene.remove(p);
        p.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); // disc + ring child
    }
    for (const ch of ikChains) {
        if (ch.guide) { scene.remove(ch.guide); ch.guide.geometry.dispose(); ch.guide.material.dispose(); }
    }
    boneHandles = [];
    handPoseBones = { left: [], right: [] };
    ikProxies = [];
    ikChains = [];
    hipCtrl = null;
    shoulderCtrls = [];
    gazeCtrl = null;
    draggedHandle = null;
    hoveredMesh = null;
}

// Show/hide every editing aid (FK spheres + IK target/hint balls). Used to keep
// them out of captures/previews and to honour the "ボーン編集" toggle.
let _editVisible = true; // last setEditVisible() state (so the line-art normal pass can restore it)
let _gizmoPassthrough = false; // true while Alt is held: rotation rig hidden + non-interactive (pick-through)
function activeEntryVisible() { // the active model's 表示/非表示 state
    const e = loadedModels.find((x) => x.root === modelRoot);
    return !e || e.visible !== false;
}
const HAND_FOCUS_BONE_RE = /Thumb|Index|Middle|Ring|Little|Hand/;
function isHandFocusBone(name) { return !!name && handFocusSide && name.startsWith(handFocusSide) && HAND_FOCUS_BONE_RE.test(name); }
function setEditVisible(v) {
    _editVisible = v;
    const show = v && activeEntryVisible(); // hide aids when the active model is hidden
    if (handFocusActive) {
        // ハンドフォーカス中: フォーカスした手の指/手首の制御点のみ。IK/アンカー球・ガイド・ギズモは隠す。
        for (const h of boneHandles) h.mesh.visible = show && isHandFocusBone(h.name) && !lockedBones.has(h.bone);
        for (const p of ikProxies) p.visible = false;
        for (const ch of ikChains) if (ch.guide) ch.guide.visible = false;
        updateGazeVisibility(false);
        fkGizmo.visible = show && !!selectedFK && !_gizmoPassthrough;
        if (moveGizmo.object) moveGizmo.visible = false;
        return;
    }
    for (const h of boneHandles) h.mesh.visible = show && !lockedBones.has(h.bone); // locked bones: control point hidden
    for (const p of ikProxies) p.visible = show;
    for (const ch of ikChains) if (ch.guide) ch.guide.visible = show;
    updateGazeVisibility(show); // center ball (linked) or per-eye balls (unlinked); hidden under camera-gaze
    fkGizmo.visible = show && !!selectedFK && !_gizmoPassthrough;
    if (moveGizmo.object) moveGizmo.visible = show;
}

// Build FK spheres (children of normalized bones -> follow the pose) + world-space
// IK target/hint proxies. depthTest/depthWrite off + high renderOrder draw them on
// top so occluded joints stay grabbable.
function setupBoneControls(vrm) {
    clearBoneControls();
    const humanoid = vrm?.humanoid;
    if (!humanoid) return;
    for (const name of FK_BONES) {
        const bone = humanoid.getNormalizedBoneNode(name);
        if (!bone) continue;
        const mesh = makeHandleMesh(FK_COLOR, FK_SMALL_RE.test(name) ? R_FK_SMALL : R_FK, 999);
        mesh.userData.kind = "fk";
        bone.add(mesh); // child of the normalized bone -> follows the pose
        boneHandles.push({ mesh, bone, name, initialQuat: bone.quaternion.clone() });
    }
    for (const c of IK_CHAINS) {
        const rootNode = humanoid.getNormalizedBoneNode(c.root);
        const midNode = humanoid.getNormalizedBoneNode(c.mid);
        const tipNode = humanoid.getNormalizedBoneNode(c.tip);
        if (!rootNode || !midNode || !tipNode) continue;
        const idx = ikChains.length;
        const target = makeTargetMesh(IK_TARGET_COLOR, IK_TARGET_FILL, R_TARGET, 1000);
        target.userData = { kind: "target", chainIndex: idx, baseColor: IK_TARGET_COLOR, ring: target.userData.ring };
        scene.add(target);
        ikProxies.push(target);
        // Every chain gets a Hint ball: limbs use it as the 2-bone IK pole; the chest's Hint is
        // the "belly" handle -- dragging it bends the whole spine (beginSpineBend/dragSpineBend).
        const hint = makeHandleMesh(IK_HINT_COLOR, R_HINT, 1000);
        hint.userData = { kind: "hint", chainIndex: idx, baseColor: IK_HINT_COLOR };
        scene.add(hint);
        ikProxies.push(hint);
        // Hand/foot targets float out along the limb's extension + get a guide line.
        // Both use mid->tip: hand = forearm (lowerArm->hand) past the fingers; foot =
        // leg line (lowerLeg->foot = knee->ankle) extended past the ankle.
        let offsetLen = 0, offA = null, offB = null, guide = null;
        if (c.key === "leftHand" || c.key === "rightHand") {
            offsetLen = IK_HAND_OFFSET; offA = midNode; offB = tipNode;
        } else if (c.key === "leftFoot" || c.key === "rightFoot") {
            offsetLen = IK_FOOT_OFFSET; offA = midNode; offB = tipNode;
        }
        if (offsetLen > 0) { guide = makeGuideLine(IK_TARGET_COLOR); scene.add(guide); }
        // Anatomical default bend side (where the hint/pole rests while the limb is
        // ~straight): arms = behind (-Z) so the elbow bends FORWARD; legs/chest =
        // front (+Z) so the knee bends forward (kneecap front).
        const hintRef = (c.key === "leftHand" || c.key === "rightHand")
            ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 0, 1);
        ikChains.push({ key: c.key, rootNode, midNode, tipNode, target, hint, anchored: false, offsetLen, offA, offB, offsetVec: new THREE.Vector3(), guide, hintRef });
    }
    const hipsNode = humanoid.getNormalizedBoneNode("hips");
    if (hipsNode) {
        // Same look as the IK targets (per the user): green ○ ring + white fill, billboarded,
        // whole-circle grab. baseColor = green so hover restores the RING to green.
        const pos = makeTargetMesh(IK_TARGET_COLOR, IK_TARGET_FILL, R_HIP_POS, 1000);
        const twistL = makeTargetMesh(IK_TARGET_COLOR, IK_TARGET_FILL, R_HIP_TWIST, 1000);
        const twistR = makeTargetMesh(IK_TARGET_COLOR, IK_TARGET_FILL, R_HIP_TWIST, 1000);
        pos.userData = { kind: "hipPos", baseColor: IK_TARGET_COLOR, ring: pos.userData.ring };
        twistL.userData = { kind: "hipTwist", side: -1, baseColor: IK_TARGET_COLOR, ring: twistL.userData.ring };
        twistR.userData = { kind: "hipTwist", side: 1, baseColor: IK_TARGET_COLOR, ring: twistR.userData.ring };
        scene.add(pos);
        scene.add(twistL);
        scene.add(twistR);
        ikProxies.push(pos, twistL, twistR);
        hipCtrl = { node: hipsNode, pos, twistL, twistR, initialQuat: hipsNode.quaternion.clone(), initialPos: hipsNode.position.clone() };
        hipMode = "move"; // a freshly loaded model starts in move mode (green ball, no ring)
    }
    for (const sc of SHOULDER_CHAINS) {
        const boneNode = humanoid.getNormalizedBoneNode(sc.bone);
        const childNode = humanoid.getNormalizedBoneNode(sc.child);
        if (!boneNode || !childNode) continue;
        const ball = makeTargetMesh(IK_TARGET_COLOR, IK_TARGET_FILL, R_SHOULDER, 1000); // green ○ + white fill, like IK
        ball.userData = { kind: "shoulder", shoulderIndex: shoulderCtrls.length, baseColor: IK_TARGET_COLOR, ring: ball.userData.ring };
        scene.add(ball);
        ikProxies.push(ball);
        shoulderCtrls.push({ boneNode, childNode, ball });
    }
    if (vrm.lookAt) {
        vrm.scene.updateMatrixWorld(true); // ensure head/lookAt world matrices are current
        vrm.humanoid.update();             // eyes at rest (no lookAt yet) -> capture their rest local quats
        const eyeC = vrm.lookAt.getLookAtWorldPosition(new THREE.Vector3());
        const fwd = vrm.lookAt.getLookAtWorldDirection(new THREE.Vector3()).normalize();
        // Center ball (左右連動 ON): both eyes follow it via the built-in vrm.lookAt.
        const ball = makeHandleMesh(GAZE_COLOR, R_GAZE, 1000);
        ball.userData = { kind: "gaze", baseColor: GAZE_COLOR };
        ball.position.copy(eyeC).addScaledVector(fwd, GAZE_DIST);
        scene.add(ball);
        ikProxies.push(ball);
        // Per-eye balls (左右連動 OFF): one in front of each eye bone, aimed manually each frame.
        const lEye = vrm.humanoid.getRawBoneNode("leftEye");
        const rEye = vrm.humanoid.getRawBoneNode("rightEye");
        let ballL = null, ballR = null, restL = null, restR = null;
        if (lEye && rEye) {
            ballL = makeHandleMesh(GAZE_COLOR, R_GAZE, 1000);
            ballL.userData = { kind: "gazeL", baseColor: GAZE_COLOR };
            ballL.position.copy(lEye.getWorldPosition(new THREE.Vector3())).addScaledVector(fwd, GAZE_DIST);
            ballR = makeHandleMesh(GAZE_COLOR, R_GAZE, 1000);
            ballR.userData = { kind: "gazeR", baseColor: GAZE_COLOR };
            ballR.position.copy(rEye.getWorldPosition(new THREE.Vector3())).addScaledVector(fwd, GAZE_DIST);
            scene.add(ballL); scene.add(ballR);
            ikProxies.push(ballL); ikProxies.push(ballR);
            restL = lEye.quaternion.clone(); restR = rEye.quaternion.clone(); // rest = face-front
        }
        vrm.lookAt.autoUpdate = true;
        gazeCtrl = {
            ball, ballL, ballR, lEye, rEye, restL, restR,
            initialPos: ball.position.clone(),
            initialPosL: ballL ? ballL.position.clone() : null,
            initialPosR: ballR ? ballR.position.clone() : null,
        };
        applyGazeTarget(); // honour カメラ目線 + 左右連動 (target/autoUpdate + ball visibility)
    }
    resetAnchorUI(); // new model -> all chains start un-anchored; sync the checkboxes
    snapProxies(true);
    setEditVisible(boneEditEnabled);
}

// Restore every editable bone to its load-time (rest) rotation + the hips to its
// rest rotation AND position.
function resetPose() {
    for (const h of boneHandles) h.bone.quaternion.copy(h.initialQuat);
    if (hipCtrl) {
        hipCtrl.node.quaternion.copy(hipCtrl.initialQuat);
        hipCtrl.node.position.copy(hipCtrl.initialPos);
    }
    if (gazeCtrl) { // eyes recenter -- restore all three gaze balls
        gazeCtrl.ball.position.copy(gazeCtrl.initialPos);
        if (gazeCtrl.ballL) gazeCtrl.ballL.position.copy(gazeCtrl.initialPosL);
        if (gazeCtrl.ballR) gazeCtrl.ballR.position.copy(gazeCtrl.initialPosR);
    }
    if (currentVRM) currentVRM.humanoid.update();
    applyCurrentHandPose(); // re-stamp the hand pose (the rest-restore straightened the fingers)
    snapProxies(true);
}

// Build the per-hand finger-bone table for hand-pose presets. For each finger
// joint we derive a CURL (flexion) axis from the rig itself: axis = childDir x
// palmNormal, where childDir = the next joint's local offset and palmNormal = -Y
// (palms-down VRM T-pose). This yields a correct, sign-consistent fold-toward-palm
// for BOTH hands AND the thumb (whose childDir is diagonal), with no hardcoded L/R
// signs. The normalized rig has identity rest rotations (local axes == world axes),
// so the cross product lands in each bone's local frame -> usable directly on
// bone.quaternion. Splay (abduction) rotates about the palm normal.
function setupHandPose(vrm) {
    handPoseBones = { left: [], right: [] };
    const humanoid = vrm?.humanoid;
    if (!humanoid) return;
    const palm = new THREE.Vector3(0, -1, 0); // palms-down at rest (VRM T-pose convention)
    // The little-finger (pinky) side is -Z for BOTH hands at rest. Fingers fold toward the palm
    // normal (-Y); the THUMB opposes them, folding down AND across (-Z) so it wraps over the
    // curled fingers. Same derivation (axis = childDir x ref) for every digit -> self-adapts to
    // the model's diagonal thumb rest geometry instead of relying on hardcoded per-model angles.
    const acrossPalm = new THREE.Vector3(0, 0, -1); // pinky side (both hands) -- the thumb's true flexion direction
    // KEY: the thumb's nail is rolled ~90 deg vs the 4 fingers, so its flexion plane is rotated.
    // It must fold ACROSS the palm (toward -Z), NOT down toward the palm normal (-Y) like the fingers --
    // folding it toward -Y just droops it straight down, away from the fingers. THUMB_DOWN adds a small
    // downward bias so it also comes slightly over the curled fingers. (The 4 fingers still use palm = -Y.)
    const THUMB_DOWN = 0.45; // 0 = pure horizontal across-swing (opposition); higher = more over-the-top droop
    const thumbRef = new THREE.Vector3().copy(acrossPalm).addScaledVector(palm, THUMB_DOWN).normalize();
    for (const side of ["left", "right"]) {
        const fingerCurlFallback = new THREE.Vector3(0, 0, side === "left" ? -1 : 1); // 4-finger axis ∓Z
        for (let fi = 0; fi < FINGERS.length; fi++) {
            const isThumb = FINGERS[fi] === "Thumb";
            const ref = isThumb ? thumbRef : palm; // thumb wraps across+down; the 4 fingers fold down
            const fallbackAxis = fingerCurlFallback;
            const joints = isThumb ? THUMB_JOINTS : FINGER_JOINTS;
            const nodes = joints.map((j) => humanoid.getNormalizedBoneNode(side + FINGERS[fi] + j));
            if (isThumb && HANDPOSE_DEBUG) console.log(`[handpose] ${side} thumb nodes: ` + joints.map((j, k) => `${j}=${nodes[k] ? "ok" : "NULL"}`).join(" "));
            let prevAxis = null;
            for (let ji = 0; ji < joints.length; ji++) {
                const node = nodes[ji];
                if (!node) { prevAxis = null; continue; }
                let axis;
                const nxt = nodes[ji + 1]; // the next joint is a direct child -> its .position = local offset
                if (nxt && nxt.position.lengthSq() > 1e-8) {
                    axis = new THREE.Vector3().crossVectors(nxt.position, ref);
                    if (axis.lengthSq() < 1e-8) axis.copy(fallbackAxis); else axis.normalize();
                } else if (prevAxis) {
                    axis = prevAxis.clone(); // distal: reuse the parent joint's (near-collinear) axis
                } else {
                    axis = fallbackAxis.clone();
                }
                prevAxis = axis;
                if (isThumb && HANDPOSE_DEBUG) {
                    const dd = (nxt && nxt.position) ? nxt.position.clone().normalize() : null;
                    console.log(`[handpose] ${side} thumb[${ji}] ${joints[ji]} childDir=` +
                        (dd ? `(${dd.x.toFixed(2)},${dd.y.toFixed(2)},${dd.z.toFixed(2)})` : "none(reused)") +
                        ` curlAxis=(${axis.x.toFixed(2)},${axis.y.toFixed(2)},${axis.z.toFixed(2)})`);
                }
                handPoseBones[side].push({
                    node, name: side + FINGERS[fi] + joints[ji], finger: fi, joint: ji, restQuat: node.quaternion.clone(),
                    curlAxis: axis, splayAxis: palm.clone(), isThumb, side,
                });
            }
        }
    }
}

// Stamp one hand: blend each finger bone from its rest to the preset pose by weight.
// Writes the normalized bones (then humanoid.update() pushes to raw/mesh/captures).
function applyHandPose(side, presetKey, weight) {
    const bones = handPoseBones[side];
    if (!bones || !bones.length) return;
    const preset = HAND_PRESETS[presetKey] || HAND_PRESETS.natural;
    const w = clamp01(weight);
    const cap = capturedHandPoses[side] && capturedHandPoses[side][presetKey]; // captured "completed grip" overrides the procedural curl
    for (const b of bones) {
        if (cap && cap[b.name]) {
            _hpTarget.set(cap[b.name][0], cap[b.name][1], cap[b.name][2], cap[b.name][3]);
            b.node.quaternion.copy(b.restQuat).slerp(_hpTarget, w); // interpolate rest -> captured pose by weight
            continue;
        }
        // The thumb is a normal preset-driven finger (its curl values come from VRoid's own
        // hand-pose data, like the other fingers). A captured pose still overrides via the branch
        // above; FK rings refine it after a preset is picked (re-stamped only on preset/weight change).
        const spec = preset.fingers[b.finger];
        if (!spec) { b.node.quaternion.copy(b.restQuat); continue; }
        const curlDeg = (spec.curl && spec.curl[b.joint]) || 0;
        const splayDeg = b.joint === 0 ? (spec.splay || 0) : 0; // splay only at the base joint
        _hpOffset.identity();
        // Every digit (thumb included) folds about its model-derived curlAxis. The thumb's axis
        // already encodes opposition (it wraps across+down), so it needs no hardcoded euler --
        // just its own per-joint curl degrees, without the 4-finger grip-boost.
        const flexDeg = b.isThumb ? curlDeg : gripCurlDeg(curlDeg, b.joint);
        if (splayDeg) _hpOffset.setFromAxisAngle(b.splayAxis, THREE.MathUtils.degToRad(splayDeg));
        _hpCurl.setFromAxisAngle(b.curlAxis, THREE.MathUtils.degToRad(flexDeg));
        _hpOffset.multiply(_hpCurl); // splay, then curl
        _hpTarget.copy(b.restQuat).multiply(_hpOffset);
        b.node.quaternion.copy(b.restQuat).slerp(_hpTarget, w);
    }
    if (currentVRM) currentVRM.humanoid.update();
}

// Apply both hands from the persisted state (model load + pose reset).
function applyCurrentHandPose() {
    applyHandPose("left", handPoseState.left.preset, handPoseState.left.weight);
    applyHandPose("right", handPoseState.right.preset, handPoseState.right.weight);
}

// Record the hand's CURRENT bone rotations as the 100%-grip target for (side, preset). After this,
// the weight slider interpolates rest->this captured pose -- no axis math, always correct for the model.
function captureHandPose(side, presetKey) {
    const bones = handPoseBones[side];
    if (!bones || !bones.length) return false;
    const store = {};
    for (const b of bones) { const q = b.node.quaternion; store[b.name] = [q.x, q.y, q.z, q.w]; }
    capturedHandPoses[side][presetKey] = store;
    saveCapturedHandPoses();
    return true;
}
function clearCapturedHandPose(side, presetKey) {
    if (capturedHandPoses[side] && capturedHandPoses[side][presetKey]) {
        delete capturedHandPoses[side][presetKey];
        saveCapturedHandPoses();
        return true;
    }
    return false;
}

// Drag the magenta ball -> translate the pelvis so its world position = `hit`.
function dragHipPosition(hit) {
    const hips = hipCtrl.node;
    hips.parent.updateWorldMatrix(true, false);
    hips.position.copy(hips.parent.worldToLocal(_hipTmp.copy(hit)));
    hipCtrl.pos.position.copy(hit);
    if (currentVRM) currentVRM.humanoid.update();
}

// Drag a red ball -> rotate the pelvis so the grabbed handlebar end aims at `hit`.
function dragHipTwist(ball, hit) {
    const hips = hipCtrl.node;
    hips.getWorldPosition(_hipWorld);
    _hipTmp.copy(ball.position).sub(_hipWorld);
    _hipTmp2.copy(hit).sub(_hipWorld);
    if (_hipTmp.lengthSq() < 1e-9 || _hipTmp2.lengthSq() < 1e-9) return;
    _hipQ.setFromUnitVectors(_hipTmp.normalize(), _hipTmp2.normalize());
    applyWorldRotation(hips, _hipQ);
    if (currentVRM) currentVRM.humanoid.update();
    // Re-place the dragged ball on the (rotated) handlebar so it tracks the cursor.
    hips.getWorldPosition(_hipWorld);
    _hipX.setFromMatrixColumn(hips.matrixWorld, 0).normalize();
    ball.position.copy(_hipWorld).addScaledVector(_hipX, ball.userData.side * HIP_TWIST_DIST);
}

// Drag a cyan shoulder ball -> aim the clavicle (shoulder bone) at the cursor, so
// the shoulder shrugs up/down / moves forward-back and the whole arm follows.
function dragShoulder(ball, hit) {
    const sc = shoulderCtrls[ball.userData.shoulderIndex];
    if (!sc) return;
    sc.boneNode.getWorldPosition(_hipWorld); // clavicle origin = pivot
    _hipTmp.copy(ball.position).sub(_hipWorld);
    _hipTmp2.copy(hit).sub(_hipWorld);
    if (_hipTmp.lengthSq() < 1e-9 || _hipTmp2.lengthSq() < 1e-9) return;
    _hipQ.setFromUnitVectors(_hipTmp.normalize(), _hipTmp2.normalize());
    applyWorldRotation(sc.boneNode, _hipQ);
    if (currentVRM) currentVRM.humanoid.update();
    // Re-place the ball just beyond the (rotated) shoulder joint along the clavicle axis.
    sc.boneNode.getWorldPosition(_hipWorld);
    sc.childNode.getWorldPosition(_hipTmp);
    _hipX.copy(_hipTmp).sub(_hipWorld);
    const len = _hipX.length() || 1;
    ball.position.copy(_hipTmp).addScaledVector(_hipX.multiplyScalar(1 / len), SHOULDER_BALL_OFFSET);
}

// Reset the whole-model staging: position + yaw (modelRoot), pitch/roll + scale (modelTilt).
// Pose is independent and untouched.
function resetRoot() {
    if (modelRoot) { modelRoot.position.set(0, 0, 0); modelRoot.rotation.set(0, 0, 0); }
    if (modelTilt) { modelTilt.rotation.set(0, 0, 0); modelTilt.scale.set(1, 1, 1); }
    syncTransformPanel();
}

// Each idle frame: place the IK target on its tip joint, the IK hint out along the
// current bend direction, and the hip balls on the pelvis -- so every ball always
// sits at its joint. While a ball is being dragged we freeze only what must stay
// stable: an IK drag freezes that chain's own target+hint (so the solve has steady
// inputs); a hip drag freezes nothing else, so the IK balls follow the moving body.
// The dragged ball itself is always skipped (its position is set by the drag).
function snapProxies(force) {
    const active = (!force && draggedProxy) ? draggedProxy : null;
    const ak = active ? active.userData.kind : null;
    const frozenChain = (ak === "target" || ak === "hint") ? active.userData.chainIndex : -1;
    for (let i = 0; i < ikChains.length; i++) {
        const ch = ikChains[i];
        ch.tipNode.getWorldPosition(_sT); // joint pos -- needed for both the snap and the guide line
        if (!(i === frozenChain || (!force && ch.anchored))) { // anchored / dragged = stays fixed
            ch.rootNode.getWorldPosition(_sR);
            ch.midNode.getWorldPosition(_sM);
            // Offset the target ball out along the limb's extension (offA -> offB).
            if (ch.offsetLen > 0 && ch.offA && ch.offB) {
                ch.offA.getWorldPosition(_o1);
                ch.offB.getWorldPosition(_o2);
                _oDir.copy(_o2).sub(_o1);
                ch.offsetVec.copy(_oDir).multiplyScalar(ch.offsetLen / (_oDir.length() || 1));
            } else {
                ch.offsetVec.set(0, 0, 0);
            }
            ch.target.position.copy(_sT).add(ch.offsetVec);
            _sDir.copy(_sT).sub(_sR);
            const reach = _sDir.length() || 1;
            _sDir.multiplyScalar(1 / reach);
            // Hint (pole) side: track the current elbow/knee offset when it's clearly
            // bent; when ~straight (ambiguous) fall back to the anatomical default
            // (hintRef) so it sits behind the elbow / in front of the knee -- and the
            // same for left & right (fixes the front/back asymmetry seen from above).
            _sPerp.copy(_sM).sub(_sR);
            _sPerp.addScaledVector(_sDir, -_sPerp.dot(_sDir)); // current bend, perp to limb
            if (_sPerp.length() < 0.15 * reach) {
                _sPerp.copy(ch.hintRef).addScaledVector(_sDir, -ch.hintRef.dot(_sDir));
                if (_sPerp.lengthSq() < 1e-9) _sPerp.set(0, 1, 0).addScaledVector(_sDir, -_sDir.y);
            }
            _sPerp.normalize();
            const L1 = _sR.distanceTo(_sM), L2 = _sM.distanceTo(_sT);
            if (ch.hint) ch.hint.position.copy(_sM).addScaledVector(_sPerp, 0.5 * (L1 + L2));
        }
        if (ch.guide) { // line from the joint (_sT) to the offset target ball
            const gp = ch.guide.geometry.attributes.position;
            gp.setXYZ(0, _sT.x, _sT.y, _sT.z);
            gp.setXYZ(1, ch.target.position.x, ch.target.position.y, ch.target.position.z);
            gp.needsUpdate = true;
        }
        ch.target.quaternion.copy(camera.quaternion); // billboard the ring ○ to face the camera
    }
    if (hipCtrl) {
        hipCtrl.node.getWorldPosition(_hipWorld);
        _hipX.setFromMatrixColumn(hipCtrl.node.matrixWorld, 0).normalize(); // pelvis local X in world
        if (active !== hipCtrl.pos) hipCtrl.pos.position.copy(_hipWorld);
        if (active !== hipCtrl.twistR) hipCtrl.twistR.position.copy(_hipWorld).addScaledVector(_hipX, HIP_TWIST_DIST);
        if (active !== hipCtrl.twistL) hipCtrl.twistL.position.copy(_hipWorld).addScaledVector(_hipX, -HIP_TWIST_DIST);
        hipCtrl.pos.quaternion.copy(camera.quaternion); // billboard the ○ rings to face the camera
        hipCtrl.twistL.quaternion.copy(camera.quaternion);
        hipCtrl.twistR.quaternion.copy(camera.quaternion);
    }
    for (const sc of shoulderCtrls) {
        sc.ball.quaternion.copy(camera.quaternion); // billboard the ○ ring (also while dragging)
        if (active === sc.ball) continue;
        sc.boneNode.getWorldPosition(_sR);
        sc.childNode.getWorldPosition(_sT);
        _sDir.copy(_sT).sub(_sR);
        const len = _sDir.length() || 1;
        sc.ball.position.copy(_sT).addScaledVector(_sDir.multiplyScalar(1 / len), SHOULDER_BALL_OFFSET);
    }
}

// Solve every anchored chain so its tip stays pinned at its (fixed) target as the
// body/hips move -- e.g. anchored feet stay planted while the hip ball drops
// (squat), anchored chest holds while the waist shifts. Runs on the normalized rig
// before vrm.update() so one humanoid.update() propagates it all to the mesh.
function solveAnchoredChains() {
    for (const ch of ikChains) {
        if (ch.anchored) solveChain(ch);
    }
}

// Spine bend (chest chain): damped CCD spreads the bend across spine+chest for a smooth curve.
const SPINE_ITER = 8, SPINE_DAMP = 0.5;

// Solve one chain so its TIP (wrist/ankle/upperChest) lands at the target minus the
// visual offset. Limbs use 2-bone IK; the chest chain uses the multi-bone spine CCD below.
function solveChain(ch) {
    _effTarget.copy(ch.target.position).sub(ch.offsetVec);
    if (ch.key === "chest") { solveSpineCCD(ch, _effTarget); return; }
    solveTwoBoneIK(ch.rootNode, ch.midNode, ch.tipNode, _effTarget, ch.hint.position, hintWeight);
}

// Multi-bone spine bend (damped CCD): rotate chest + spine to bring the tip (upperChest)
// toward the target, but only a FRACTION per joint per iteration so the bend SPREADS across
// the spine -> a smooth VRoid-like arch/round/side-bend (no elbow-style single-joint V, and
// no 2-bone reach clamp so it bends far). The tip still reaches the target, so the chest IK
// anchor keeps holding the upper body.
function solveSpineCCD(ch, target) {
    const tip = ch.tipNode;                    // upperChest = end effector
    const joints = [ch.midNode, ch.rootNode];  // chest, then spine (tip -> base)
    for (let it = 0; it < SPINE_ITER; it++) {
        for (const j of joints) {
            j.getWorldPosition(_ikR);
            tip.getWorldPosition(_ikE);
            _ikTmp1.copy(_ikE).sub(_ikR);
            _ikTmp2.copy(target).sub(_ikR);
            if (_ikTmp1.lengthSq() < 1e-9 || _ikTmp2.lengthSq() < 1e-9) continue;
            _ikQ.setFromUnitVectors(_ikTmp1.normalize(), _ikTmp2.normalize());
            _dampQ.set(0, 0, 0, 1).slerp(_ikQ, SPINE_DAMP); // partial rotation -> distributes the bend
            applyWorldRotation(j, _dampQ);
        }
    }
}

// Spine bend handle = the chest "belly" Hint ball. Dragging it bends the WHOLE spine: the drag's
// forward/back component arches/rounds the back, the left/right component side-bends it, spread
// evenly across spine + chest + upperChest. Captured at grab time, so the bend is proportional to
// how far the ball is dragged from the grab point (drag it back to undo).
const SPINE_BEND_GAIN = 4.0; // total spine bend (rad) per metre the belly ball is dragged
const _spineP0 = new THREE.Vector3(), _spineF = new THREE.Vector3(), _spineR = new THREE.Vector3();
let _spineRot0 = [];
function spineBones(ch) { return [ch.rootNode, ch.midNode, ch.tipNode]; } // spine, chest, upperChest
function beginSpineBend(ch) {
    const base = hipCtrl ? hipCtrl.node : ch.rootNode; // body frame from the hips (stable during the drag)
    base.updateWorldMatrix(true, false);
    _spineR.setFromMatrixColumn(base.matrixWorld, 0).normalize(); // body right
    _spineF.setFromMatrixColumn(base.matrixWorld, 2).normalize(); // body forward
    _spineP0.copy(ch.hint.position);
    _spineRot0 = spineBones(ch).map((b) => ({ x: b.rotation.x, z: b.rotation.z }));
}
function dragSpineBend(ch, hit) {
    _ikTmp1.copy(hit).sub(_spineP0);     // how far the belly ball has moved from the grab point
    const fwd = _ikTmp1.dot(_spineF);    // ball pulled forward(+) -> arch back; back(-) -> round
    const side = _ikTmp1.dot(_spineR);   // left/right -> side bend
    const bones = spineBones(ch);
    const archPer = (-fwd * SPINE_BEND_GAIN) / bones.length; // forward pull = extend (arch), not flex
    const sidePer = (side * SPINE_BEND_GAIN) / bones.length;
    for (let i = 0; i < bones.length; i++) {
        bones[i].rotation.x = _spineRot0[i].x + archPer; // pitch each spine bone (even arc)
        bones[i].rotation.z = _spineRot0[i].z + sidePer; // roll each spine bone (side bend)
    }
    if (currentVRM) currentVRM.humanoid.update();
    ch.hint.position.copy(hit); // the belly ball follows the cursor
}

// Apply a world-space rotation about a bone's origin, converting it to the local
// rotation the bone actually stores (so the parents' current pose is respected):
// new_local = parentWorld^-1 * qWorld * boneWorld.
function applyWorldRotation(bone, qWorld) {
    bone.parent.getWorldQuaternion(_qParent);
    bone.getWorldQuaternion(_qBone);
    bone.quaternion.copy(_qParent.invert().multiply(qWorld).multiply(_qBone));
}

// Unity-style two-bone IK with a pole/hint (world space). Finds the elbow/knee in
// the plane through (root, target, hint) via the law of cosines, then rotates root
// so mid lands on that elbow and mid so tip lands on the target. `weight` blends
// the bend direction between the current plane (0) and the hint (1). Runs on the
// normalized rig; vrm.update() pushes the result onto the raw bones / mesh.
function solveTwoBoneIK(root, mid, tip, target, hint, weight) {
    if (!root || !mid || !tip) return;
    root.getWorldPosition(_ikR);
    mid.getWorldPosition(_ikM);
    tip.getWorldPosition(_ikE);
    const L1 = _ikM.distanceTo(_ikR);
    const L2 = _ikE.distanceTo(_ikM);
    if (L1 < 1e-5 || L2 < 1e-5) return;

    _ikDir.copy(target).sub(_ikR);             // root -> target
    let d = _ikDir.length();
    if (d < 1e-5) return;
    _ikDir.multiplyScalar(1 / d);
    d = THREE.MathUtils.clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);

    // Bend direction = current elbow offset (perp to dir), blended toward the
    // hint's perpendicular offset by `weight`.
    _ikCur.copy(_ikM).sub(_ikR);
    _ikCur.addScaledVector(_ikDir, -_ikCur.dot(_ikDir));
    if (_ikCur.lengthSq() < 1e-9) {
        _ikCur.set(0, 0, 1).addScaledVector(_ikDir, -_ikDir.z);
        if (_ikCur.lengthSq() < 1e-9) _ikCur.set(0, 1, 0).addScaledVector(_ikDir, -_ikDir.y);
    }
    _ikCur.normalize();
    _ikPole.copy(_ikCur);
    if (hint && weight > 0) {
        _ikHp.copy(hint).sub(_ikR);
        _ikHp.addScaledVector(_ikDir, -_ikHp.dot(_ikDir));
        if (_ikHp.lengthSq() > 1e-9) {
            _ikHp.normalize();
            _ikPole.lerp(_ikHp, weight);
            if (_ikPole.lengthSq() < 1e-9) _ikPole.copy(_ikHp);
            else _ikPole.normalize();
        }
    }

    // Elbow position (law of cosines) and the reachable target point.
    const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const a = Math.acos(cosA);
    _ikElbow.copy(_ikR).addScaledVector(_ikDir, L1 * Math.cos(a)).addScaledVector(_ikPole, L1 * Math.sin(a));
    _ikTclamp.copy(_ikR).addScaledVector(_ikDir, d);

    // Step 1: rotate root so mid -> elbow.
    _ikQ.setFromUnitVectors(_ikTmp1.copy(_ikM).sub(_ikR).normalize(), _ikTmp2.copy(_ikElbow).sub(_ikR).normalize());
    applyWorldRotation(root, _ikQ);

    // Step 2: rotate mid so tip -> target.
    mid.getWorldPosition(_ikM2);
    tip.getWorldPosition(_ikE2);
    _ikQ.setFromUnitVectors(_ikTmp1.copy(_ikE2).sub(_ikM2).normalize(), _ikTmp2.copy(_ikTclamp).sub(_ikM2).normalize());
    applyWorldRotation(mid, _ikQ);
}

// Tear down the active model's bone controls + gizmo (kept as a single set, shared
// by whichever model is active).
function disposeActiveControls() {
    clearBoneControls();
    moveGizmo.detach();
}

function clearAllModels() {
    disposeActiveControls();
    for (const e of loadedModels) {
        scene.remove(e.root);
        if (e.vrm) VRMUtils.deepDispose(e.vrm.scene);
        else e.model.traverse((o) => { o.geometry?.dispose?.(); });
    }
    loadedModels = [];
    currentVRM = null; currentModel = null; modelRoot = null; modelTilt = null;
}

// Make `entry` the active (editable) model: repoint the globals and rebuild the
// per-model editing aids (bone handles / IK / hips / gaze / expressions).
function activateModel(entry) {
    disposeActiveControls();
    currentVRM = entry.vrm;
    currentModel = entry.model;
    modelRoot = entry.root;
    modelTilt = entry.tilt;
    moveGizmo.attach(modelRoot);
    moveGizmo.visible = boneEditEnabled;
    if (currentVRM) {
        computeHeadFeatures(currentVRM);
        computeHandMaskAttr(currentVRM);
        setupBoneControls(currentVRM); // also resetAnchorUI + snapProxies + setEditVisible
        setupHandPose(currentVRM);
        applyCurrentHandPose();
    }
    buildExpressionPanel(currentVRM);
    syncTransformPanel();
    resetHistory();
    updateModelListUI();
    if (typeof buildBoneTree === "function") buildBoneTree(); // rebuild tree for the new active model (if open)
}

function removeModel(entry) {
    const i = loadedModels.indexOf(entry);
    if (i < 0) return;
    const wasActive = entry.root === modelRoot;
    scene.remove(entry.root);
    if (entry.vrm) VRMUtils.deepDispose(entry.vrm.scene);
    loadedModels.splice(i, 1);
    if (wasActive) {
        if (loadedModels.length) activateModel(loadedModels[Math.min(i, loadedModels.length - 1)]);
        else {
            disposeActiveControls();
            currentVRM = null; currentModel = null; modelRoot = null; modelTilt = null;
            buildExpressionPanel(null); syncTransformPanel(); updateModelListUI();
        }
    } else { updateModelListUI(); }
}

// Rebuild the 配置モデル list (click a row to make it active, × to remove).
function updateModelListUI() {
    if (typeof rebuildCameraModelChecks === "function") rebuildCameraModelChecks(); // refresh 含めるモデル
    updateSceneStatus();
    const list = document.getElementById("scene-model-list");
    if (!list) return;
    list.innerHTML = "";
    if (!loadedModels.length) {
        list.innerHTML = '<div class="sm-empty">モデルがありません</div>';
        return;
    }
    loadedModels.forEach((e) => {
        const row = document.createElement("div");
        row.className = "sm-row" + (e.root === modelRoot ? " active" : "");
        const vis = document.createElement("input"); // left: 表示/非表示
        vis.type = "checkbox"; vis.className = "sm-vis"; vis.checked = e.visible !== false; vis.title = "表示/非表示";
        vis.addEventListener("change", () => { e.visible = vis.checked; e.root.visible = vis.checked; setEditVisible(_editVisible); }); // hide/show aids with the model
        const nm = document.createElement("button");
        nm.type = "button"; nm.className = "sm-name"; nm.textContent = e.name; nm.title = e.name;
        nm.addEventListener("click", () => { if (e.root !== modelRoot) activateModel(e); });
        const del = document.createElement("button"); // right: 削除（確認ダイアログ）
        del.type = "button"; del.className = "sm-del"; del.textContent = "×"; del.title = "削除";
        del.addEventListener("click", (ev) => { ev.stopPropagation(); confirmDialog(`「${e.name}」を削除しますか？`, () => removeModel(e)); });
        row.append(vis, nm, del);
        list.appendChild(row);
    });
}

// Reusable confirm overlay (falls back to window.confirm if the modal is absent).
function confirmDialog(message, onConfirm) {
    const modal = document.getElementById("confirm-modal");
    const msgEl = document.getElementById("confirm-message");
    const ok = document.getElementById("confirm-ok");
    if (!modal || !ok) { if (window.confirm(message)) onConfirm(); return; }
    if (msgEl) msgEl.textContent = message;
    ok.onclick = () => { modal.hidden = true; ok.onclick = null; onConfirm(); };
    modal.hidden = false;
}
(function setupConfirm() {
    const modal = document.getElementById("confirm-modal");
    if (!modal) return;
    const ok = document.getElementById("confirm-ok");
    const close = () => { modal.hidden = true; if (ok) ok.onclick = null; };
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
})();

// Thin status bar at the bottom of the merged モデル/ボーン window.
function updateSceneStatus() {
    const el = document.getElementById("scene-status");
    if (!el) return;
    const active = loadedModels.find((e) => e.root === modelRoot);
    el.textContent = `配置 ${loadedModels.length}体 / 選択: ${active ? active.name : "—"}`;
}

// Center the model on x/z and drop its feet to y=0 (within its parent = modelRoot).
// Runs once at load while modelRoot is still identity, so the world box == local box.
function centerModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
}

// Frame the camera to fit the model (camera only -- does NOT move the model, so a
// user-staged root position/rotation survives a camera reset / window resize).
function frameCamera(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.4;
    orbit.target.set(0, size.y * 0.5, 0);
    camera.position.set(0, size.y * 0.55, dist);
    orbit.update();
}

// Load-time placement: center the model in its wrapper, then frame the camera.
function placeAndFrame(model) {
    centerModel(model);
    frameCamera(model);
}

// add=false -> replace all; add=true -> keep existing models and add this one.
// file: source filename in models/vrm (for scene save/restore), or null (sample).
function onModelLoaded(gltf, add, file) {
    if (!add) clearAllModels();

    const vrm = gltf.userData.vrm;
    let model;
    if (vrm) {
        VRMUtils.rotateVRM0(vrm); // VRM0 faces -Z; rotate to face +Z (toward the camera)
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        model = vrm.scene;
    } else {
        model = gltf.scene;
    }
    model.traverse((obj) => {
        if (obj.isMesh || obj.isSkinnedMesh) { obj.castShadow = true; obj.frustumCulled = false; }
    });

    // Wrap in root groups (modelRoot = move + yaw, modelTilt = pitch/roll + scale).
    const root = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.add(model);
    root.add(tilt);
    scene.add(root);
    centerModel(model); // center within tilt; root.position then stages it in the scene

    const meta = vrm?.meta;
    const name = meta?.name || meta?.title || `model${loadedModels.length + 1}`;
    const entry = { id: ++_modelIdSeq, vrm: vrm || null, model, root, tilt, name, file: file || null };
    root.position.x = loadedModels.length * 0.8; // offset added models so they don't overlap
    loadedModels.push(entry);
    if (loadedModels.length === 1) frameCamera(model); // only frame the first / replaced model
    activateModel(entry);

    setStatus(vrm ? `VRM 読込完了: ${name} (VRM${meta?.metaVersion ?? "?"})` : "GLTF 読込完了");
}

function loadFile(file) {
    if (!file) return;
    setStatus(`読込中: ${file.name} ...`);
    const url = URL.createObjectURL(file);
    loader.load(
        url,
        (gltf) => { URL.revokeObjectURL(url); onModelLoaded(gltf); },
        undefined,
        (err) => {
            URL.revokeObjectURL(url);
            console.error(err);
            setStatus(`読込エラー: ${err?.message || err}`);
        },
    );
}

// ---- UI wiring ----
// 外部VRMの読み込み: ALLOW_FILE_LOAD が false なら全経路を無効化（同梱モデル専用）。
const FILE_LOAD_DISABLED_MSG = "外部VRMの読み込みは無効です（同梱モデル専用）";
if (ALLOW_FILE_LOAD && loadBtn) {
    loadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => loadFile(e.target.files?.[0]));
} else if (loadBtn) {
    loadBtn.disabled = true;
    loadBtn.title = FILE_LOAD_DISABLED_MSG;
}
resetBtn.addEventListener("click", () => {
    setRoll(0);
    if (currentModel) frameCamera(currentModel); // camera only -- keep the user's root staging
    else {
        camera.position.set(0, 1.3, 4);
        orbit.target.set(0, 1.0, 0);
        orbit.update();
    }
});

// Drag & drop a .vrm/.glb/.gltf onto the viewport. preventDefault() always runs
// (so a dropped file never makes the browser navigate away); loading is gated.
viewport.addEventListener("dragover", (e) => { e.preventDefault(); });
viewport.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type && f.type.startsWith("image/")) { loadRefImage(f); return; } // 画像 -> 背景参照
    if (!ALLOW_FILE_LOAD) { setStatus(FILE_LOAD_DISABLED_MSG); return; }
    loadFile(f);
});

// ---- Editing interaction: FK drag + IK target/hint view-plane drag ----
// Click a blue FK sphere -> drag to rotate that bone. Click a green target /
// orange hint ball -> drag it in the current view plane (up/down/left/right at
// the angle you're looking from) and the IK chain re-solves to follow. Grabbing
// anything disables OrbitControls for the gesture; empty space orbits as usual.
const _boneRaycaster = new THREE.Raycaster();
const _boneMouse = new THREE.Vector2();

// Rotation rig: a 3-ring rotate gizmo shown on the selected FK joint (click a blue ball
// to select). three's TransformControls in rotate mode; it edits the bone's quaternion
// directly, which vrm.update() then pushes onto the mesh. Stock THIN rings + small size
// (the user asked for the ORIGINAL thin ring, not the later thick/slider version).
let selectedFK = null; // the FK boneHandle entry the gizmo is attached to
const fkGizmo = new TransformControls(camera, renderer.domElement);
fkGizmo.setMode("rotate");
fkGizmo.setSpace("world"); // world axes -> rings stay upright (not tilted by a posed bone)
fkGizmo.setSize(0.6);      // the original small size
fkGizmo.visible = false;
scene.add(fkGizmo);
fkGizmo.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; if (!e.value) commitHistory(); });

// XYZ move gizmo at the model origin (feet): three.js TransformControls in translate mode,
// world axes (X red / Y green / Z blue, matching the numeric panel). Attached to modelRoot on
// load -> dragging an axis moves the whole model; objectChange syncs the numeric transform panel.
const moveGizmo = new TransformControls(camera, renderer.domElement);
moveGizmo.setMode("translate");
moveGizmo.setSpace("world");
moveGizmo.setSize(0.8);
moveGizmo.visible = false;
scene.add(moveGizmo);
moveGizmo.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });
moveGizmo.addEventListener("objectChange", () => { syncTransformPanel(); });

function selectFK(entry) {
    selectedFK = entry;
    fkGizmo.attach(entry.bone);
    fkGizmo.visible = boneEditEnabled && !_gizmoPassthrough; // stay hidden while Alt held; shows on release
}
function deselectFK() {
    if (!selectedFK) return;
    selectedFK = null;
    fkGizmo.detach();
}

function setMeshColor(mesh, hex) {
    if (!mesh) return;
    // IK targets are a white fill disc + a green ring child: tint the RING (the colored
    // frame) so the white fill stays white. Everything else tints its own material.
    const m = (mesh.userData && mesh.userData.ring) ? mesh.userData.ring : mesh;
    m.material.color.setHex(hex);
}

// Raycast all FK spheres + visible IK proxies; hits come back sorted nearest-first.
function rayHits(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    _boneMouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _boneMouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    _boneRaycaster.setFromCamera(_boneMouse, camera);
    _pickList.length = 0;
    for (const h of boneHandles) if (!lockedBones.has(h.bone)) _pickList.push(h.mesh); // locked bones aren't pickable
    for (const p of ikProxies) if (p.visible) _pickList.push(p); // skip hidden proxies (e.g. gaze ball under camera-gaze)
    return _boneRaycaster.intersectObjects(_pickList, false);
}
function hitToResult(mesh) {
    const fk = boneHandles.find((h) => h.mesh === mesh);
    if (fk) return { kind: "fk", mesh, entry: fk, baseColor: FK_COLOR };
    return { kind: mesh.userData.kind, mesh, baseColor: mesh.userData.baseColor };
}
// Nearest control point under the cursor (used for the hover highlight).
function pickAny(clientX, clientY) {
    const hits = rayHits(clientX, clientY);
    return hits.length ? hitToResult(hits[0].object) : null;
}
// Click-to-cycle: a plain click takes the front-most control point. Alt+click
// steps one deeper into the overlapping stack, so an occluded one is reachable.
let _cycleX = -1, _cycleY = -1, _cycleKey = "", _cycleIdx = -1;
function pickCycle(clientX, clientY, alt) {
    const hits = rayHits(clientX, clientY);
    if (!hits.length) { _cycleKey = ""; _cycleIdx = -1; return null; }
    const key = hits.map((h) => h.object.uuid).join(","); // same overlapping stack?
    const samePlace = Math.hypot(clientX - _cycleX, clientY - _cycleY) < 8 && key === _cycleKey;
    if (!alt) _cycleIdx = 0;                              // plain click -> front-most
    else if (samePlace) _cycleIdx = (_cycleIdx + 1) % hits.length; // Alt+click again -> one deeper
    else _cycleIdx = hits.length > 1 ? 1 : 0;            // Alt+click at a new spot -> one behind the front
    _cycleX = clientX; _cycleY = clientY; _cycleKey = key;
    return hitToResult(hits[_cycleIdx].object);
}

// OrbitControls registers its pointerdown in its constructor (runs before this)
// and may enter ROTATE, but it re-reads orbit.enabled every pointermove -- so
// disabling it on a grab means the camera never moves during the drag.
canvasEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !boneEditEnabled || !currentVRM) return;
    if (fkGizmo.dragging || moveGizmo.dragging) return; // a gizmo drag is in progress
    if (!e.altKey && (fkGizmo.axis || moveGizmo.axis)) return; // hovering a gizmo handle -> let it take the click (Alt = pick behind)
    const hit = pickCycle(e.clientX, e.clientY, e.altKey); // Alt+click steps one deeper into overlaps
    if (!hit) return; // empty space -> orbit (keep the current FK selection/gizmo)
    // Hips in ROTATE mode (right-click menu): the pelvis ball isn't a drag target -- the
    // rotation ring does the (whole-body) rotation. Keep the ring on the hips and let the
    // ring / camera take the pointer (don't disable orbit or start a translate drag here).
    if (hit.kind === "hipPos" && hipMode === "rotate") {
        if (hipCtrl) selectFK({ bone: hipCtrl.node });
        return;
    }
    orbit.enabled = false;
    setMeshColor(hit.mesh, HOVER_COLOR);
    canvasEl.style.cursor = "grabbing";
    if (hit.kind === "fk") {
        selectFK(hit.entry);       // show the rotation ring on this joint
        draggedHandle = hit.entry; // quick free-drag rotation still available too
        _dragPrevX = e.clientX;
        _dragPrevY = e.clientY;
    } else {
        // IK target/hint, or the hips in MOVE mode: drag across a camera-facing plane through
        // its current spot, so it moves up/down/left/right in the current view.
        deselectFK();              // grabbing a position control hides the rotation ring
        draggedProxy = hit.mesh;
        camera.getWorldDirection(_camFwd);
        _dragPlane.setFromNormalAndCoplanarPoint(_camFwd, hit.mesh.position);
        if (hit.kind === "hint") { // the chest Hint is the spine "belly" bend handle
            const ch = ikChains[hit.mesh.userData.chainIndex];
            if (ch && ch.key === "chest") beginSpineBend(ch);
        }
    }
});

function endDrag() {
    if (!draggedHandle && !draggedProxy) return;
    if (draggedHandle) {
        setMeshColor(draggedHandle.mesh, draggedHandle.mesh === hoveredMesh ? HOVER_COLOR : FK_COLOR);
        draggedHandle = null;
    }
    if (draggedProxy) {
        setMeshColor(draggedProxy, draggedProxy === hoveredMesh ? HOVER_COLOR : draggedProxy.userData.baseColor);
        draggedProxy = null;
    }
    orbit.enabled = true;
    canvasEl.style.cursor = IDLE_CURSOR;
    commitHistory(); // a drag (FK rotate / IK / hip / spine / gaze) finished -> record it
}

window.addEventListener("pointermove", (e) => {
    if (draggedProxy) {
        if (e.buttons === 0) { endDrag(); return; } // missed pointerup -> recover
        // Move the ball across the camera-facing plane, then re-solve its chain.
        const rect = canvasEl.getBoundingClientRect();
        _boneMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _boneMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _boneRaycaster.setFromCamera(_boneMouse, camera);
        if (_boneRaycaster.ray.intersectPlane(_dragPlane, _dragHit)) {
            const kind = draggedProxy.userData.kind;
            if (kind === "target" || kind === "hint") {
                const ch = ikChains[draggedProxy.userData.chainIndex];
                if (kind === "hint" && ch && ch.key === "chest") {
                    dragSpineBend(ch, _dragHit); // belly ball -> bend the whole spine
                } else {
                    draggedProxy.position.copy(_dragHit);
                    if (ch) solveChain(ch);
                }
            } else if (kind === "hipPos") {
                dragHipPosition(_dragHit);
            } else if (kind === "hipTwist") {
                dragHipTwist(draggedProxy, _dragHit);
            } else if (kind === "shoulder") {
                dragShoulder(draggedProxy, _dragHit);
            } else if (kind === "gaze" || kind === "gazeL" || kind === "gazeR") {
                draggedProxy.position.copy(_dragHit); // center: via vrm.lookAt; L/R: via applyEyeAim
            }
        }
        return;
    }
    if (draggedHandle) {
        // Recover if the pointerup was missed (pointercancel, lost capture,
        // alt-tab mid-drag) -- otherwise the camera would stay stuck.
        if (e.buttons === 0) { endDrag(); return; }
        // FK: rotate the single grabbed bone by the mouse delta.
        const dx = e.clientX - _dragPrevX;
        const dy = e.clientY - _dragPrevY;
        _dragPrevX = e.clientX;
        _dragPrevY = e.clientY;
        const b = draggedHandle.bone;
        if (e.altKey) {
            b.rotation.z -= dy * DRAG_SENSITIVITY;
        } else {
            b.rotation.y += dx * DRAG_SENSITIVITY;
            b.rotation.x += dy * DRAG_SENSITIVITY;
        }
        return;
    }
    // Hover highlight -- only when idle (no button held) and in edit mode.
    if (e.buttons !== 0 || !boneEditEnabled || !currentVRM) return;
    const hit = pickAny(e.clientX, e.clientY);
    const m = hit ? hit.mesh : null;
    if (m === hoveredMesh) return;
    if (hoveredMesh) setMeshColor(hoveredMesh, hoveredBaseColor);
    hoveredMesh = m;
    if (m) {
        hoveredBaseColor = hit.baseColor;
        setMeshColor(m, HOVER_COLOR);
        canvasEl.style.cursor = "pointer";
    } else {
        canvasEl.style.cursor = IDLE_CURSOR;
    }
});

window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

// Alt = "pick behind": while held, HIDE the rotation rig and suspend the gizmos' pointer
// handling, so a click reaches the control point that was behind the rig (see pickCycle).
function setGizmoPassthrough(on) {
    _gizmoPassthrough = on && boneEditEnabled;
    fkGizmo.enabled = moveGizmo.enabled = !_gizmoPassthrough;
    fkGizmo.visible = boneEditEnabled && !!selectedFK && !_gizmoPassthrough;
}
window.addEventListener("keydown", (e) => { if (e.key === "Alt") setGizmoPassthrough(true); });
window.addEventListener("keyup", (e) => { if (e.key === "Alt") setGizmoPassthrough(false); });
window.addEventListener("blur", () => setGizmoPassthrough(false)); // never get stuck disabled (e.g. Alt+Tab)

// Pose-edit mode toggle (show/hide + enable/disable the control points).
// Shared by the 設定 "ボーン編集" checkbox and the 操作モード panel (矢印 = OFF / ボーン = ON).
const boneToolButtons = []; // 操作モードパネルの .tl-btn (data-bone="off"/"on")
function setBoneEdit(on) {
    boneEditEnabled = on;
    localStorage.setItem(BONE_EDIT_KEY, on ? "1" : "0");
    if (!on) { endDrag(); deselectFK(); }
    setEditVisible(on); // control points / IK targets / move gizmo: show iff ON
    if (!on && hoveredMesh) { setMeshColor(hoveredMesh, hoveredBaseColor); hoveredMesh = null; }
    if (boneEditInput) boneEditInput.checked = on;
    for (const b of boneToolButtons) b.classList.toggle("active", (b.dataset.bone === "on") === on);
}
const boneEditInput = document.getElementById("bone-edit");
if (boneEditInput) {
    boneEditInput.checked = boneEditEnabled;
    boneEditInput.addEventListener("change", () => setBoneEdit(boneEditInput.checked));
}

const cameraGazeInput = document.getElementById("camera-gaze");
if (cameraGazeInput) {
    cameraGazeInput.checked = cameraGaze;
    cameraGazeInput.addEventListener("change", () => setCameraGaze(cameraGazeInput.checked)); // syncs 目の動き checkbox too
}

// Expression parameter range (下限/上限). Lets sliders over-drive past 1 for 大げさ表現 (default max 1.2).
const exprMinInput = document.getElementById("expr-min");
const exprMaxInput = document.getElementById("expr-max");
if (exprMinInput && exprMaxInput) {
    exprMinInput.value = String(exprMin);
    exprMaxInput.value = String(exprMax);
    const onExprRange = () => {
        let mn = parseFloat(exprMinInput.value); if (!isFinite(mn)) mn = 0;
        let mx = parseFloat(exprMaxInput.value); if (!isFinite(mx)) mx = 1.2;
        if (mx <= mn) mx = mn + 0.05; // keep a non-empty range
        exprMin = mn; exprMax = mx;
        exprMinInput.value = String(mn); exprMaxInput.value = String(mx);
        localStorage.setItem(EXPR_MIN_KEY, String(mn));
        localStorage.setItem(EXPR_MAX_KEY, String(mx));
        applyExprRange();
    };
    exprMinInput.addEventListener("change", onExprRange);
    exprMaxInput.addEventListener("change", onExprRange);
}

// ---- Floating expression panel (VRoid-style): accordion driven by the model's
// raw face blendshapes (Fcl_*), grouped 基本セット/眉/目/口/歯. Sliders write into
// faceMorphValues; the render loop re-applies them AFTER vrm.update() so they win
// over the VRM expression presets (which clear + re-accumulate morphs each frame). ----
const MORPH_GROUPS = [
    { title: "基本セット", key: "ALL" },
    { title: "眉", key: "BRW" },
    { title: "目", key: "EYE" },
    { title: "口", key: "MTH" }, // リップシンク(A/I/U/E/O)もここに含まれる
    { title: "歯", key: "HA" },
];
let faceMorphTargets = new Map();   // fullName -> [{ influences, index }] across every face mesh
const faceMorphValues = new Map();  // fullName -> current weight (may exceed 1 for 大げさ), re-applied each frame
let morphSliders = [];              // [{ full, slider, num }] -- so the range setting can update min/max live

const shortMorphName = (full) => full.split(".").pop(); // "Face_Blendshape.Fcl_ALL_Joy" -> "Fcl_ALL_Joy"

// VRoid-style 「目の動き」 section (top of the panel): カメラを見る + 左右連動 checkboxes.
function buildEyeMovementSection(body) {
    const section = document.createElement("div"); section.className = "ep-section";
    const header = document.createElement("button"); header.className = "ep-header";
    const content = document.createElement("div"); content.className = "ep-content"; // expanded by default
    const ttl = " 目の動き";
    header.textContent = "▾" + ttl;
    header.addEventListener("click", () => {
        content.hidden = !content.hidden;
        header.textContent = (content.hidden ? "▸" : "▾") + ttl;
    });
    const mkCheck = (checked, labelText, onChange) => {
        const row = document.createElement("label"); row.className = "ep-check";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked;
        cb.addEventListener("change", () => onChange(cb.checked));
        row.appendChild(cb); row.appendChild(document.createTextNode(" " + labelText));
        content.appendChild(row);
        return cb;
    };
    gazePanelCheck = mkCheck(cameraGaze, "カメラを見る", setCameraGaze);
    linkPanelCheck = mkCheck(eyesLinked, "左右連動（OFFで左右の目を個別に操作）", setEyesLinked);
    section.appendChild(header); section.appendChild(content);
    body.appendChild(section);
}

function buildExpressionPanel(vrm) {
    const body = document.getElementById("expr-body");
    if (!body) return;
    body.textContent = "";
    buildEyeMovementSection(body); // 目の動き at the very top, above 基本セット
    faceMorphTargets = new Map();
    faceMorphValues.clear();
    morphSliders = [];
    if (vrm && vrm.scene) {
        vrm.scene.traverse((o) => {
            if (!o.morphTargetDictionary || !o.morphTargetInfluences) return;
            for (const [name, idx] of Object.entries(o.morphTargetDictionary)) {
                if (!faceMorphTargets.has(name)) faceMorphTargets.set(name, []);
                faceMorphTargets.get(name).push({ influences: o.morphTargetInfluences, index: idx });
            }
        });
    }
    const allNames = [...faceMorphTargets.keys()];
    if (!allNames.length) {
        const d = document.createElement("div"); d.className = "ep-empty";
        d.textContent = "このモデルに表情モーフがありません";
        body.appendChild(d); return;
    }
    // Bucket each morph by its Fcl_<KEY>_ token; anything unrecognized -> その他.
    const used = new Set();
    const groups = MORPH_GROUPS.map((g) => ({
        title: g.title,
        names: allNames.filter((n) => shortMorphName(n).startsWith("Fcl_" + g.key + "_")),
    }));
    groups.forEach((g) => g.names.forEach((n) => used.add(n)));
    const others = allNames.filter((n) => !used.has(n));
    if (others.length) groups.push({ title: "その他", names: others });

    for (const g of groups) {
        if (!g.names.length) continue;
        const section = document.createElement("div"); section.className = "ep-section";
        const header = document.createElement("button"); header.className = "ep-header";
        const label0 = () => " " + g.title + " (" + g.names.length + ")";
        header.textContent = "▸" + label0();
        const content = document.createElement("div"); content.className = "ep-content"; content.hidden = true;
        header.addEventListener("click", () => {
            content.hidden = !content.hidden;
            header.textContent = (content.hidden ? "▸" : "▾") + label0();
        });
        for (const full of g.names.slice().sort()) {
            const init = clampExpr(0);
            faceMorphValues.set(full, init);
            const row = document.createElement("div"); row.className = "ep-row";
            const label = document.createElement("label");
            label.textContent = shortMorphName(full).replace(/^Fcl_[A-Za-z]+_/, ""); // -> "Joy", "Close_L", "A"
            label.title = shortMorphName(full);
            const slider = document.createElement("input");
            slider.type = "range"; slider.min = String(exprMin); slider.max = String(exprMax); slider.step = "0.05"; slider.value = String(init);
            const num = document.createElement("span"); num.className = "ep-num"; num.textContent = init.toFixed(2);
            slider.addEventListener("input", () => {
                const v = parseFloat(slider.value);
                faceMorphValues.set(full, v);
                num.textContent = v.toFixed(2);
            });
            row.appendChild(label); row.appendChild(slider); row.appendChild(num);
            morphSliders.push({ full, slider, num });
            content.appendChild(row);
        }
        section.appendChild(header); section.appendChild(content);
        body.appendChild(section);
    }
}

// Re-apply the panel's morph weights after vrm.update() so they override the
// preset/expression system (which clears + re-accumulates bound morphs each frame).
function applyFaceMorphs() {
    if (!faceMorphValues.size) return;
    for (const [name, v] of faceMorphValues) {
        const list = faceMorphTargets.get(name);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) list[i].influences[list[i].index] = v;
    }
}

// Clamp an expression weight to the configurable range (default 0..1.2; >1 over-drives the morph for 大げさ).
function clampExpr(v) { return Math.max(exprMin, Math.min(v, exprMax)); }
// Re-apply the current range to every existing slider (live, without rebuilding the panel/values).
function applyExprRange() {
    for (const s of morphSliders) {
        s.slider.min = String(exprMin); s.slider.max = String(exprMax);
        const v = clampExpr(parseFloat(s.slider.value) || 0);
        s.slider.value = String(v); faceMorphValues.set(s.full, v); s.num.textContent = v.toFixed(2);
    }
}

// Expression panel: drag by the title bar + close [×] + toolbar toggle.
const exprPanel = document.getElementById("expr-panel");
// Record undo history when a face slider settles (change fires on release).
if (exprPanel) exprPanel.addEventListener("change", () => commitHistory());
// Same for the hand-pose panel (preset selects + weight sliders).
const handPosePanelEl = document.getElementById("hand-pose-panel");
if (handPosePanelEl) handPosePanelEl.addEventListener("change", () => commitHistory());
const exprTitle = exprPanel ? exprPanel.querySelector(".ep-title") : null;
if (exprTitle) {
    let edx = 0, edy = 0, edrag = false;
    exprTitle.addEventListener("pointerdown", (e) => {
        if (e.target.closest("#expr-close")) return;
        const r = exprPanel.getBoundingClientRect();
        exprPanel.style.left = r.left + "px"; exprPanel.style.top = r.top + "px";
        edx = e.clientX - r.left; edy = e.clientY - r.top; edrag = true;
        try { exprTitle.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    exprTitle.addEventListener("pointermove", (e) => {
        if (!edrag) return;
        exprPanel.style.left = Math.max(0, Math.min(e.clientX - edx, window.innerWidth - exprPanel.offsetWidth)) + "px";
        exprPanel.style.top = Math.max(0, Math.min(e.clientY - edy, window.innerHeight - exprPanel.offsetHeight)) + "px";
    });
    const eend = (e) => { if (edrag) { edrag = false; try { exprTitle.releasePointerCapture(e.pointerId); } catch (_) {} } };
    exprTitle.addEventListener("pointerup", eend);
    exprTitle.addEventListener("pointercancel", eend);
}
const exprClose = document.getElementById("expr-close");
if (exprClose && exprPanel) exprClose.addEventListener("click", () => { exprPanel.hidden = true; });

// ---- 手のポーズ (hand pose) panel: select a preset + weight per hand ----
const handPosePanel = document.getElementById("hand-pose-panel");
if (handPosePanel) {
    for (const side of ["left", "right"]) {
        const sel = document.getElementById(`hp-${side}-preset`);
        const wInput = document.getElementById(`hp-${side}-weight`);
        const wVal = document.getElementById(`hp-${side}-weight-val`);
        if (sel) {
            for (const key of HAND_PRESET_ORDER) {
                const opt = document.createElement("option");
                opt.value = key; opt.textContent = HAND_PRESET_LABELS[key];
                sel.appendChild(opt);
            }
            sel.value = handPoseState[side].preset;
            sel.addEventListener("change", () => {
                handPoseState[side].preset = sel.value; saveHandPoseState();
                applyHandPose(side, sel.value, handPoseState[side].weight);
            });
        }
        if (wInput && wVal) {
            wInput.value = String(handPoseState[side].weight);
            wVal.textContent = handPoseState[side].weight.toFixed(2);
            wInput.addEventListener("input", () => {
                const v = clamp01(parseFloat(wInput.value));
                handPoseState[side].weight = v; wVal.textContent = v.toFixed(2); saveHandPoseState();
                applyHandPose(side, handPoseState[side].preset, v);
            });
        }
    }
    // draggable title + close (mirror the 表情 panel)
    const hpTitle = handPosePanel.querySelector(".ep-title");
    if (hpTitle) {
        let hdx = 0, hdy = 0, hdrag = false;
        hpTitle.addEventListener("pointerdown", (e) => {
            if (e.target.closest("#hand-pose-close")) return;
            const r = handPosePanel.getBoundingClientRect();
            handPosePanel.style.left = r.left + "px"; handPosePanel.style.top = r.top + "px";
            hdx = e.clientX - r.left; hdy = e.clientY - r.top; hdrag = true;
            try { hpTitle.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        hpTitle.addEventListener("pointermove", (e) => {
            if (!hdrag) return;
            handPosePanel.style.left = Math.max(0, Math.min(e.clientX - hdx, window.innerWidth - handPosePanel.offsetWidth)) + "px";
            handPosePanel.style.top = Math.max(0, Math.min(e.clientY - hdy, window.innerHeight - handPosePanel.offsetHeight)) + "px";
        });
        const hend = (e) => { if (hdrag) { hdrag = false; try { hpTitle.releasePointerCapture(e.pointerId); } catch (_) {} } };
        hpTitle.addEventListener("pointerup", hend);
        hpTitle.addEventListener("pointercancel", hend);
    }
    const hpClose = document.getElementById("hand-pose-close");
    if (hpClose) hpClose.addEventListener("click", () => { handPosePanel.hidden = true; });
}

// Expression panel: drag the bottom edge to resize height (上下); the body scrolls within.
const exprResize = exprPanel ? exprPanel.querySelector(".ep-resize") : null;
if (exprResize && exprPanel) {
    let startH = 0, startY = 0, ersz = false;
    exprResize.addEventListener("pointerdown", (e) => {
        startH = exprPanel.offsetHeight; startY = e.clientY; ersz = true;
        exprPanel.style.maxHeight = "none"; // once resized, the explicit height wins over the CSS 72vh cap
        try { exprResize.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault(); e.stopPropagation();
    });
    exprResize.addEventListener("pointermove", (e) => {
        if (!ersz) return;
        const maxH = Math.round(window.innerHeight * 0.92);
        exprPanel.style.height = Math.max(140, Math.min(startH + (e.clientY - startY), maxH)) + "px";
        const r = exprPanel.getBoundingClientRect(); // grew past the bottom edge? shift the panel up
        if (r.bottom > window.innerHeight - 4) exprPanel.style.top = Math.max(4, window.innerHeight - 4 - r.height) + "px";
    });
    const erend = (e) => { if (ersz) { ersz = false; try { exprResize.releasePointerCapture(e.pointerId); } catch (_) {} } };
    exprResize.addEventListener("pointerup", erend);
    exprResize.addEventListener("pointercancel", erend);
}

// Hint Weight slider: how strongly the hint (pole) steers the IK bend (0..1).
const hintWeightInput = document.getElementById("hint-weight");
const hintWeightVal = document.getElementById("hint-weight-val");
if (hintWeightInput) {
    hintWeightInput.value = String(hintWeight);
    if (hintWeightVal) hintWeightVal.textContent = hintWeight.toFixed(2);
    hintWeightInput.addEventListener("input", () => {
        hintWeight = parseFloat(hintWeightInput.value);
        if (hintWeightVal) hintWeightVal.textContent = hintWeight.toFixed(2);
        localStorage.setItem(HINT_WEIGHT_KEY, String(hintWeight));
    });
}

// IK anchors: pin a hand/foot/chest in world space; the chain solves every frame
// to hold the tip there as the body/hips move (planted feet for a squat, etc.).
const ANCHOR_KEYS = ["leftFoot", "rightFoot", "chest", "leftHand", "rightHand"];
function setAnchor(key, on) {
    const ch = ikChains.find((c) => c.key === key);
    if (!ch) return;
    ch.anchored = on;
    ch.target.scale.setScalar(on ? 1.4 : 1);            // bigger ball = pinned
    const col = on ? IK_ANCHOR_COLOR : IK_TARGET_COLOR; // pink = anchored, green = free
    ch.target.userData.baseColor = col;                 // hover restores to this color
    setMeshColor(ch.target, col);                       // tint the ring child now
}
function resetAnchorUI() {
    for (const key of ANCHOR_KEYS) {
        const el = document.getElementById("anchor-" + key);
        if (el) el.checked = false;
    }
}
for (const key of ANCHOR_KEYS) {
    const el = document.getElementById("anchor-" + key);
    if (el) el.addEventListener("change", () => setAnchor(key, el.checked));
}

// ---- Undo / Redo --------------------------------------------------------
// Snapshot-based: each entry captures the editable POSE state -- bone pose,
// hips, gaze, expressions, IK anchor flags. (Root move/rotate/scale staging is
// intentionally NOT tracked.) commitHistory() is called whenever an edit
// finishes; Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) navigate.
const HISTORY_LIMIT = 80;
let _history = [];
let _histIndex = -1;
let _restoringHistory = false;

function captureState() {
    if (!currentVRM) return null;
    return {
        bones: boneHandles.map((h) => h.bone.quaternion.toArray()),
        hip: hipCtrl ? { q: hipCtrl.node.quaternion.toArray(), p: hipCtrl.node.position.toArray() } : null,
        gaze: gazeCtrl ? {
            c: gazeCtrl.ball.position.toArray(),
            l: gazeCtrl.ballL ? gazeCtrl.ballL.position.toArray() : null,
            r: gazeCtrl.ballR ? gazeCtrl.ballR.position.toArray() : null,
        } : null,
        expr: [...faceMorphValues.entries()],
        ik: ikChains.map((ch) => ch.anchored),
    };
}

function restoreState(s) {
    if (!s || !currentVRM) return;
    _restoringHistory = true;
    boneHandles.forEach((h, i) => { if (s.bones[i]) h.bone.quaternion.fromArray(s.bones[i]); });
    if (s.hip && hipCtrl) { hipCtrl.node.quaternion.fromArray(s.hip.q); hipCtrl.node.position.fromArray(s.hip.p); }
    if (s.gaze && gazeCtrl) {
        gazeCtrl.ball.position.fromArray(s.gaze.c);
        if (s.gaze.l && gazeCtrl.ballL) gazeCtrl.ballL.position.fromArray(s.gaze.l);
        if (s.gaze.r && gazeCtrl.ballR) gazeCtrl.ballR.position.fromArray(s.gaze.r);
    }
    if (s.expr) {
        faceMorphValues.clear();
        for (const [k, v] of s.expr) faceMorphValues.set(k, v);
        for (const sl of morphSliders) { const v = faceMorphValues.get(sl.full) ?? 0; sl.slider.value = String(v); sl.num.textContent = v.toFixed(2); }
    }
    if (s.ik) ikChains.forEach((ch, i) => {
        if (ch.anchored !== s.ik[i]) {
            setAnchor(ch.key, s.ik[i]);
            const cb = document.getElementById("anchor-" + ch.key); if (cb) cb.checked = s.ik[i];
        }
    });
    currentVRM.humanoid.update();
    syncTransformPanel();
    snapProxies(true);
    _restoringHistory = false;
}

function resetHistory() {
    _history = []; _histIndex = -1;
    const s = captureState();
    if (s) { _history = [s]; _histIndex = 0; }
}

// Push the current state as a new entry (no-op while restoring or if unchanged).
function commitHistory() {
    if (_restoringHistory || !currentVRM) return;
    const s = captureState();
    if (!s) return;
    if (_histIndex >= 0 && JSON.stringify(_history[_histIndex]) === JSON.stringify(s)) return;
    _history.length = _histIndex + 1; // drop any redo tail
    _history.push(s);
    if (_history.length > HISTORY_LIMIT) _history.shift();
    _histIndex = _history.length - 1;
}

function undo() {
    if (_histIndex <= 0) { setStatus("これ以上元に戻せません"); return; }
    _histIndex--; restoreState(_history[_histIndex]);
    setStatus(`元に戻す  (${_histIndex + 1}/${_history.length})`);
}
function redo() {
    if (_histIndex >= _history.length - 1) { setStatus("これ以上やり直せません"); return; }
    _histIndex++; restoreState(_history[_histIndex]);
    setStatus(`やり直し  (${_histIndex + 1}/${_history.length})`);
}

window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // let native undo work in fields
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
});

const poseResetBtn = document.getElementById("pose-reset-btn");
if (poseResetBtn) {
    poseResetBtn.addEventListener("click", () => {
        if (!currentVRM) { showToast("VRMが読み込まれていません", "error", 2000); return; }
        resetPose();
        commitHistory();
        showToast("ポーズをリセットしました", "info", 2000);
    });
}

const rootResetBtn = document.getElementById("root-reset-btn");
if (rootResetBtn) {
    rootResetBtn.addEventListener("click", () => {
        if (!currentModel) { showToast("VRMが読み込まれていません", "error", 2000); return; }
        resetRoot();
        showToast("全体の位置・向き・傾きをリセットしました", "info", 2000);
    });
}

// ---- ポーズライブラリ: bundled *.vroidpose / *.json loader -----------------
// VRoid Studio writes per-humanoid-bone *local* rotations (Unity left-handed
// space) under BoneDefinition. We convert each to the @pixiv/three-vrm normalized
// rig and stamp it on the normalized bone nodes -- the same nodes the FK/IK handles
// edit -- so a loaded pose flows through vrm.update() into every capture/preview.
// Translation (HipsPosition) is NOT applied (a pose here = joint angles + the hand
// grip). The VRoid hand grip (e.g. L_Grip) maps onto our 手のポーズ presets below.
const VROID_TO_VRM = {
    Hips: "hips", Spine: "spine", Chest: "chest", UpperChest: "upperChest",
    Neck: "neck", Head: "head",
    LeftShoulder: "leftShoulder", LeftUpperArm: "leftUpperArm",
    LeftLowerArm: "leftLowerArm", LeftHand: "leftHand",
    RightShoulder: "rightShoulder", RightUpperArm: "rightUpperArm",
    RightLowerArm: "rightLowerArm", RightHand: "rightHand",
    LeftUpperLeg: "leftUpperLeg", LeftLowerLeg: "leftLowerLeg",
    LeftFoot: "leftFoot", LeftToes: "leftToes",
    RightUpperLeg: "rightUpperLeg", RightLowerLeg: "rightLowerLeg",
    RightFoot: "rightFoot", RightToes: "rightToes",
};
// Per-bone X-axis tweak (deg) compensating the spine/shoulder/leg rest-pose
// difference between VRoid's humanoid and the normalized rig. Empirical values
// from the reference editor; applied in the bone's local frame after conversion.
const VROID_CORR_VRM0 = { Spine: 10, Chest: -18, UpperChest: -9, Neck: 15, LeftUpperLeg: 2, RightUpperLeg: 2, LeftShoulder: 16, RightShoulder: 16 };
const VROID_CORR_VRM1 = { Spine: -10, Chest: 18, UpperChest: 9, Neck: -15, LeftUpperLeg: -2, RightUpperLeg: -2, LeftShoulder: -16, RightShoulder: -16 };

// VRoid stores the finger shape as a named hand animation (e.g. "L_Grip" = fist),
// NOT explicit finger rotations. Map it onto our own 手のポーズ presets (Phase 43)
// by keyword, so a loaded pose's grip flows through applyHandPose. Unknown names
// leave the hand untouched (and warn so we can learn the name).
const VROID_HAND_TO_PRESET = [
    [/grip|fist|rock|hold|gu\b/i, "fist"],
    [/open|paper|palm|spread/i, "open"],
    [/thumb|good|like/i, "thumbsup"],
    [/peace|victory|\bv\b/i, "peace"],
    [/claw|gao/i, "claw"],
    [/point|index/i, "point"],
    [/natural|relax|default|rest|none/i, "natural"],
];
function vroidHandPreset(name) {
    if (!name) return null;
    for (const [re, key] of VROID_HAND_TO_PRESET) if (re.test(name)) return key;
    return null;
}
function syncHandPoseUI(side) {
    const sel = document.getElementById(`hp-${side}-preset`);
    const w = document.getElementById(`hp-${side}-weight`);
    const wv = document.getElementById(`hp-${side}-weight-val`);
    if (sel) sel.value = handPoseState[side].preset;
    if (w) w.value = String(handPoseState[side].weight);
    if (wv) wv.textContent = handPoseState[side].weight.toFixed(2);
}

// Apply a parsed VRoid pose's BODY bones to an arbitrary VRM's normalized rig.
// Returns the count applied. (Hand grip presets are handled by the caller for the
// live model; the offscreen mannequin thumbnail only needs the body.)
function applyVroidPoseBones(vrm, parsed) {
    const humanoid = vrm?.humanoid;
    if (!humanoid) return 0;
    const isVrm0 = (vrm.meta?.metaVersion ?? "0") === "0";
    let applied = 0;
    if (parsed.BoneDefinition) {
        const corr = isVrm0 ? VROID_CORR_VRM0 : VROID_CORR_VRM1;
        const bd = parsed.BoneDefinition;
        const _c = new THREE.Quaternion();
        const _e = new THREE.Euler();
        for (const [vk, vrmKey] of Object.entries(VROID_TO_VRM)) {
            const r = bd[vk]; if (!r) continue;
            const node = humanoid.getNormalizedBoneNode(vrmKey); if (!node) continue;
            // Unity -> three.js (right-handed): negate z & w; VRM1 also flips y & w.
            const q = new THREE.Quaternion(r.x, r.y, -r.z, -r.w).normalize();
            if (!isVrm0) q.set(q.x, -q.y, q.z, -q.w).normalize();
            const deg = corr[vk];
            if (deg) {
                _c.setFromEuler(_e.set(THREE.MathUtils.degToRad(deg), 0, 0)).premultiply(q); // q * correction (local)
                node.quaternion.copy(_c);
            } else {
                node.quaternion.copy(q);
            }
            applied++;
        }
    } else {
        // Generic fallback: {bones:{key:{x,y,z,w}}} or {key:{x,y,z,w}} already in
        // normalized-rig space (e.g. a future native export). No conversion.
        const bones = parsed.bones ?? parsed;
        for (const [key, v] of Object.entries(bones)) {
            if (!v || typeof v !== "object" || v.w === undefined) continue;
            const node = humanoid.getNormalizedBoneNode(key) ??
                         humanoid.getNormalizedBoneNode(key[0].toLowerCase() + key.slice(1));
            if (!node) continue;
            node.quaternion.set(v.x ?? 0, v.y ?? 0, v.z ?? 0, v.w).normalize();
            applied++;
        }
    }
    return applied;
}
function applyVroidPose(poseText) {
    if (!currentVRM) { showToast("VRMが読み込まれていません", "error", 2000); return false; }
    let parsed;
    try { parsed = JSON.parse(poseText); } catch (_) { showToast("ポーズファイルの解析に失敗しました", "error", 2500); return false; }
    const applied = applyVroidPoseBones(currentVRM, parsed);

    if (parsed.BoneDefinition) {
        // Hand grip: VRoid keeps the finger shape as a named animation, not bone
        // rotations. Map it to our hand-pose preset (+weight) and stamp the fingers.
        for (const [side, nameKey, wKey] of [
            ["left", "LeftHandAnimationName", "LeftHandAnimationWeight"],
            ["right", "RightHandAnimationName", "RightHandAnimationWeight"],
        ]) {
            const key = vroidHandPreset(parsed[nameKey]);
            if (!key) { if (parsed[nameKey]) console.warn("[VRM Scene Editor] unmapped VRoid hand pose:", parsed[nameKey]); continue; }
            const w = typeof parsed[wKey] === "number" ? clamp01(parsed[wKey]) : 1;
            handPoseState[side].preset = key;
            handPoseState[side].weight = w;
            applyHandPose(side, key, w);
            syncHandPoseUI(side);
        }
        saveHandPoseState();
    }

    if (!applied) { showToast("適用できるボーンが見つかりませんでした", "error", 2500); return false; }
    currentVRM.humanoid.update();
    currentVRM.scene.updateMatrixWorld(true);
    snapProxies(true); // move IK/hip/shoulder balls onto the new pose
    commitHistory();   // applied a library pose -> record it
    return true;
}

// Pose library floating panel: list pose/ files, click to apply.
// ---- モデル一覧: load VRM/GLB files the user dropped into models/vrm ----
const MODEL_SUBDIR = "vrm"; // matches the backend folder name (models/vrm)
// Sentinel "file" for the bundled sample model so a scene that contains it can be
// restored (it lives under editor assets, not models/vrm).
const DEFAULT_MODEL_FILE = "__default_sample__";
const DEFAULT_MODEL_URL = "/vrm-scene-editor-assets/models/sample.vrm";
function modelUrl(file) {
    if (file === DEFAULT_MODEL_FILE) return DEFAULT_MODEL_URL;
    return "/vrm-scene-models/" + encodeURIComponent(MODEL_SUBDIR) + "/" + encodeURIComponent(file);
}
function loadModelByUrl(url, name, add, file) {
    setStatus(`読込中: ${name} ...`);
    return new Promise((resolve) => {
        loader.load(
            url,
            (gltf) => { onModelLoaded(gltf, add, file); setStatus(`読込完了: ${name}`); resolve(true); },
            undefined,
            (err) => { console.error(err); setStatus(`読込エラー: ${err?.message || err}`); resolve(false); },
        );
    });
}
function loadModelFromLibrary(m, add) {
    return loadModelByUrl(modelUrl(m.file), m.name, add, m.file);
}

// Offscreen FULL-BODY thumbnail renderer. VRoid's embedded VRM thumbnail is just
// a face close-up, so we render the whole model ourselves (lazily per visible
// card, cached per file for the session). Portrait 3:4 to fit a standing figure.
const THUMB_W = 264, THUMB_H = 352;
const _thumbCache = new Map(); // file -> dataURL
let _thumbR = null, _thumbScene = null, _thumbCam = null;
function _initThumb() {
    if (_thumbR) return;
    _thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    _thumbR.setPixelRatio(1);
    _thumbR.setSize(THUMB_W, THUMB_H, false);
    _thumbR.outputColorSpace = THREE.SRGBColorSpace;
    _thumbScene = new THREE.Scene();
    _thumbScene.background = new THREE.Color(0xffffff); // white thumbnail background
    _thumbScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
    const d = new THREE.DirectionalLight(0xffffff, 1.3); d.position.set(1, 2, 3); _thumbScene.add(d);
    _thumbCam = new THREE.PerspectiveCamera(28, THUMB_W / THUMB_H, 0.01, 100);
}
function renderThumb(file) {
    return new Promise((resolve) => {
        try { _initThumb(); } catch (_) { resolve(null); return; }
        loader.load(modelUrl(file), (gltf) => {
            try {
                const vrm = gltf.userData.vrm;
                const obj = vrm ? vrm.scene : gltf.scene;
                if (vrm) VRMUtils.rotateVRM0(vrm); // face +Z (no-op for VRM1)
                _thumbScene.add(obj);
                obj.updateWorldMatrix(true, true);
                const box = new THREE.Box3().setFromObject(obj);
                const size = new THREE.Vector3(); box.getSize(size);
                const center = new THREE.Vector3(); box.getCenter(center);
                const fov = THREE.MathUtils.degToRad(_thumbCam.fov);
                const distH = (size.y / 2) / Math.tan(fov / 2);
                const distW = (size.x / 2) / (Math.tan(fov / 2) * _thumbCam.aspect);
                const dist = Math.max(distH, distW) * 1.12 + size.z; // fit height & width + margin
                _thumbCam.position.set(center.x, center.y, center.z + dist);
                _thumbCam.lookAt(center.x, center.y, center.z);
                _thumbCam.updateProjectionMatrix();
                _thumbR.render(_thumbScene, _thumbCam);
                const url = _thumbR.domElement.toDataURL("image/png");
                _thumbScene.remove(obj);
                if (vrm) VRMUtils.deepDispose(vrm.scene);
                else obj.traverse((o) => { o.geometry?.dispose?.(); const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const mm of ms) mm.dispose?.(); });
                _thumbCache.set(file, url);
                resolve(url);
            } catch (e) { console.error("thumb render failed", e); resolve(null); }
        }, undefined, () => resolve(null));
    });
}

// Generic close + drag-by-title wiring for a floating panel.
function setupFloatingPanel(panelId, closeId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const closeBtn = closeId && document.getElementById(closeId);
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.hidden = true; });
    const title = panel.querySelector(".ep-title");
    if (title) {
        let dx = 0, dy = 0, drag = false;
        title.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
            const r = panel.getBoundingClientRect();
            panel.style.left = r.left + "px"; panel.style.top = r.top + "px";
            dx = e.clientX - r.left; dy = e.clientY - r.top; drag = true;
            try { title.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        title.addEventListener("pointermove", (e) => {
            if (!drag) return;
            panel.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - panel.offsetWidth)) + "px";
            panel.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - panel.offsetHeight)) + "px";
        });
        const end = (e) => { if (drag) { drag = false; try { title.releasePointerCapture(e.pointerId); } catch (_) {} } };
        title.addEventListener("pointerup", end);
        title.addEventListener("pointercancel", end);
    }
}
// パネルの位置・サイズを localStorage に記憶（ドラッグ移動／リサイズのタイミングで保存、起動時に復元）。
function persistPanelGeometry(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
        const s = JSON.parse(localStorage.getItem(key));
        if (s) {
            if (typeof s.left === "number") { el.style.left = s.left + "px"; el.style.right = "auto"; }
            if (typeof s.top === "number") el.style.top = s.top + "px";
            if (typeof s.w === "number") el.style.width = s.w + "px";
            if (typeof s.h === "number") el.style.height = s.h + "px";
        }
    } catch (_) { /* defaults */ }
    const save = () => {
        if (el.hidden) return; // 非表示時は rect が 0 -> 保存しない
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        localStorage.setItem(key, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    };
    try { new ResizeObserver(() => save()).observe(el); } catch (_) {} // サイズ変更時
    const title = el.querySelector(".ep-title");
    if (title) { title.addEventListener("pointerup", save); title.addEventListener("pointercancel", save); } // ドラッグ終了時
}
setupFloatingPanel("camera-panel", "camera-panel-close");

// 配置モデル＋ボーンツリーの統合ウィンドウ（close + drag）。
setupFloatingPanel("scene-panel", "scene-panel-close");

// 矢印(選択)モード: ビューでモデルをクリックしてアクティブ機体を切り替える。
// ボーン編集ON中は無効（クリックはボーン操作に使うため）。ドラッグ(カメラ回転)は除外。
(function setupModelClickSelect() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downX = 0, downY = 0, downBtn = -1;
    canvasEl.addEventListener("pointerdown", (e) => { downX = e.clientX; downY = e.clientY; downBtn = e.button; });
    canvasEl.addEventListener("pointerup", (e) => {
        if (boneEditEnabled || e.button !== 0 || downBtn !== 0) return;       // 矢印モード＋左クリックのみ
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;     // ドラッグ(回転)は無視
        if (!loadedModels.length) return;
        const rect = canvasEl.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        ray.setFromCamera(ndc, camera);
        let best = null, bestDist = Infinity;
        for (const ent of loadedModels) {
            const hits = ray.intersectObject(ent.model, true);
            if (hits.length && hits[0].distance < bestDist) { bestDist = hits[0].distance; best = ent; }
        }
        if (best && best.root !== modelRoot) { activateModel(best); setStatus(`選択: ${best.name}`); }
    });
})();

// ---- ボーンツリー: アクティブモデルのボーン階層＋ローカル回転(度)を表示 ----
const boneTreePanel = document.getElementById("scene-panel"); // bone tree lives in the merged panel
let _boneTreeRows = []; // [{ bone, val, handle, row }]
let _rawToHandle = new Map(); // raw bone node -> FK handle (editable/selectable/lockable)
let _btChildren = new Map();  // editable bone -> [editable child bones] (for subtree lock)
let _btTick = 0;

// Collect a bone + all its editable descendants (null = every editable bone).
function btSubtree(bone) {
    if (!bone) return null;
    const set = new Set(); const stack = [bone];
    while (stack.length) { const b = stack.pop(); set.add(b); for (const c of (_btChildren.get(b) || [])) stack.push(c); }
    return set;
}
// Lock (or unlock) a bone's whole subtree (null = all). locked=true -> uncheck/lock.
function setSubtreeLocked(bone, locked) {
    const set = btSubtree(bone);
    for (const { bone: b, handle, cb } of _boneTreeRows) {
        if (!handle || (set && !set.has(b))) continue;
        if (locked) { lockedBones.add(handle.bone); if (selectedFK && selectedFK.bone === handle.bone) deselectFK(); }
        else lockedBones.delete(handle.bone);
        if (cb) cb.checked = !locked;
    }
    setEditVisible(_editVisible);
}
function showBoneTreeMenu(x, y, bone) {
    ctxMenu.textContent = "";
    addCtxItem((bone ? (bone.name || "bone") : "全ボーン") + " 配下", null, true);
    addCtxItem("すべて選択（編集可）", () => setSubtreeLocked(bone, false));
    addCtxItem("すべて非選択（ロック）", () => setSubtreeLocked(bone, true));
    ctxMenu.style.display = "block";
    ctxMenu.style.left = Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 4) + "px";
    ctxMenu.style.top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 4) + "px";
}
// Every node here is an editable (control-point) bone; non-control bones are omitted.
function renderBoneNode(bone, childrenMap) {
    const handle = _rawToHandle.get(bone);
    const li = document.createElement("li");
    const row = document.createElement("div"); row.className = "bt-row";
    const kids = childrenMap.get(bone) || [];
    // lock checkbox: checked = editable, unchecked = locked (not selectable, angle fixed).
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.className = "bt-lock"; cb.checked = !lockedBones.has(handle.bone);
    cb.title = "編集可（外すと選択不可・角度固定）";
    cb.addEventListener("change", () => {
        if (cb.checked) lockedBones.delete(handle.bone);
        else { lockedBones.add(handle.bone); if (selectedFK && selectedFK.bone === handle.bone) deselectFK(); }
        setEditVisible(_editVisible); // reapply: show/hide this bone's control point
    });
    row.appendChild(cb);
    const tog = document.createElement("span"); tog.className = "bt-tog";
    if (kids.length) {
        tog.textContent = "▾"; tog.style.cursor = "pointer";
        tog.addEventListener("click", () => { li.classList.toggle("collapsed"); tog.textContent = li.classList.contains("collapsed") ? "▸" : "▾"; });
    } else tog.textContent = "・";
    const name = document.createElement("span"); name.className = "bt-name bt-sel"; name.textContent = bone.name || "(bone)";
    name.title = "クリックで選択";
    name.addEventListener("click", () => { if (!lockedBones.has(handle.bone)) selectFK(handle); }); // tree -> view sync
    const val = document.createElement("span"); val.className = "bt-val";
    row.append(tog, name, val);
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); showBoneTreeMenu(e.clientX, e.clientY, bone); }); // 配下一括ロック
    li.appendChild(row);
    _boneTreeRows.push({ bone, val, handle, row, cb });
    if (kids.length) {
        const ul = document.createElement("ul");
        for (const c of kids) ul.appendChild(renderBoneNode(c, childrenMap));
        li.appendChild(ul);
    }
    return li;
}
function buildBoneTree() {
    const body = document.getElementById("bone-tree-body");
    if (!body || !boneTreePanel || boneTreePanel.hidden) return; // only when the window is open
    _boneTreeRows = [];
    body.innerHTML = "";
    // map each FK handle's raw bone -> handle (control-point bones only)
    _rawToHandle = new Map();
    const hum = currentVRM?.humanoid;
    if (hum) for (const h of boneHandles) { const raw = h.name && hum.getRawBoneNode(h.name); if (raw) _rawToHandle.set(raw, h); }
    if (!_rawToHandle.size) { body.innerHTML = '<div class="bt-empty">制御点ボーンがありません</div>'; return; }
    // nest editable bones under their nearest editable ancestor
    const parentEditable = (bone) => { let p = bone.parent; while (p) { if (_rawToHandle.has(p)) return p; p = p.parent; } return null; };
    const childrenMap = new Map();
    const roots = [];
    for (const b of _rawToHandle.keys()) {
        const pe = parentEditable(b);
        if (pe) { (childrenMap.get(pe) || childrenMap.set(pe, []).get(pe)).push(b); }
        else roots.push(b);
    }
    _btChildren = childrenMap;
    // No single bone root (hips isn't an FK handle) -> use the model name as the root.
    const modelName = (loadedModels.find((e) => e.root === modelRoot)?.name) || "model";
    const rootLi = document.createElement("li");
    const rootRow = document.createElement("div"); rootRow.className = "bt-row";
    const sp = document.createElement("span"); sp.className = "bt-lock-spacer";
    const rtog = document.createElement("span"); rtog.className = "bt-tog"; rtog.textContent = "▾"; rtog.style.cursor = "pointer";
    rtog.addEventListener("click", () => { rootLi.classList.toggle("collapsed"); rtog.textContent = rootLi.classList.contains("collapsed") ? "▸" : "▾"; });
    const rname = document.createElement("span"); rname.className = "bt-name bt-root"; rname.textContent = modelName;
    rootRow.append(sp, rtog, rname);
    rootRow.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); showBoneTreeMenu(e.clientX, e.clientY, null); }); // 全ボーン一括
    rootLi.appendChild(rootRow);
    const childUl = document.createElement("ul");
    for (const r of roots) childUl.appendChild(renderBoneNode(r, childrenMap));
    rootLi.appendChild(childUl);
    const ul = document.createElement("ul");
    ul.appendChild(rootLi);
    body.appendChild(ul);
    updateBoneTreeValues();
}
function updateBoneTreeValues() {
    if (!_boneTreeRows.length) return;
    const d = (r) => Math.round(THREE.MathUtils.radToDeg(r));
    const selBone = selectedFK ? selectedFK.bone : null;
    for (const { bone, val, handle, row } of _boneTreeRows) {
        const e = bone.rotation;
        val.textContent = `(${d(e.x)}, ${d(e.y)}, ${d(e.z)})`;
        if (handle) row.classList.toggle("bt-active", handle.bone === selBone); // view -> tree sync
    }
}
(function setupBoneTreePanel() {
    if (!boneTreePanel) return; // close/drag wired via setupFloatingPanel("scene-panel")
    const reload = document.getElementById("bone-tree-reload");
    if (reload) reload.addEventListener("click", buildBoneTree);
    // Rebuild the tree when the merged window is shown.
    new MutationObserver(() => { if (!boneTreePanel.hidden) buildBoneTree(); }).observe(boneTreePanel, { attributes: true, attributeFilter: ["hidden"] });
})();

(function setupModelLibrary() {
    const modal = document.getElementById("model-modal");
    if (!modal) return;
    const body = modal.querySelector(".pl-body");
    const reloadBtn = document.getElementById("model-reload");
    const openBtns = [document.getElementById("model-open-btn")]; // モデル ▾ → モデルを追加
    const openModal = () => { modal.hidden = false; load(); };
    const closeModal = () => { modal.hidden = true; };
    const addBtn = document.getElementById("model-add");
    const closeFootBtn = document.getElementById("model-close-btn");
    let currentModels = [];          // models in the current listing
    const selected = new Set();      // selected file names (multi-select)
    const updateAddBtn = () => { if (addBtn) addBtn.disabled = selected.size === 0; }; // 無選択時は無効(グレー)

    // 表示モード: OFF = 全身レンダリング / ON = VRM内蔵サムネイル（顔）。状態は保存。
    const modeCheck = document.getElementById("model-embedded-mode");
    const THUMB_MODE_KEY = "vrmSceneEditor.thumbMode";
    if (modeCheck) modeCheck.checked = localStorage.getItem(THUMB_MODE_KEY) !== "render"; // 既定ON(内蔵サムネ)
    const embeddedMode = () => !!(modeCheck && modeCheck.checked);
    const embeddedUrl = (file) => "/vrm-scene-editor/thumbnail?file=" + encodeURIComponent(file);
    const savedThumbUrl = (thumb) => "/vrm-scene-models/" + encodeURIComponent(MODEL_SUBDIR) + "/" + encodeURIComponent(thumb);
    function saveThumb(file, dataURL) { // persist a fresh render as <name>.png for reuse
        fetch("/vrm-scene-editor/save-thumbnail", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file, image: dataURL }),
        }).catch(() => {});
    }

    // Render thumbnails one at a time, only for cards scrolled into view.
    const queue = [];
    let rendering = false;
    async function pump() {
        if (rendering) return;
        rendering = true;
        while (queue.length) {
            const el = queue.shift();
            if (!el.isConnected) continue;
            const file = el.dataset.file;
            let url = _thumbCache.get(file), fresh = false;
            if (!url) { url = await renderThumb(file); fresh = true; }
            if (!el.isConnected) continue;
            if (url) {
                const img = document.createElement("img");
                img.className = "ml-thumb"; img.alt = ""; img.src = url;
                el.replaceWith(img);
                if (fresh) saveThumb(file, url); // save <name>.png so next time it's reused
            } else { el.textContent = "No Image"; el.classList.remove("ml-pending"); }
        }
        rendering = false;
    }
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target); pump(); }
    }, { root: body, rootMargin: "150px" });

    async function load() {
        io.disconnect(); queue.length = 0;
        body.innerHTML = '<div class="pl-empty">読込中 ...</div>';
        let data;
        try {
            const res = await fetch("/vrm-scene-editor/models");
            if (!res.ok) throw new Error("HTTP " + res.status);
            data = await res.json();
        } catch (e) {
            body.innerHTML = `<div class="pl-empty">一覧の取得に失敗しました (${e.message})<br>ComfyUI の再起動が必要かもしれません</div>`;
            return;
        }
        const models = data.models ?? [];
        currentModels = models; selected.clear(); updateAddBtn();
        if (!models.length) {
            body.innerHTML = '<div class="pl-empty">models/vrm にファイルがありません</div>';
            return;
        }
        body.innerHTML = "";
        for (const m of models) {
            const card = document.createElement("button");
            card.type = "button"; card.className = "ml-card"; card.title = m.file;
            let thumbEl;
            if (embeddedMode()) {
                // VRM内蔵サムネイル（顔）
                thumbEl = document.createElement("img"); thumbEl.className = "ml-thumb"; thumbEl.alt = ""; thumbEl.src = embeddedUrl(m.file);
                thumbEl.addEventListener("error", () => { const ph = document.createElement("div"); ph.className = "ml-noimg"; ph.textContent = "No Image"; thumbEl.replaceWith(ph); });
            } else if (m.thumb) {
                // 保存済みの全身レンダ（<name>.png）を再利用
                thumbEl = document.createElement("img"); thumbEl.className = "ml-thumb"; thumbEl.alt = ""; thumbEl.src = savedThumbUrl(m.thumb);
            } else if (_thumbCache.get(m.file)) {
                thumbEl = document.createElement("img"); thumbEl.className = "ml-thumb"; thumbEl.alt = ""; thumbEl.src = _thumbCache.get(m.file);
            } else {
                thumbEl = document.createElement("div"); thumbEl.className = "ml-noimg ml-pending"; thumbEl.textContent = "…";
                thumbEl.dataset.file = m.file;
                io.observe(thumbEl); // render when scrolled into view, then save
            }
            const nm = document.createElement("span"); nm.className = "ml-name"; nm.textContent = m.name;
            card.append(thumbEl, nm);
            card.addEventListener("click", () => { // クリックで選択トグル（複数選択可）
                if (selected.has(m.file)) { selected.delete(m.file); card.classList.remove("selected"); }
                else { selected.add(m.file); card.classList.add("selected"); }
                updateAddBtn();
            });
            body.appendChild(card);
        }
    }

    if (reloadBtn) reloadBtn.addEventListener("click", load);
    if (modeCheck) modeCheck.addEventListener("change", () => {
        localStorage.setItem(THUMB_MODE_KEY, modeCheck.checked ? "embedded" : "render");
        load();
    });
    // 追加: 選択中のモデルをすべて読み込み、ロード完了後にダイアログを閉じる。
    if (addBtn) addBtn.addEventListener("click", async () => {
        const chosen = currentModels.filter((m) => selected.has(m.file));
        if (!chosen.length) { setStatus("モデルを選択してください"); return; }
        addBtn.disabled = true;
        setStatus(`読込中 ... (${chosen.length})`);
        await Promise.all(chosen.map((m) => loadModelFromLibrary(m, true)));
        selected.clear();
        updateAddBtn();
        closeModal();
    });
    if (closeFootBtn) closeFootBtn.addEventListener("click", closeModal);
    for (const b of openBtns) if (b) b.addEventListener("click", openModal);
    // Close on the × button or a click on the dimmed backdrop (but not the card).
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });
})();

// ---- ポーズサムネ: 同梱サンプルをフラット青のマネキンにして、ポーズを当てて撮影 ----
const POSE_THUMB_SIZE = 96, POSE_THUMB_QUALITY = 0.72;
let _poseThumbR = null, _poseThumbScene = null, _poseThumbCam = null, _poseMannequin = null, _poseMannequinLoading = null;
function _initPoseThumb() {
    if (_poseThumbR) return;
    _poseThumbR = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    _poseThumbR.setPixelRatio(1);
    _poseThumbR.setSize(POSE_THUMB_SIZE, POSE_THUMB_SIZE, false);
    _poseThumbR.outputColorSpace = THREE.SRGBColorSpace;
    _poseThumbR.setClearColor(0x1a1a1a, 1);
    _poseThumbScene = new THREE.Scene();
    _poseThumbScene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.4));
    const d = new THREE.DirectionalLight(0xffffff, 1.1); d.position.set(1, 2, 2); _poseThumbScene.add(d);
    _poseThumbScene.overrideMaterial = new THREE.MeshStandardMaterial({ color: 0x3f7fd0, roughness: 0.65, metalness: 0.0 }); // ブルーマン風
    _poseThumbCam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
}
function loadPoseMannequin() {
    if (_poseMannequin) return Promise.resolve(_poseMannequin);
    if (_poseMannequinLoading) return _poseMannequinLoading;
    _initPoseThumb();
    _poseMannequinLoading = new Promise((resolve) => {
        loader.load(DEFAULT_MODEL_URL, (gltf) => {
            const vrm = gltf.userData.vrm;
            if (!vrm) { resolve(null); return; }
            VRMUtils.rotateVRM0(vrm); // face +Z
            _poseThumbScene.add(vrm.scene);
            vrm.scene.updateWorldMatrix(true, true);
            _poseMannequin = vrm;
            resolve(vrm);
        }, undefined, () => resolve(null));
    });
    return _poseMannequinLoading;
}
function _framePoseCam(vrm) {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const fov = THREE.MathUtils.degToRad(_poseThumbCam.fov);
    const distH = (size.y / 2) / Math.tan(fov / 2);
    const distW = (size.x / 2) / (Math.tan(fov / 2) * _poseThumbCam.aspect);
    const dist = Math.max(distH, distW) * 1.12 + size.z;
    _poseThumbCam.position.set(center.x, center.y, center.z + dist);
    _poseThumbCam.lookAt(center.x, center.y, center.z);
    _poseThumbCam.updateProjectionMatrix();
}
async function renderPoseThumb(poseText) {
    const vrm = await loadPoseMannequin();
    if (!vrm) return "";
    let parsed; try { parsed = JSON.parse(poseText); } catch (_) { return ""; }
    // 前のポーズが残らないよう、対象ボーンを rest(=identity) に戻してから適用
    for (const vrmKey of Object.values(VROID_TO_VRM)) { const n = vrm.humanoid.getNormalizedBoneNode(vrmKey); if (n) n.quaternion.identity(); }
    applyVroidPoseBones(vrm, parsed);
    vrm.humanoid.update();
    vrm.scene.updateWorldMatrix(true, true);
    _framePoseCam(vrm);
    let url = "";
    try { _poseThumbR.render(_poseThumbScene, _poseThumbCam); url = _poseThumbR.domElement.toDataURL("image/jpeg", POSE_THUMB_QUALITY); } catch (_) {}
    return url;
}

(function setupPoseLibrary() {
    const panel = document.getElementById("pose-lib-panel");
    if (!panel) return;
    const grid = document.getElementById("pose-lib-grid");
    const countEl = document.getElementById("pose-lib-count");
    const reloadBtn = document.getElementById("pose-lib-reload");
    const delBtn = document.getElementById("pose-lib-del");
    const closeBtn = document.getElementById("pose-lib-close");
    let poses = [];
    let selectedPose = -1;
    const poseThumbUrl = (thumb) => "/vrm-scene-models/pose/" + encodeURIComponent(thumb);

    const updateStatus = () => {
        if (countEl) countEl.textContent = `${poses.length}件`;
        if (delBtn) delBtn.disabled = selectedPose < 0;
    };

    // 未生成サムネを順番に描画→保存（同梱サンプルのフラット青マネキン）
    const thumbQueue = [];
    let thumbing = false;
    async function pumpThumbs() {
        if (thumbing) return; thumbing = true;
        while (thumbQueue.length) {
            const { p, imgEl } = thumbQueue.shift();
            if (!imgEl.isConnected) continue;
            let text;
            try {
                const res = await fetch("/vrm-scene-editor/pose?file=" + encodeURIComponent(p.file));
                if (!res.ok) throw new Error("HTTP " + res.status);
                text = await res.text();
            } catch (_) { continue; }
            const url = await renderPoseThumb(text);
            if (!url || !imgEl.isConnected) continue;
            imgEl.src = url;
            fetch("/vrm-scene-editor/save-pose-thumbnail", { // 次回から即表示
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ file: p.file, image: url }),
            }).catch(() => {});
        }
        thumbing = false;
    }

    async function load() {
        thumbQueue.length = 0;
        grid.innerHTML = '<div class="plib-empty">読込中 ...</div>';
        selectedPose = -1;
        let data;
        try {
            const res = await fetch("/vrm-scene-editor/poses");
            if (!res.ok) throw new Error("HTTP " + res.status);
            data = await res.json();
        } catch (_) {
            grid.innerHTML = '<div class="plib-empty">一覧の取得に失敗しました</div>';
            return;
        }
        poses = data.poses ?? [];
        updateStatus();
        if (!poses.length) { grid.innerHTML = '<div class="plib-empty">models/pose にファイルがありません</div>'; return; }
        grid.innerHTML = "";
        poses.forEach((p, idx) => {
            const card = document.createElement("div"); card.className = "plib-card"; card.title = p.file;
            const img = document.createElement("img"); img.className = "plib-thumb"; img.alt = "";
            if (p.thumb) img.src = poseThumbUrl(p.thumb) + "?t=" + Date.now(); // 保存済みサムネ
            else thumbQueue.push({ p, imgEl: img });                          // 未生成→後で描画＆保存
            const nm = document.createElement("span"); nm.className = "plib-name"; nm.textContent = p.name;
            card.append(img, nm);
            card.addEventListener("click", () => {
                selectedPose = idx;
                for (const c of grid.querySelectorAll(".plib-card.selected")) c.classList.remove("selected");
                card.classList.add("selected"); updateStatus();
            });
            card.addEventListener("dblclick", () => applyFile(p)); // ダブルクリックで適用
            grid.appendChild(card);
        });
        pumpThumbs();
    }

    async function applyFile(p) {
        if (!currentVRM) { showToast("VRMが読み込まれていません", "error", 2000); return; }
        let text;
        try {
            const res = await fetch("/vrm-scene-editor/pose?file=" + encodeURIComponent(p.file));
            if (!res.ok) throw new Error("HTTP " + res.status);
            text = await res.text();
        } catch (_) { showToast("ポーズの読込に失敗しました", "error", 2500); return; }
        if (applyVroidPose(text)) showToast(`ポーズ適用: ${p.name}`, "info", 2000);
    }

    function deleteSelected() {
        if (selectedPose < 0) return;
        const p = poses[selectedPose]; if (!p) return;
        confirmDialog(`ポーズ「${p.name}」を削除しますか？`, async () => {
            try {
                const res = await fetch("/vrm-scene-editor/delete-pose", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ file: p.file }),
                });
                const r = await res.json();
                if (!res.ok) throw new Error(r.error || res.status);
                showToast(`ポーズ削除: ${p.name}`, "success", 2000);
                load();
            } catch (e) { showToast(`削除失敗: ${e.message || e}`, "error", 3000); }
        });
    }

    if (reloadBtn) reloadBtn.addEventListener("click", load);
    if (delBtn) delBtn.addEventListener("click", deleteSelected);
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.hidden = true; });

    // draggable title (mirror the 手のポーズ panel)
    const title = panel.querySelector(".ep-title");
    if (title) {
        let dx = 0, dy = 0, drag = false;
        title.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
            const r = panel.getBoundingClientRect();
            panel.style.left = r.left + "px"; panel.style.top = r.top + "px";
            dx = e.clientX - r.left; dy = e.clientY - r.top; drag = true;
            try { title.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        title.addEventListener("pointermove", (e) => {
            if (!drag) return;
            panel.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - panel.offsetWidth)) + "px";
            panel.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - panel.offsetHeight)) + "px";
        });
        const end = (e) => { if (drag) { drag = false; try { title.releasePointerCapture(e.pointerId); } catch (_) {} } };
        title.addEventListener("pointerup", end);
        title.addEventListener("pointercancel", end);
    }

    load(); // populate on startup
})();

// ---- Right-click an IK target (anchor control point) -> popup menu ----
// This is our own standalone page, so we own the contextmenu event (OrbitControls
// already suppresses the browser menu so right-drag can pan). On right-click while an
// IK target is hovered (highlighted), show a small HTML menu at the cursor.
const ctxMenu = document.createElement("div");
ctxMenu.id = "ctx-menu";
ctxMenu.style.cssText = "position:fixed; z-index:1000; display:none; min-width:152px; background:#2c2c2c; border:1px solid #555; border-radius:5px; padding:4px 0; box-shadow:0 4px 14px rgba(0,0,0,.5); font:13px system-ui,sans-serif; color:#e6e6e6; user-select:none;";
document.body.appendChild(ctxMenu);

function hideCtxMenu() { ctxMenu.style.display = "none"; ctxMenu.textContent = ""; }

function addCtxItem(label, onClick, isHeader) {
    const it = document.createElement("div");
    it.textContent = label;
    it.style.cssText = isHeader
        ? "padding:5px 14px 3px; color:#9a9a9a; font-size:11px;"
        : "padding:6px 14px; cursor:pointer; white-space:nowrap;";
    if (!isHeader) {
        it.addEventListener("mouseenter", () => { it.style.background = "#3485bb"; });
        it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
        it.addEventListener("click", () => { hideCtxMenu(); onClick(); });
    }
    ctxMenu.appendChild(it);
}

function showTargetMenu(clientX, clientY, chainIndex) {
    const ch = ikChains[chainIndex];
    if (!ch) return;
    const label = (IK_CHAINS.find((c) => c.key === ch.key) || {}).label || ch.key;
    ctxMenu.textContent = "";
    addCtxItem(label + " IKターゲット", null, true);
    addCtxItem(ch.anchored ? "IKアンカー解除" : "IKアンカー固定", () => {
        const on = !ch.anchored;
        setAnchor(ch.key, on);
        const cb = document.getElementById("anchor-" + ch.key);
        if (cb) cb.checked = on;
    });
    addCtxItem("閉じる", () => {});
    ctxMenu.style.display = "block";
    ctxMenu.style.left = Math.min(clientX, window.innerWidth - ctxMenu.offsetWidth - 4) + "px";
    ctxMenu.style.top = Math.min(clientY, window.innerHeight - ctxMenu.offsetHeight - 4) + "px";
}

// Pelvis ball mode switch: "move" (drag = translate the pelvis) vs "rotate" (show the FK
// rotation ring on the hips = whole-body rotation). Separating them avoids the ring covering
// the ball, which blocked moving when both were on the same ball.
function setHipMode(mode) {
    hipMode = mode;
    if (mode === "rotate") { if (hipCtrl) selectFK({ bone: hipCtrl.node }); }
    else if (selectedFK && hipCtrl && selectedFK.bone === hipCtrl.node) deselectFK();
    if (hipCtrl) { // pelvis ball color: green = move, purple = rotate
        const col = mode === "rotate" ? HIP_ROTATE_COLOR : IK_TARGET_COLOR;
        hipCtrl.pos.userData.baseColor = col;                       // hover-out restores the mode color
        if (hoveredMesh === hipCtrl.pos) hoveredBaseColor = col;    // keep hover-restore in sync if hovered
        else setMeshColor(hipCtrl.pos, col);                        // not hovered -> apply now
    }
}
function showHipMenu(clientX, clientY) {
    ctxMenu.textContent = "";
    addCtxItem("腰（全身の移動／回転）", null, true);
    addCtxItem((hipMode === "move" ? "● " : "○ ") + "移動モード（ドラッグで移動）", () => setHipMode("move"));
    addCtxItem((hipMode === "rotate" ? "● " : "○ ") + "回転モード（リングで全身回転）", () => setHipMode("rotate"));
    ctxMenu.style.display = "block";
    ctxMenu.style.left = Math.min(clientX, window.innerWidth - ctxMenu.offsetWidth - 4) + "px";
    ctxMenu.style.top = Math.min(clientY, window.innerHeight - ctxMenu.offsetHeight - 4) + "px";
}

canvasEl.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // suppress the browser menu on the viewport
    const k = (boneEditEnabled && currentVRM && hoveredMesh && hoveredMesh.userData) ? hoveredMesh.userData.kind : null;
    if (k === "target") showTargetMenu(e.clientX, e.clientY, hoveredMesh.userData.chainIndex);
    else if (k === "hipPos") showHipMenu(e.clientX, e.clientY);
    else hideCtxMenu();
});
window.addEventListener("pointerdown", (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); }, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtxMenu(); });

// ---- Bottom-left transform panel: numeric translate / rotate(deg) / scale of the root rig ----
// Translate + yaw live on modelRoot; pitch/roll + scale on modelTilt (the tilt layer that
// keeps the floor ring flat). Rotation is shown/entered in DEGREES.
const TP = {
    px: document.getElementById("tp-px"), py: document.getElementById("tp-py"), pz: document.getElementById("tp-pz"),
    rx: document.getElementById("tp-rx"), ry: document.getElementById("tp-ry"), rz: document.getElementById("tp-rz"),
    sx: document.getElementById("tp-sx"), sy: document.getElementById("tp-sy"), sz: document.getElementById("tp-sz"),
};
function syncTransformPanel() {
    if (!modelRoot || !modelTilt) return;
    const set = (el, v) => { if (el && document.activeElement !== el) el.value = String(Math.round(v * 1000) / 1000); };
    set(TP.px, modelRoot.position.x); set(TP.py, modelRoot.position.y); set(TP.pz, modelRoot.position.z);
    set(TP.rx, THREE.MathUtils.radToDeg(modelTilt.rotation.x));
    set(TP.ry, THREE.MathUtils.radToDeg(modelRoot.rotation.y));
    set(TP.rz, THREE.MathUtils.radToDeg(modelTilt.rotation.z));
    set(TP.sx, modelTilt.scale.x); set(TP.sy, modelTilt.scale.y); set(TP.sz, modelTilt.scale.z);
}
function applyTransformPanel() {
    if (!modelRoot || !modelTilt) return;
    const v = (el) => { const n = el ? parseFloat(el.value) : NaN; return isFinite(n) ? n : null; };
    let n;
    if ((n = v(TP.px)) !== null) modelRoot.position.x = n;
    if ((n = v(TP.py)) !== null) modelRoot.position.y = n;
    if ((n = v(TP.pz)) !== null) modelRoot.position.z = n;
    if ((n = v(TP.ry)) !== null) modelRoot.rotation.y = THREE.MathUtils.degToRad(n);
    if ((n = v(TP.rx)) !== null) modelTilt.rotation.x = THREE.MathUtils.degToRad(n);
    if ((n = v(TP.rz)) !== null) modelTilt.rotation.z = THREE.MathUtils.degToRad(n);
    if ((n = v(TP.sx)) !== null) modelTilt.scale.x = n || 1e-3;
    if ((n = v(TP.sy)) !== null) modelTilt.scale.y = n || 1e-3;
    if ((n = v(TP.sz)) !== null) modelTilt.scale.z = n || 1e-3;
}
for (const el of Object.values(TP)) { if (el) el.addEventListener("input", applyTransformPanel); }

// Drag the transform panel by its title bar (free-position it anywhere in the viewport).
const tpPanel = document.getElementById("transform-panel");
const tpTitle = tpPanel ? tpPanel.querySelector(".tp-title") : null;
if (tpTitle) {
    let tpDX = 0, tpDY = 0, tpDragging = false;
    tpTitle.addEventListener("pointerdown", (e) => {
        if (e.target.closest("#tp-close")) return; // clicking the close button shouldn't start a drag
        const r = tpPanel.getBoundingClientRect();
        tpPanel.style.left = r.left + "px";   // switch from the bottom-anchored CSS to free top/left
        tpPanel.style.top = r.top + "px";
        tpPanel.style.bottom = "auto";
        tpDX = e.clientX - r.left;
        tpDY = e.clientY - r.top;
        tpDragging = true;
        try { tpTitle.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    tpTitle.addEventListener("pointermove", (e) => {
        if (!tpDragging) return;
        const x = Math.max(0, Math.min(e.clientX - tpDX, window.innerWidth - tpPanel.offsetWidth));
        const y = Math.max(0, Math.min(e.clientY - tpDY, window.innerHeight - tpPanel.offsetHeight));
        tpPanel.style.left = x + "px";
        tpPanel.style.top = y + "px";
    });
    const tpEnd = (e) => { if (tpDragging) { tpDragging = false; try { tpTitle.releasePointerCapture(e.pointerId); } catch (_) {} } };
    tpTitle.addEventListener("pointerup", tpEnd);
    tpTitle.addEventListener("pointercancel", tpEnd);
}
// Title-bar [×] closes the panel; the toolbar "変換" button toggles it back.
const tpClose = document.getElementById("tp-close");
if (tpClose && tpPanel) tpClose.addEventListener("click", () => { tpPanel.hidden = true; });

// ---- Preview panel: floating (drag by title) + resizable (bottom-right grip) ----
const pvPanel = document.getElementById("preview-panel");
if (pvPanel) {
    const PV_MIN = 120, PV_MAX = 600;
    // Convert the initial right/bottom CSS anchor to free top/left so drag + resize
    // grow predictably (down-right) instead of fighting the right/bottom anchor.
    const unanchorPreview = () => {
        if (pvPanel.style.left) return;
        const r = pvPanel.getBoundingClientRect();
        pvPanel.style.left = r.left + "px"; pvPanel.style.top = r.top + "px";
        pvPanel.style.right = "auto"; pvPanel.style.bottom = "auto";
    };
    const pvTitle = pvPanel.querySelector(".pv-title");
    if (pvTitle) {
        let dx = 0, dy = 0, dragging = false;
        pvTitle.addEventListener("pointerdown", (e) => {
            if (e.target.closest("#pv-close")) return;
            unanchorPreview();
            const r = pvPanel.getBoundingClientRect();
            dx = e.clientX - r.left; dy = e.clientY - r.top; dragging = true;
            try { pvTitle.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        pvTitle.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const x = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - pvPanel.offsetWidth));
            const y = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - pvPanel.offsetHeight));
            pvPanel.style.left = x + "px"; pvPanel.style.top = y + "px";
        });
        const end = (e) => { if (dragging) { dragging = false; try { pvTitle.releasePointerCapture(e.pointerId); } catch (_) {} } };
        pvTitle.addEventListener("pointerup", end);
        pvTitle.addEventListener("pointercancel", end);
    }
    const pvGrip = pvPanel.querySelector(".pv-resize");
    if (pvGrip) {
        let startW = 0, startX = 0, startY = 0, resizing = false;
        pvGrip.addEventListener("pointerdown", (e) => {
            unanchorPreview();
            startW = pvPanel.offsetWidth; startX = e.clientX; startY = e.clientY; resizing = true;
            try { pvGrip.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault(); e.stopPropagation();
        });
        pvGrip.addEventListener("pointermove", (e) => {
            if (!resizing) return;
            const d = Math.max(e.clientX - startX, e.clientY - startY); // diagonal drag, square preview
            pvPanel.style.width = Math.max(PV_MIN, Math.min(startW + d, PV_MAX)) + "px";
            // keep on-screen: shift up-left if growing past an edge
            const r = pvPanel.getBoundingClientRect();
            if (r.right > window.innerWidth - 4) pvPanel.style.left = Math.max(4, window.innerWidth - 4 - r.width) + "px";
            if (r.bottom > window.innerHeight - 4) pvPanel.style.top = Math.max(4, window.innerHeight - 4 - r.height) + "px";
        });
        const end = (e) => { if (resizing) { resizing = false; try { pvGrip.releasePointerCapture(e.pointerId); } catch (_) {} } };
        pvGrip.addEventListener("pointerup", end);
        pvGrip.addEventListener("pointercancel", end);
    }
    const pvClose = document.getElementById("pv-close");
    if (pvClose) pvClose.addEventListener("click", () => { pvPanel.hidden = true; });
}

// ---- Capture ----
// Capturing renders each selected output type and saves it as {camera}_{type}.png
// (overwriting any existing file), then registers its path/metadata with the
// backend so the ComfyUI "VRM Scene Capture" node can pick it up by camera + type.
// Types so far: image (RGB), mask (white silhouette), depth (near=white),
// normal (view-space). canny/openpose come later.
// ---- カメラ設定 (camera1..9): 各カメラ = 表示モード(出力タイプ) + 含めるモデル ----
const OUTPUT_TYPES = ["image", "mask", "mask(hands)", "seg", "depth", "normal", "openpose(body)", "openpose(hands)", "openpose(body+hands)"];
const CAMERA_LIST = Array.from({ length: 9 }, (_, i) => `camera${i + 1}`);
const CAM_KEY = "vrmSceneEditor.cameras";
const CAM_ACTIVE_KEY = "vrmSceneEditor.activeCamera";
const cameraConfigs = {};
// 各カメラ = { enabled: 撮影対象か, types: 表示モード(複数), exclude: 除外モデルid }
for (const c of CAMERA_LIST) cameraConfigs[c] = { enabled: c === "camera1", types: ["image"], exclude: [] };
try {
    const s = JSON.parse(localStorage.getItem(CAM_KEY) || "null");
    if (s) for (const c of CAMERA_LIST) if (s[c]) {
        const o = s[c];
        cameraConfigs[c] = {
            enabled: typeof o.enabled === "boolean" ? o.enabled : (c === "camera1"),
            types: Array.isArray(o.types) ? o.types.filter((t) => OUTPUT_TYPES.includes(t))
                : (o.type && OUTPUT_TYPES.includes(o.type) ? [o.type] : ["image"]),
            exclude: Array.isArray(o.exclude) ? o.exclude : [],
        };
        if (!cameraConfigs[c].types.length) cameraConfigs[c].types = ["image"];
    }
} catch { /* defaults */ }
let activeCamera = CAMERA_LIST.includes(localStorage.getItem(CAM_ACTIVE_KEY)) ? localStorage.getItem(CAM_ACTIVE_KEY) : "camera1";
function saveCameras() { localStorage.setItem(CAM_KEY, JSON.stringify(cameraConfigs)); localStorage.setItem(CAM_ACTIVE_KEY, activeCamera); }
// プレビューで表示する表示モード（カメラの選択タイプ内から選ぶ）
let _previewType = "image";
function previewType() { return _previewType; }

const cameraSelect = document.getElementById("camera-select");
const cameraEnabled = document.getElementById("camera-enabled");
const cameraTypesBox = document.getElementById("camera-types");
const cameraModelsBox = document.getElementById("camera-models");
const previewCamera = document.getElementById("preview-camera");
const previewTypeSel = document.getElementById("preview-type");

// プレビューの表示モード選択肢を、アクティブカメラの選択タイプから作り直す
function rebuildPreviewTypeOptions() {
    if (!previewTypeSel) return;
    const types = cameraConfigs[activeCamera]?.types?.length ? cameraConfigs[activeCamera].types : ["image"];
    if (!types.includes(_previewType)) _previewType = types[0];
    previewTypeSel.innerHTML = "";
    for (const t of types) { const o = document.createElement("option"); o.value = t; o.textContent = t; previewTypeSel.appendChild(o); }
    previewTypeSel.value = _previewType;
}

const _fillSelect = (sel, items, val) => {
    if (!sel) return;
    sel.innerHTML = "";
    for (const v of items) { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); }
    sel.value = val;
};
function rebuildCameraTypeChecks() {
    if (!cameraTypesBox) return;
    cameraTypesBox.innerHTML = "";
    const sel = new Set(cameraConfigs[activeCamera].types);
    for (const t of OUTPUT_TYPES) {
        const label = document.createElement("label");
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = sel.has(t);
        cb.addEventListener("change", () => {
            const set = new Set(cameraConfigs[activeCamera].types);
            if (cb.checked) set.add(t); else set.delete(t);
            let types = OUTPUT_TYPES.filter((x) => set.has(x)); // 元の順序を維持
            if (!types.length) { types = ["image"]; rebuildCameraTypeChecks(); } // 最低1つ
            cameraConfigs[activeCamera].types = types;
            saveCameras(); rebuildPreviewTypeOptions(); renderFramePreview();
        });
        const span = document.createElement("span"); span.textContent = t;
        label.append(cb, span);
        cameraTypesBox.appendChild(label);
    }
}
function rebuildCameraModelChecks() {
    if (!cameraModelsBox) return;
    cameraModelsBox.innerHTML = "";
    if (!loadedModels.length) { cameraModelsBox.innerHTML = '<div class="cam-empty">モデルがありません</div>'; return; }
    const ex = new Set(cameraConfigs[activeCamera].exclude);
    for (const e of loadedModels) {
        const label = document.createElement("label");
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !ex.has(e.id);
        cb.addEventListener("change", () => {
            const set = new Set(cameraConfigs[activeCamera].exclude);
            if (cb.checked) set.delete(e.id); else set.add(e.id);
            cameraConfigs[activeCamera].exclude = [...set];
            saveCameras(); renderFramePreview();
        });
        const span = document.createElement("span"); span.textContent = e.name;
        label.append(cb, span);
        cameraModelsBox.appendChild(label);
    }
}
function syncCameraUI() {
    if (cameraSelect) cameraSelect.value = activeCamera;
    if (previewCamera) previewCamera.value = activeCamera;
    if (cameraEnabled) cameraEnabled.checked = !!cameraConfigs[activeCamera].enabled;
    rebuildCameraTypeChecks();
    rebuildPreviewTypeOptions();
    rebuildCameraModelChecks();
}
function setActiveCamera(cam) {
    if (!CAMERA_LIST.includes(cam)) return;
    activeCamera = cam;
    saveCameras(); syncCameraUI(); renderFramePreview();
}
// Hide models excluded from `cam` during a render; returns a restore fn.
function hideExcludedModels(cam) {
    const ex = new Set(cameraConfigs[cam]?.exclude || []);
    const saved = loadedModels.map((e) => [e.root, e.root.visible]);
    for (const e of loadedModels) e.root.visible = !ex.has(e.id) && e.visible !== false; // also honor 表示/非表示
    return () => { for (const [r, v] of saved) r.visible = v; };
}
// VRMs included in the active camera (for OpenPose, which draws per-VRM keypoints).
function cameraVRMs() {
    const ex = new Set(cameraConfigs[activeCamera]?.exclude || []);
    return loadedModels.filter((e) => e.vrm && e.vrm.humanoid && !ex.has(e.id)).map((e) => e.vrm);
}

_fillSelect(cameraSelect, CAMERA_LIST, activeCamera);
_fillSelect(previewCamera, CAMERA_LIST, activeCamera);
syncCameraUI();
if (cameraSelect) cameraSelect.addEventListener("change", () => setActiveCamera(cameraSelect.value));
if (previewCamera) previewCamera.addEventListener("change", () => setActiveCamera(previewCamera.value));
if (previewTypeSel) previewTypeSel.addEventListener("change", () => { _previewType = previewTypeSel.value; renderFramePreview(); });
if (cameraEnabled) cameraEnabled.addEventListener("change", () => {
    cameraConfigs[activeCamera].enabled = cameraEnabled.checked; saveCameras();
});

const MASK_BG = new THREE.Color(0x000000);

// Unlit white material for the "mask" type silhouette. DoubleSide so
// single-sided hair/cloth geometry doesn't leave holes.
const MASK_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

// "mask(hands)": white silhouette of the HANDS ONLY. A skinning shader keeps a
// vertex only if its dominant skin weight is a hand/finger bone (per-vertex
// `aHand` set at load by computeHandMaskAttr); everything else discards. Meshes
// without the attribute read aHand=0 (fully discarded). ShaderMaterial so the
// renderer auto-defines USE_SKINNING for SkinnedMesh (same as DEPTH_MATERIAL).
const HAND_MASK_MATERIAL = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        attribute float aHand;
        varying float vHand;
        void main() {
            vHand = aHand;
            #include <skinbase_vertex>
            #include <begin_vertex>
            #include <skinning_vertex>
            #include <project_vertex>
        }
    `,
    fragmentShader: `
        varying float vHand;
        void main() {
            if (vHand < 0.5) discard;
            gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
        }
    `,
});

// View-space normals as RGB. MeshNormalMaterial handles skinning automatically.
// DoubleSide: like depth, VRM cloth's inward/flipped normals would otherwise
// cull the near wall and show the back surface through. With DoubleSide,
// MeshNormalMaterial flips backface normals (gl_FrontFacing) so the nearest
// surface gets a correct camera-facing normal.
const NORMAL_MATERIAL = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

// "seg": 体と手を塗り分けるセグメンテーション。頂点の aHand（手ボーン支配=1）で
// 体色/手色を選ぶ。色はモデルごとに割り当て（uniformで差し替え、1体ずつ重ね描き）。
const SEG_MATERIAL = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uBody: { value: new THREE.Color(0.25, 0.5, 0.9) }, uHand: { value: new THREE.Color(0.6, 0.8, 1.0) } },
    vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        attribute float aHand;
        varying float vHand;
        void main() {
            vHand = aHand;
            #include <skinbase_vertex>
            #include <begin_vertex>
            #include <skinning_vertex>
            #include <project_vertex>
        }
    `,
    fragmentShader: `
        uniform vec3 uBody;
        uniform vec3 uHand;
        varying float vHand;
        void main() {
            gl_FragColor = vec4(vHand > 0.5 ? uHand : uBody, 1.0);
        }
    `,
});
// モデル順 i に色相を割り当て、体=濃いめ/手=明るめ。色数=含めるモデル数×2。
const _segBody = new THREE.Color(), _segHand = new THREE.Color();
function segColors(i) {
    const hue = ((i * 137.508) % 360) / 360; // ゴールデンアングルで被りにくく
    _segBody.setHSL(hue, 0.62, 0.42);
    _segHand.setHSL(hue, 0.85, 0.66);
    return { body: _segBody, hand: _segHand };
}
// 現在表示中（カメラの「含めるモデル」で可視）のモデルを1体ずつ、それぞれの体色/手色で
// 重ね描きする。深度は一度だけクリアして以降ためるので、前後の隠れも正しく出る。
function renderSeg() {
    const entries = loadedModels.filter((e) => e.root.visible); // 含める=可視（呼び出し側で適用済み）
    scene.overrideMaterial = SEG_MATERIAL;
    scene.background = null;
    grid.visible = false;
    renderer.setClearColor(0x000000, 1);
    const prevVis = loadedModels.map((e) => e.root.visible);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clear();
    entries.forEach((e, i) => {
        const c = segColors(i);
        SEG_MATERIAL.uniforms.uBody.value.copy(c.body);
        SEG_MATERIAL.uniforms.uHand.value.copy(c.hand);
        for (const x of loadedModels) x.root.visible = (x === e); // この1体だけ描く
        renderer.render(scene, camera);
    });
    renderer.autoClear = prevAutoClear;
    loadedModels.forEach((e, idx) => { e.root.visible = prevVis[idx]; });
}

// Linear-depth material, normalized over [uNear, uFar] with near=white
// (midas-style). Uses three's skinning chunks so posed/skinned meshes deform
// correctly (ShaderMaterial gets USE_SKINNING auto-defined for SkinnedMesh).
const DEPTH_MATERIAL = new THREE.ShaderMaterial({
    // DoubleSide: depth only cares about position, and VRM cloth often has
    // inward/flipped normals -- FrontSide would cull the near wall and let the
    // far (back) surface show through. Both walls drawn => depthTest keeps the
    // nearest, killing the see-through.
    side: THREE.DoubleSide,
    uniforms: { uNear: { value: 0.1 }, uFar: { value: 100.0 } },
    vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        varying float vViewZ;
        void main() {
            #include <skinbase_vertex>
            #include <begin_vertex>
            #include <skinning_vertex>
            #include <project_vertex>
            vViewZ = -mvPosition.z;
        }
    `,
    fragmentShader: `
        uniform float uNear;
        uniform float uFar;
        varying float vViewZ;
        void main() {
            float d = clamp((vViewZ - uNear) / max(1e-6, uFar - uNear), 0.0, 1.0);
            gl_FragColor = vec4(vec3(1.0 - d), 1.0); // near = white, far = black
        }
    `,
});

// Set the depth material's normalization range to the model's *actual depth
// extent along the camera's view axis* so the gradient fills the full 0..1
// range. (Using the bounding-sphere diameter -- sized by the figure's height --
// wastes most of the range on a thin subject, giving washed-out depth.)
const _depthCorner = new THREE.Vector3();
function updateDepthRange() {
    let near = camera.near;
    let far = camera.far;
    if (currentModel) {
        camera.updateMatrixWorld();
        const box = new THREE.Box3().setFromObject(currentModel);
        let minD = Infinity;
        let maxD = -Infinity;
        for (let i = 0; i < 8; i++) {
            _depthCorner
                .set(
                    i & 1 ? box.max.x : box.min.x,
                    i & 2 ? box.max.y : box.min.y,
                    i & 4 ? box.max.z : box.min.z,
                )
                .applyMatrix4(camera.matrixWorldInverse);
            const d = -_depthCorner.z; // view-space depth, positive in front
            if (d < minD) minD = d;
            if (d > maxD) maxD = d;
        }
        if (maxD > minD) {
            near = Math.max(0.001, minD);
            far = maxD;
        }
    }
    DEPTH_MATERIAL.uniforms.uNear.value = near;
    DEPTH_MATERIAL.uniforms.uFar.value = far;
}

// ---- openpose(body) ----------------------------------------------------
// Ground-truth 2D pose by projecting the VRM humanoid's actual bones through
// the capture camera (no neural estimator). Standard OpenPose COCO-18 colors +
// limb topology so ControlNet's openpose model reads it. Head keypoints
// (nose/eyes/ears) are intentionally omitted -- body only.
const OP_COLORS = [
    [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
    [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
    [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];
// [cocoA, cocoB, limbColorIndex] -- full controlnet_aux limb order (body + head).
const OP_BODY_LIMBS = [
    [1, 2, 0], [1, 5, 1], [2, 3, 2], [3, 4, 3], [5, 6, 4], [6, 7, 5],
    [1, 8, 6], [8, 9, 7], [9, 10, 8], [1, 11, 9], [11, 12, 10], [12, 13, 11],
    [1, 0, 12], [0, 14, 13], [14, 16, 14], [0, 15, 15], [15, 17, 16],
];
// COCO body index -> VRM humanoid bone (subject's R/L == VRM R/L).
const OP_COCO_TO_VRM = {
    2: "rightUpperArm", 3: "rightLowerArm", 4: "rightHand",
    5: "leftUpperArm", 6: "leftLowerArm", 7: "leftHand",
    8: "rightUpperLeg", 9: "rightLowerLeg", 10: "rightFoot",
    11: "leftUpperLeg", 12: "leftLowerLeg", 13: "leftFoot",
};

// Synthesized head offsets (x neck-length). Eyes use leftEye/rightEye bones when
// the model has them; nose & ears have no VRM bones so are derived from the head
// bone + facing direction (approximate, but enough for ControlNet head orientation).
const OP_HEAD = { eyeSep: 0.18, noseFwd: 0.22, noseDown: 0.22, earSide: 0.45, earBack: 0.30, earUp: -0.05 };

// Ground-truth head keypoints from the face mesh (VRoid-structured models).
// nose/eyes/ears have no humanoid bones, so the body openpose synthesized them
// from offsets. When the model exposes material-named face submeshes we read the
// REAL positions: eyes = iris-material centroids (split L/R by world-x), nose =
// most-forward face-skin vertex, ears = lateral face-skin extremes at eye height
// (a clean max|x| bump there; hair is a SEPARATE mesh so it never contaminates).
// Points are baked to head-bone-local ONCE at load (rest pose) and re-evaluated
// through head.matrixWorld each frame -> tracks head pose, no per-vertex skinning.
// Leaves headFeat=null (falls back to synthesis) when the submeshes aren't found.
// Per-model baked head features (nose/eyes/ears). WeakMap keyed by the VRM so
// each model keeps its own (a VRM instance has no reliable .userData).
const _headFeats = new WeakMap();

// Shared: locate VRoid-style face submeshes by material name.
function findFaceMeshes(vrm) {
    const r = { iris: [], eyeline: [], brow: [], mouth: [], skin: [] };
    vrm.scene.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const nm = mats.map((m) => m?.name || "").join(" ");
        if (/iris/i.test(nm)) r.iris.push(o);
        if (/eyeline|eyelash|lash/i.test(nm)) r.eyeline.push(o);
        if (/brow/i.test(nm)) r.brow.push(o);
        if (/mouth|lip/i.test(nm)) r.mouth.push(o);
        if (/face.*skin/i.test(nm)) r.skin.push(o);
    });
    return r;
}

function computeHeadFeatures(vrm) {
    if (vrm) _headFeats.set(vrm, null); // per-model (global headFeat broke multi-model openpose heads)
    const head = vrm?.humanoid?.getRawBoneNode("head");
    if (!head) return;
    vrm.scene.updateMatrixWorld(true);

    const fm = findFaceMeshes(vrm);
    const irisMeshes = fm.iris, skinMeshes = fm.skin;
    if (!irisMeshes.length || !skinMeshes.length) return; // not VRoid-structured

    const tmp = new THREE.Vector3();
    // eyes: iris vertex centroids, split by world x (+x = subject's left).
    let lx = 0, ly = 0, lz = 0, ln = 0, rx = 0, ry = 0, rz = 0, rn = 0;
    for (const mesh of irisMeshes) {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            if (tmp.x >= 0) { lx += tmp.x; ly += tmp.y; lz += tmp.z; ln++; }
            else { rx += tmp.x; ry += tmp.y; rz += tmp.z; rn++; }
        }
    }
    if (!ln || !rn) return;
    const eyeL = new THREE.Vector3(lx / ln, ly / ln, lz / ln); // +x subject LEFT  -> COCO15
    const eyeR = new THREE.Vector3(rx / rn, ry / rn, rz / rn); // -x subject RIGHT -> COCO14
    const eyeY = (eyeL.y + eyeR.y) / 2;

    // face skin: nose = most-forward (+z); ears = lateral extremes near eye height.
    const band = 0.02; // +/-2cm in y around the eye line for the ear search
    let nose = null, noseZ = -Infinity, maxXL = 0, maxXR = 0;
    for (const mesh of skinMeshes) {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            if (tmp.z > noseZ) { noseZ = tmp.z; nose = tmp.clone(); }
            if (Math.abs(tmp.y - eyeY) <= band) {
                if (tmp.x > maxXL) maxXL = tmp.x;
                if (-tmp.x > maxXR) maxXR = -tmp.x;
            }
        }
    }
    const tol = 0.006; // cluster within 6mm of the extreme = the ear
    let elx = 0, ely = 0, elz = 0, eln = 0, erx = 0, ery = 0, erz = 0, ern = 0;
    for (const mesh of skinMeshes) {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            if (Math.abs(tmp.y - eyeY) > band) continue;
            if (maxXL - tmp.x >= 0 && maxXL - tmp.x < tol) { elx += tmp.x; ely += tmp.y; elz += tmp.z; eln++; }
            if (maxXR + tmp.x >= 0 && maxXR + tmp.x < tol) { erx += tmp.x; ery += tmp.y; erz += tmp.z; ern++; }
        }
    }
    const earL = eln ? new THREE.Vector3(elx / eln, ely / eln, elz / eln) : null; // +x -> COCO17
    const earR = ern ? new THREE.Vector3(erx / ern, ery / ern, erz / ern) : null; // -x -> COCO16

    const headInv = head.matrixWorld.clone().invert();
    const toLocal = (p) => (p ? p.applyMatrix4(headInv) : null);
    _headFeats.set(vrm, {
        eyeL: toLocal(eyeL), eyeR: toLocal(eyeR), nose: toLocal(nose),
        earL: toLocal(earL), earR: toLocal(earR),
    });
}

// Re-evaluate this model's baked head-local points through its current head pose.
function headFeatWorld(vrm) {
    const hf = vrm ? _headFeats.get(vrm) : null;
    if (!hf) return null;
    const head = vrm?.humanoid?.getRawBoneNode("head");
    if (!head) return null;
    const m = head.matrixWorld;
    const w = (p) => (p ? p.clone().applyMatrix4(m) : null);
    return {
        eyeL: w(hf.eyeL), eyeR: w(hf.eyeR), nose: w(hf.nose),
        earL: w(hf.earL), earR: w(hf.earR),
    };
}

// For mask(hands): tag each vertex with aHand=1 when the sum of its skin weights
// on hand/finger bones (incl. the wrist) exceeds 0.5, else 0. HAND_MASK_MATERIAL
// then renders only those. Hands aren't a separate material in VRM, so this skin-
// weight test is how we isolate them. Runs once at load on every skinned mesh.
function computeHandMaskAttr(vrm) {
    const h = vrm?.humanoid;
    if (!h) return;
    const names = OP_HAND_BONES.left.concat(OP_HAND_BONES.right); // wrists + all finger bones
    const handSet = new Set();
    for (const nm of names) { const b = h.getRawBoneNode(nm); if (b) handSet.add(b); }
    if (!handSet.size) return;
    vrm.scene.traverse((o) => {
        if (!o.isSkinnedMesh || !o.skeleton) return;
        const g = o.geometry;
        const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
        if (!si || !sw) return;
        const isHand = o.skeleton.bones.map((b) => handSet.has(b));
        const n = si.count;
        const arr = new Float32Array(n);
        for (let v = 0; v < n; v++) {
            let s = 0;
            if (isHand[si.getX(v)]) s += sw.getX(v);
            if (isHand[si.getY(v)]) s += sw.getY(v);
            if (isHand[si.getZ(v)]) s += sw.getZ(v);
            if (isHand[si.getW(v)]) s += sw.getW(v);
            arr[v] = s > 0.5 ? 1 : 0;
        }
        g.setAttribute("aHand", new THREE.BufferAttribute(arr, 1));
    });
}

function opAddHead(W, vrm) {
    const humanoid = vrm.humanoid;
    const head = humanoid.getRawBoneNode("head");
    if (!head) return;

    // Ground-truth nose/eyes/ears from the face mesh when available (VRoid);
    // otherwise fall through to the synthesized offsets below.
    const hf = headFeatWorld(vrm);
    if (hf && hf.nose && hf.eyeL && hf.eyeR) {
        W[0] = hf.nose;
        W[14] = hf.eyeR;               // subject's right eye (-x)
        W[15] = hf.eyeL;               // subject's left eye (+x)
        if (hf.earR) W[16] = hf.earR;  // subject's right ear (-x)
        if (hf.earL) W[17] = hf.earL;  // subject's left ear (+x)
        return;
    }

    const lookAt = vrm.lookAt;
    let eyeC, fwd, up, right;
    if (lookAt) {
        // VRM lookAt: authored eye viewpoint + facing direction (includes faceFront,
        // follows head pose) -- a non-bone, model-defined source. Build a head frame.
        eyeC = lookAt.getLookAtWorldPosition(new THREE.Vector3());
        fwd = lookAt.getLookAtWorldDirection(new THREE.Vector3()).normalize();
        right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    } else {
        // fallback: head bone + world axes (model faces +Z), "right" from shoulders
        const hp = head.getWorldPosition(new THREE.Vector3());
        fwd = new THREE.Vector3(0, 0, 1);
        up = new THREE.Vector3(0, 1, 0);
        right = new THREE.Vector3(-1, 0, 0);
        if (W[2] && W[5]) right.copy(W[2]).sub(W[5]).normalize();
        const s0 = W[1] ? Math.max(0.05, hp.distanceTo(W[1])) : 0.12;
        eyeC = hp.addScaledVector(fwd, 0.55 * s0).addScaledVector(up, 0.5 * s0);
    }
    const s = W[1] ? Math.max(0.05, eyeC.distanceTo(W[1])) : 0.13; // ~neck length as scale

    // eyes: real bones if present (most accurate per-eye), else from the frame
    const lEye = humanoid.getRawBoneNode("leftEye");
    const rEye = humanoid.getRawBoneNode("rightEye");
    if (lEye && rEye) {
        W[15] = lEye.getWorldPosition(new THREE.Vector3());
        W[14] = rEye.getWorldPosition(new THREE.Vector3());
    } else {
        W[14] = eyeC.clone().addScaledVector(right, OP_HEAD.eyeSep * s);
        W[15] = eyeC.clone().addScaledVector(right, -OP_HEAD.eyeSep * s);
    }
    W[0] = eyeC.clone().addScaledVector(fwd, OP_HEAD.noseFwd * s).addScaledVector(up, -OP_HEAD.noseDown * s);
    W[16] = eyeC.clone().addScaledVector(right, OP_HEAD.earSide * s).addScaledVector(fwd, -OP_HEAD.earBack * s).addScaledVector(up, OP_HEAD.earUp * s);
    W[17] = eyeC.clone().addScaledVector(right, -OP_HEAD.earSide * s).addScaledVector(fwd, -OP_HEAD.earBack * s).addScaledVector(up, OP_HEAD.earUp * s);
}

function opBodyKeypointsWorld(vrm) {
    const humanoid = vrm.humanoid;
    const W = new Array(18).fill(null);
    for (const coco in OP_COCO_TO_VRM) {
        const node = humanoid.getRawBoneNode(OP_COCO_TO_VRM[coco]);
        if (node) W[coco] = node.getWorldPosition(new THREE.Vector3());
    }
    if (W[2] && W[5]) W[1] = W[2].clone().add(W[5]).multiplyScalar(0.5); // neck = shoulder midpoint
    opAddHead(W, vrm);
    return W;
}

function opProject(W, res) {
    return W.map((p) => {
        if (!p) return null;
        const v = p.clone().project(camera);
        return [(v.x * 0.5 + 0.5) * res, (1 - (v.y * 0.5 + 0.5)) * res];
    });
}

function opDraw(ctx, P, res) {
    const unit = Math.max(2, (res / 512) * 4);
    for (const [a, b, ci] of OP_BODY_LIMBS) {
        const pa = P[a], pb = P[b];
        if (!pa || !pb) continue;
        const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
        const len = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
        const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
        const c = OP_COLORS[ci];
        ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
        ctx.beginPath(); ctx.ellipse(0, 0, len / 2, unit, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill(); ctx.restore();
    }
    for (let i = 0; i <= 17; i++) {
        const p = P[i]; if (!p) continue;
        const c = OP_COLORS[i];
        ctx.beginPath(); ctx.arc(p[0], p[1], unit, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill();
    }
}

// Projects the humanoid body bones through the capture camera (same FOV framing
// as the other types) and draws the OpenPose body skeleton on black -> data URL.
function renderOpenPoseBodyDataURL(res) {
    const canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, res, res);

    const vrms = cameraVRMs();
    if (!vrms.length || !frameSide) return canvas.toDataURL("image/png");

    // Match renderTypeDataURL's framing: narrow the FOV to the on-screen guide square.
    const savedFov = camera.fov;
    const savedAspect = camera.aspect;
    const frac = frameSide / viewport.clientHeight;
    const vfov = THREE.MathUtils.degToRad(savedFov);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(frac * Math.tan(vfov / 2)));
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    try {
        for (const vrm of vrms) opDraw(ctx, opProject(opBodyKeypointsWorld(vrm), res), res);
    } finally {
        camera.fov = savedFov;
        camera.aspect = savedAspect;
        camera.updateProjectionMatrix();
    }
    return canvas.toDataURL("image/png");
}

// ---- openpose(hands) --------------------------------------------------
// Ground-truth 21-pt OpenPose hands by projecting the VRM finger bones (no
// neural estimator -- beats DWPose's flaky hand detection). VRM humanoid has
// every finger joint as a bone, and VRoid adds an `_end` child on each distal
// bone = the fingertip. 21 OpenPose order: 0 wrist, then thumb/index/middle/
// ring/little as 4 pts each (base, 2 joints, tip). Standard rainbow-per-edge
// coloring + keypoint dots, matching controlnet_aux's draw_handpose.
const OP_HAND_BONES = {
    left: ["leftHand", "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
        "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
        "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
        "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
        "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal"],
    right: ["rightHand", "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
        "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
        "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
        "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
        "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal"],
};
const OP_HAND_JOINT_IDX = [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19]; // bone -> OP idx
const OP_HAND_DISTAL = [3, 6, 9, 12, 15];        // bone-array indices of the 5 distal bones
const OP_HAND_TIP_IDX = [4, 8, 12, 16, 20];      // OP indices of the 5 fingertips
const OP_HAND_DISTAL_OPIDX = [3, 7, 11, 15, 19]; // OP indices of the 5 distal joints
const OP_HAND_EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10],
    [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20],
];

function hsv2rgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function opHandKeypointsWorld(vrm, side) {
    const h = vrm.humanoid;
    const names = OP_HAND_BONES[side];
    const W = new Array(21).fill(null);
    for (let i = 0; i < names.length; i++) {
        const node = h.getRawBoneNode(names[i]);
        if (node) W[OP_HAND_JOINT_IDX[i]] = node.getWorldPosition(new THREE.Vector3());
    }
    for (let f = 0; f < 5; f++) {
        const dn = h.getRawBoneNode(names[OP_HAND_DISTAL[f]]);
        const tipI = OP_HAND_TIP_IDX[f], dOp = OP_HAND_DISTAL_OPIDX[f];
        if (dn && dn.children.length) {
            const end = dn.children.find((c) => /_end$/i.test(c.name)) || dn.children[0];
            W[tipI] = end.getWorldPosition(new THREE.Vector3());
        } else if (W[dOp] && W[dOp - 1]) {
            W[tipI] = W[dOp].clone().add(W[dOp].clone().sub(W[dOp - 1])); // extrapolate the tip
        }
    }
    return W;
}

function opDrawHand(ctx, P, res) {
    ctx.lineWidth = Math.max(1, (res / 512) * 2);
    OP_HAND_EDGES.forEach((e, ie) => {
        const a = P[e[0]], b = P[e[1]];
        if (!a || !b) return;
        const c = hsv2rgb(ie / OP_HAND_EDGES.length, 1, 1);
        ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    });
    const dotR = Math.max(1.5, (res / 512) * 3);
    ctx.fillStyle = "rgb(0,0,255)";
    for (const p of P) {
        if (!p) continue;
        ctx.beginPath(); ctx.arc(p[0], p[1], dotR, 0, Math.PI * 2); ctx.fill();
    }
}

function renderOpenPoseHandsDataURL(res) {
    const canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, res, res);

    const vrms = cameraVRMs();
    if (!vrms.length || !frameSide) return canvas.toDataURL("image/png");
    const savedFov = camera.fov;
    const savedAspect = camera.aspect;
    const frac = frameSide / viewport.clientHeight;
    const vfov = THREE.MathUtils.degToRad(savedFov);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(frac * Math.tan(vfov / 2)));
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    try {
        for (const vrm of vrms) {
            opDrawHand(ctx, opProject(opHandKeypointsWorld(vrm, "left"), res), res);
            opDrawHand(ctx, opProject(opHandKeypointsWorld(vrm, "right"), res), res);
        }
    } finally {
        camera.fov = savedFov;
        camera.aspect = savedAspect;
        camera.updateProjectionMatrix();
    }
    return canvas.toDataURL("image/png");
}

// ---- openpose(body+hands) ---------------------------------------------
// Union of the body and hands passes on one black canvas: body skeleton first,
// then both hands on top -- for ControlNet openpose models that want the full
// pose (body + fingers) in a single conditioning image.
function renderOpenPoseBodyHandsDataURL(res) {
    const canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, res, res);

    const vrms = cameraVRMs();
    if (!vrms.length || !frameSide) return canvas.toDataURL("image/png");
    const savedFov = camera.fov;
    const savedAspect = camera.aspect;
    const frac = frameSide / viewport.clientHeight;
    const vfov = THREE.MathUtils.degToRad(savedFov);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(frac * Math.tan(vfov / 2)));
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    try {
        for (const vrm of vrms) {
            opDraw(ctx, opProject(opBodyKeypointsWorld(vrm), res), res);
            opDrawHand(ctx, opProject(opHandKeypointsWorld(vrm, "left"), res), res);
            opDrawHand(ctx, opProject(opHandKeypointsWorld(vrm, "right"), res), res);
        }
    } finally {
        camera.fov = savedFov;
        camera.aspect = savedAspect;
        camera.updateProjectionMatrix();
    }
    return canvas.toDataURL("image/png");
}

// Renders one output type to a res×res PNG and returns its data URL, restoring
// all render state (and redrawing the normal view) before returning.
function renderTypeDataURL(type, res, transparent) {
    if (type === "openpose(body)") return renderOpenPoseBodyDataURL(res);
    if (type === "openpose(hands)") return renderOpenPoseHandsDataURL(res);
    if (type === "openpose(body+hands)") return renderOpenPoseBodyHandsDataURL(res);
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    const saved = {
        pixelRatio: renderer.getPixelRatio(),
        aspect: camera.aspect,
        fov: camera.fov,
        background: scene.background,
        clearColor: renderer.getClearColor(new THREE.Color()),
        clearAlpha: renderer.getClearAlpha(),
        gridVisible: grid.visible,
        floorVisible: studioFloor.visible,
        overrideMaterial: scene.overrideMaterial,
    };

    let dataURL;
    try {
        setEditVisible(false); // keep control spheres out of every rendered output
        studioFloor.visible = false; // ground shadow is presentation-only, never in captures
        // The on-screen square spans frameSide/h of the camera's vertical view.
        // A 1:1 camera with a FOV covering that fraction frames the PNG to match
        // the guide exactly (square screen pixels => square world region).
        const frac = frameSide / h;
        const vfov = THREE.MathUtils.degToRad(saved.fov);
        camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(frac * Math.tan(vfov / 2)));
        camera.aspect = 1;
        camera.updateProjectionMatrix();

        // mask/depth/normal force a flat override material on every mesh (incl.
        // skinned), black background, no grid, opaque -- the transparent toggle
        // only applies to the plain "image" type.
        if (type === "mask") {
            scene.overrideMaterial = MASK_MATERIAL;
            scene.background = MASK_BG;
            grid.visible = false;
            renderer.setClearColor(0x000000, 1);
        } else if (type === "mask(hands)") {
            scene.overrideMaterial = HAND_MASK_MATERIAL;
            scene.background = MASK_BG;
            grid.visible = false;
            renderer.setClearColor(0x000000, 1);
        } else if (type === "depth") {
            updateDepthRange();
            scene.overrideMaterial = DEPTH_MATERIAL;
            scene.background = MASK_BG;
            grid.visible = false;
            renderer.setClearColor(0x000000, 1);
        } else if (type === "normal") {
            scene.overrideMaterial = NORMAL_MATERIAL;
            scene.background = MASK_BG;
            grid.visible = false;
            renderer.setClearColor(0x000000, 1);
        } else if (type === "seg") {
            grid.visible = false; // 残り（override/bg/累積描画）は renderSeg() が担当
        } else if (transparent) {
            scene.background = null;
            grid.visible = false;
            renderer.setClearColor(0x000000, 0);
        } else if (refImageActive) {
            // opaque "image" while the 背景画像 underlay is live: use the normal bg, never the reference
            scene.background = studioLook ? studioBG : darkBG;
            renderer.setClearColor(0x000000, 1);
        }

        // Render to a res×res drawing buffer (pixelRatio 1 = exact size). CSS size
        // is left untouched (updateStyle=false), and we restore + redraw before
        // yielding, so the on-screen canvas never visibly flickers.
        renderer.setPixelRatio(1);
        renderer.setSize(res, res, false);
        if (type === "seg") renderSeg(); // 含めるモデルを1体ずつ体色/手色で重ね描き
        else renderCapture(); // "image" -> bake bloom/grade in; mask/depth/normal render raw (override material set)
        dataURL = renderer.domElement.toDataURL("image/png");
    } finally {
        scene.overrideMaterial = saved.overrideMaterial;
        scene.background = saved.background;
        grid.visible = saved.gridVisible;
        studioFloor.visible = saved.floorVisible;
        renderer.setClearColor(saved.clearColor, saved.clearAlpha);
        camera.fov = saved.fov;
        camera.aspect = saved.aspect;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(saved.pixelRatio);
        renderer.setSize(w, h, false);
        setEditVisible(boneEditEnabled);
        renderer.render(scene, camera);
    }
    return dataURL;
}

// ---- Bottom-right composite preview ----
// Shows the "image" within the capture frame, with the combo-selected type
// composited on top (alignment check). Renders at low res into previewCanvas and
// fully restores render state -- the main view re-render is left to animate().
const PREVIEW_RES = 256;
let _pvFrame = 0;

function renderFramePreview() {
    if (frameSide === 0 || !previewCtx) return;
    const type = previewType();
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    const saved = {
        pixelRatio: renderer.getPixelRatio(),
        aspect: camera.aspect,
        fov: camera.fov,
        background: scene.background,
        clearColor: renderer.getClearColor(new THREE.Color()),
        clearAlpha: renderer.getClearAlpha(),
        gridVisible: grid.visible,
        floorVisible: studioFloor.visible,
        overrideMaterial: scene.overrideMaterial,
    };
    let restoreModels = null;
    try {
        setEditVisible(false); // control spheres must not appear in the preview
        studioFloor.visible = false; // ground shadow is presentation-only
        restoreModels = hideExcludedModels(activeCamera); // このカメラに含めるモデルのみ描画
        // Match the capture framing (narrow FOV to the on-screen square).
        const frac = frameSide / h;
        const vfov = THREE.MathUtils.degToRad(saved.fov);
        camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(frac * Math.tan(vfov / 2)));
        camera.aspect = 1;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(1);
        renderer.setSize(PREVIEW_RES, PREVIEW_RES, false);

        // Render exactly what this camera's 表示モード captures.
        previewCtx.globalAlpha = 1.0;
        previewCtx.globalCompositeOperation = "source-over";
        previewCtx.clearRect(0, 0, PREVIEW_RES, PREVIEW_RES);
        if (type === "openpose(body)" || type === "openpose(hands)" || type === "openpose(body+hands)") {
            previewCtx.fillStyle = "#000"; // skeleton on black, as captured
            previewCtx.fillRect(0, 0, PREVIEW_RES, PREVIEW_RES);
            camera.updateMatrixWorld();
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
            for (const vrm of cameraVRMs()) {
                if (type !== "openpose(hands)") opDraw(previewCtx, opProject(opBodyKeypointsWorld(vrm), PREVIEW_RES), PREVIEW_RES);
                if (type !== "openpose(body)") {
                    opDrawHand(previewCtx, opProject(opHandKeypointsWorld(vrm, "left"), PREVIEW_RES), PREVIEW_RES);
                    opDrawHand(previewCtx, opProject(opHandKeypointsWorld(vrm, "right"), PREVIEW_RES), PREVIEW_RES);
                }
            }
        } else if (type === "mask" || type === "mask(hands)" || type === "depth" || type === "normal") {
            if (type === "mask") scene.overrideMaterial = MASK_MATERIAL;
            else if (type === "mask(hands)") scene.overrideMaterial = HAND_MASK_MATERIAL;
            else if (type === "depth") { updateDepthRange(); scene.overrideMaterial = DEPTH_MATERIAL; }
            else scene.overrideMaterial = NORMAL_MATERIAL;
            scene.background = MASK_BG;
            grid.visible = false;
            renderer.setClearColor(0x000000, 1);
            renderer.render(scene, camera);
            previewCtx.drawImage(renderer.domElement, 0, 0, PREVIEW_RES, PREVIEW_RES);
        } else if (type === "seg") {
            renderSeg(); // 含めるモデルを1体ずつ体色/手色で重ね描き
            previewCtx.drawImage(renderer.domElement, 0, 0, PREVIEW_RES, PREVIEW_RES);
        } else {
            scene.overrideMaterial = null; // image (RGB)
            renderer.render(scene, camera);
            previewCtx.drawImage(renderer.domElement, 0, 0, PREVIEW_RES, PREVIEW_RES);
        }
    } finally {
        if (restoreModels) restoreModels();
        scene.overrideMaterial = saved.overrideMaterial;
        scene.background = saved.background;
        grid.visible = saved.gridVisible;
        studioFloor.visible = saved.floorVisible;
        renderer.setClearColor(saved.clearColor, saved.clearAlpha);
        camera.fov = saved.fov;
        camera.aspect = saved.aspect;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(saved.pixelRatio);
        renderer.setSize(w, h, false);
        setEditVisible(boneEditEnabled);
    }
}

// Persist the save folder; show the backend default folder. (Camera is the
// camera1..9 selector handled by the camera-config block above.)
const FOLDER_KEY = "vrmSceneEditor.saveFolder";
saveFolderInput.value = localStorage.getItem(FOLDER_KEY) || "";
saveFolderInput.addEventListener("change", () => {
    localStorage.setItem(FOLDER_KEY, saveFolderInput.value.trim());
});
fetch("/vrm-scene-editor/default-folder")
    .then((r) => r.json())
    .then((d) => { if (d.folder) saveFolderInput.placeholder = `(既定: ${d.folder})`; })
    .catch(() => {});

let capturing = false;

async function captureType(type, res, transparent, folder, cameraName) {
    const dataURL = renderTypeDataURL(type, res, transparent);
    const resp = await fetch("/vrm-scene-editor/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataURL, folder, camera: cameraName, type }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || resp.status);
    return result;
}

async function capture() {
    if (capturing || frameSide === 0) return;

    // 有効なカメラを撮影対象とする（各カメラ = 表示モード(複数) + 含めるモデル）
    const targets = CAMERA_LIST.filter((c) => cameraConfigs[c].enabled && cameraConfigs[c].types.length);
    if (targets.length === 0) {
        showToast("有効なカメラがありません（カメラ設定で有効化してください）", "error");
        return;
    }

    capturing = true;
    captureBtn.disabled = true;

    const res = parseInt(captureResSelect.value, 10) || 1024;
    const transparent = transparentBgInput.checked;
    const folder = saveFolderInput.value.trim();
    const savedActive = activeCamera;

    const done = [];
    const failed = [];
    try {
        for (const cam of targets) {
            activeCamera = cam; // renderTypeDataURL は cameraVRMs()=activeCamera を参照するため切替
            const restoreModels = hideExcludedModels(cam); // このカメラに含めるモデルのみ撮影
            try {
                for (const type of cameraConfigs[cam].types) {
                    setStatus(`撮影中 (${cam}/${type}) ...`);
                    try {
                        const result = await captureType(type, res, transparent, folder, cam);
                        done.push(result);
                        showToast(`📷 [${result.camera}/${result.type}] 保存＆転送`, "success");
                    } catch (err) {
                        const msg = err?.message || err;
                        failed.push(`${cam}/${type}: ${msg}`);
                        showToast(`保存エラー [${cam}/${type}]: ${msg}`, "error");
                    }
                }
            } finally {
                restoreModels();
            }
        }
    } finally {
        activeCamera = savedActive;
        capturing = false;
        captureBtn.disabled = false;
    }

    const okList = done.map((r) => `${r.camera}/${r.type}`).join(", ") || "なし";
    setStatus(
        `保存＆転送: ${okList}` +
        (failed.length ? ` / エラー: ${failed.join(" / ")}` : ""),
    );
}

captureBtn.addEventListener("click", capture);

// ---- Capture frame (centered square guide) ----
// Fixed square: 80% of the smaller viewport dimension. `frameSide` and the
// viewport height drive the capture FOV so the saved PNG matches the guide.
const FRAME_FRACTION = 0.8;
let frameSide = 0;

function layoutFrame() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    frameSide = Math.round(Math.min(w, h) * FRAME_FRACTION);
    captureFrame.style.width = `${frameSide}px`;
    captureFrame.style.height = `${frameSide}px`;
}

// ---- Resize ----
function resize() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    layoutFrame();
}
window.addEventListener("resize", resize);
resize();

// ---- Render loop ----
// ---- Gaze: camera / center ball (左右連動 ON) / per-eye balls (左右連動 OFF) ----
// Camera & center modes use the built-in vrm.lookAt; per-eye mode disables it and
// aims each raw eye bone manually (applyEyeAim), run after vrm.update() each frame.
function updateGazeVisibility(base) {
    if (!gazeCtrl) return;
    if (base === undefined) base = boneEditEnabled;
    const show = base && !cameraGaze;          // hidden entirely when the eyes track the camera
    gazeCtrl.ball.visible = show && eyesLinked;
    if (gazeCtrl.ballL) gazeCtrl.ballL.visible = show && !eyesLinked;
    if (gazeCtrl.ballR) gazeCtrl.ballR.visible = show && !eyesLinked;
}
function applyGazeTarget() {
    if (!currentVRM || !currentVRM.lookAt) return;
    const la = currentVRM.lookAt;
    const perEye = !cameraGaze && !eyesLinked && gazeCtrl && gazeCtrl.lEye && gazeCtrl.rEye;
    if (perEye) {                 // built-in lookAt off; applyEyeAim drives each eye toward its ball
        la.autoUpdate = false; la.target = null;
    } else {                      // camera, or single center ball for both eyes
        la.autoUpdate = true;
        la.target = cameraGaze ? camera : (gazeCtrl ? gazeCtrl.ball : null);
    }
    updateGazeVisibility();
}
function setCameraGaze(on) {
    cameraGaze = on;
    localStorage.setItem(CAMERA_GAZE_KEY, on ? "1" : "0");
    if (cameraGazeInput) cameraGazeInput.checked = on;   // keep 設定 panel checkbox in sync
    if (gazePanelCheck) gazePanelCheck.checked = on;      // keep 目の動き checkbox in sync
    applyGazeTarget();
}
function setEyesLinked(on) {
    eyesLinked = on;
    localStorage.setItem(EYES_LINKED_KEY, on ? "1" : "0");
    if (linkPanelCheck) linkPanelCheck.checked = on;
    if (!on && gazeCtrl && gazeCtrl.ballL && gazeCtrl.ballR) {
        // entering per-eye mode: split the two balls out from the current gaze point so eyes don't jump
        gazeCtrl.ballL.position.copy(gazeCtrl.ball.position); gazeCtrl.ballL.position.x += 0.03;
        gazeCtrl.ballR.position.copy(gazeCtrl.ball.position); gazeCtrl.ballR.position.x -= 0.03;
    }
    applyGazeTarget();
}
// Manual per-eye aim: rotate each raw eye bone so its face-front axis points at its ball.
const _aeFwd = new THREE.Vector3(), _aeEye = new THREE.Vector3(), _aeTgt = new THREE.Vector3(), _aeDir = new THREE.Vector3();
const _aeQd = new THREE.Quaternion(), _aePW = new THREE.Quaternion(), _aeRW = new THREE.Quaternion(), _aeNW = new THREE.Quaternion(), _aeID = new THREE.Quaternion();
function aimOneEye(eye, restLocal, ballTgt) {
    currentVRM.lookAt.getLookAtWorldDirection(_aeFwd).normalize(); // face-front (rest) in world, follows head pose
    eye.getWorldPosition(_aeEye);
    ballTgt.getWorldPosition(_aeTgt);
    _aeDir.copy(_aeTgt).sub(_aeEye);
    if (_aeDir.lengthSq() < 1e-9) return;
    _aeDir.normalize();
    const ang = _aeFwd.angleTo(_aeDir);
    _aeQd.setFromUnitVectors(_aeFwd, _aeDir);              // world rotation: face-front -> desired
    if (ang > EYE_AIM_MAX) { _aeID.identity(); _aeID.slerp(_aeQd, EYE_AIM_MAX / ang); _aeQd.copy(_aeID); } // clamp
    eye.parent.getWorldQuaternion(_aePW);
    _aeRW.copy(_aePW).multiply(restLocal);                 // eye rest world quat
    _aeNW.copy(_aeQd).multiply(_aeRW);                     // aimed world quat
    eye.quaternion.copy(_aePW.invert().multiply(_aeNW));   // -> local (parent^-1 * world)
}
function applyEyeAim() {
    if (cameraGaze || eyesLinked || !gazeCtrl || !gazeCtrl.lEye || !gazeCtrl.rEye) return;
    aimOneEye(gazeCtrl.lEye, gazeCtrl.restL, gazeCtrl.ballL);
    aimOneEye(gazeCtrl.rEye, gazeCtrl.restR, gazeCtrl.ballR);
}

// ---- Bloom post-effect (self-contained: threshold -> separable gaussian -> additive composite) ----
// Scene -> offscreen sRGB target; extract+blur the bright parts (tinted by uColor);
// add them back. Used for the live view (and later the "image" capture); the
// depth/normal/mask/openpose passes always render directly (no bloom).
const BLOOM_KEY = "vrmSceneEditor.bloom";
const BLOOM_VERT = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const BLOOM_THRESH_FRAG = `
    uniform sampler2D tDiffuse; uniform float uThreshold; uniform vec3 uColor; varying vec2 vUv;
    vec3 lin2srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        float l = dot(lin2srgb(c.rgb), vec3(0.2126, 0.7152, 0.0722)); // perceptual (display-space) luma
        float contrib = max(0.0, l - uThreshold) / max(l, 1e-4);      // fraction above the threshold
        gl_FragColor = vec4(c.rgb * contrib * uColor, 1.0);           // keep the extracted color linear
    }`;
const BLOOM_BLUR_FRAG = `
    uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uTexel; varying vec2 vUv;
    void main(){
        vec2 o = uDir * uTexel;
        vec4 s = texture2D(tDiffuse, vUv) * 0.227027;
        s += texture2D(tDiffuse, vUv + o * 1.0) * 0.1945946; s += texture2D(tDiffuse, vUv - o * 1.0) * 0.1945946;
        s += texture2D(tDiffuse, vUv + o * 2.0) * 0.1216216; s += texture2D(tDiffuse, vUv - o * 2.0) * 0.1216216;
        s += texture2D(tDiffuse, vUv + o * 3.0) * 0.0540540; s += texture2D(tDiffuse, vUv - o * 3.0) * 0.0540540;
        s += texture2D(tDiffuse, vUv + o * 4.0) * 0.0162162; s += texture2D(tDiffuse, vUv - o * 4.0) * 0.0162162;
        gl_FragColor = s;
    }`;
const BLOOM_COMP_FRAG = `
    uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uStrength; varying vec2 vUv;
    void main(){
        vec4 s = texture2D(tScene, vUv);
        vec3 b = texture2D(tBloom, vUv).rgb;
        vec3 col = s.rgb + b * uStrength;                                      // additive in linear (grade pass encodes)
        float a = clamp(max(s.a, dot(b, vec3(0.3333)) * uStrength), 0.0, 1.0); // glow lifts alpha for transparent PNGs
        gl_FragColor = vec4(col, a);
    }`;
const bloom = {
    enabled: false, strength: 0.8, threshold: 0.85, color: new THREE.Color(0xffffff),
    _w: 0, _h: 0, sceneRT: null, rtA: null, rtB: null, quad: null, cam: null, fxScene: null,
    matThresh: null, matBlur: null, matComp: null,
};
(function loadBloom() {
    try {
        const s = JSON.parse(localStorage.getItem(BLOOM_KEY) || "{}");
        if (typeof s.enabled === "boolean") bloom.enabled = s.enabled;
        if (isFinite(s.strength)) bloom.strength = s.strength;
        if (isFinite(s.threshold)) bloom.threshold = s.threshold;
        if (typeof s.color === "string") bloom.color.set(s.color);
    } catch (_) {}
})();
function saveBloom() {
    localStorage.setItem(BLOOM_KEY, JSON.stringify({ enabled: bloom.enabled, strength: bloom.strength, threshold: bloom.threshold, color: "#" + bloom.color.getHexString() }));
}

// ---- Color grading (display-space: 温度/色合い/色相/彩度/コントラスト + カラーフィルタ) ----
const GRADE_KEY = "vrmSceneEditor.grade";
const GRADE_FRAG = `
    uniform sampler2D tInput; uniform float uEnabled, uTemp, uTint, uHue, uSat, uContrast; uniform vec3 uFilter; varying vec2 vUv;
    vec3 lin2srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    vec3 rgb2hsv(vec3 c){ vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g)); vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y); float e = 1.0e-10; return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x); }
    vec3 hsv2rgb(vec3 c){ vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
    void main(){
        vec4 src = texture2D(tInput, vUv);
        vec3 c = lin2srgb(src.rgb); // grade in display space (perceptual)
        if (uEnabled > 0.5){
            float t = uTemp / 100.0, tn = uTint / 100.0;
            c.r *= 1.0 + 0.2 * t; c.b *= 1.0 - 0.2 * t;            // 温度 (warm/cool)
            c.g *= 1.0 - 0.2 * tn;                                 // 色合い (green/magenta)
            vec3 hsv = rgb2hsv(max(c, 0.0));
            hsv.x = fract(hsv.x + uHue / 200.0);                   // 色相 rotate (-180..180 deg)
            hsv.y = clamp(hsv.y * (1.0 + uSat / 100.0), 0.0, 1.0); // 彩度
            c = hsv2rgb(hsv);
            c = (c - 0.5) * (1.0 + uContrast / 100.0) + 0.5;       // コントラスト (pivot 0.5)
            c *= lin2srgb(uFilter);                                // カラーフィルタ (white = no-op)
        }
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }`;
const grade = { enabled: false, temp: 0, tint: 0, hue: 0, sat: 0, contrast: 0, filter: new THREE.Color(0xffffff) };
(function loadGrade() {
    try {
        const s = JSON.parse(localStorage.getItem(GRADE_KEY) || "{}");
        if (typeof s.enabled === "boolean") grade.enabled = s.enabled;
        for (const k of ["temp", "tint", "hue", "sat", "contrast"]) if (isFinite(s[k])) grade[k] = s[k];
        if (typeof s.filter === "string") grade.filter.set(s.filter);
    } catch (_) {}
})();
function saveGrade() {
    localStorage.setItem(GRADE_KEY, JSON.stringify({ enabled: grade.enabled, temp: grade.temp, tint: grade.tint, hue: grade.hue, sat: grade.sat, contrast: grade.contrast, filter: "#" + grade.filter.getHexString() }));
}

// ---- Line art (Sobel edge detection on model-only depth + normal buffers) ----
const LINEART_KEY = "vrmSceneEditor.lineart";
const LINEART_FRAG = `
    uniform sampler2D tInput; uniform sampler2D tNormal; uniform sampler2D tDepth;
    uniform vec2 uTexel; uniform float uThickness, uDepthThresh, uNormalThresh, uNear, uFar; uniform vec3 uLineColor;
    varying vec2 vUv;
    float linDepth(float d){ float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
    void main(){
        vec2 o = uTexel * uThickness;
        float dC = linDepth(texture2D(tDepth, vUv).r);
        float dU = linDepth(texture2D(tDepth, vUv + vec2(0.0, o.y)).r);
        float dD = linDepth(texture2D(tDepth, vUv - vec2(0.0, o.y)).r);
        float dL = linDepth(texture2D(tDepth, vUv - vec2(o.x, 0.0)).r);
        float dR = linDepth(texture2D(tDepth, vUv + vec2(o.x, 0.0)).r);
        float depthEdge = (abs(dU - dC) + abs(dD - dC) + abs(dL - dC) + abs(dR - dC)) / max(dC, 0.001);
        vec3 nC = texture2D(tNormal, vUv).rgb;
        float normalEdge = length(texture2D(tNormal, vUv + vec2(0.0, o.y)).rgb - nC)
                         + length(texture2D(tNormal, vUv - vec2(0.0, o.y)).rgb - nC)
                         + length(texture2D(tNormal, vUv - vec2(o.x, 0.0)).rgb - nC)
                         + length(texture2D(tNormal, vUv + vec2(o.x, 0.0)).rgb - nC);
        float dE = smoothstep(uDepthThresh, uDepthThresh + 0.15, depthEdge);
        float nE = smoothstep(uNormalThresh, uNormalThresh + 0.25, normalEdge);
        float e = clamp(max(dE, nE), 0.0, 1.0);
        vec4 beauty = texture2D(tInput, vUv);
        gl_FragColor = vec4(mix(beauty.rgb, uLineColor, e), max(beauty.a, e));
    }`;
const lineart = { enabled: false, color: new THREE.Color(0x000000), thickness: 1.2, depth: 0.3, normal: 0.4 };
(function loadLineart() {
    try {
        const s = JSON.parse(localStorage.getItem(LINEART_KEY) || "{}");
        if (typeof s.enabled === "boolean") lineart.enabled = s.enabled;
        if (typeof s.color === "string") lineart.color.set(s.color);
        for (const k of ["thickness", "depth", "normal"]) if (isFinite(s[k])) lineart[k] = s[k];
    } catch (_) {}
})();
function saveLineart() {
    localStorage.setItem(LINEART_KEY, JSON.stringify({ enabled: lineart.enabled, color: "#" + lineart.color.getHexString(), thickness: lineart.thickness, depth: lineart.depth, normal: lineart.normal }));
}

// ---- Comic (manga) effect: 3-tone threshold (color/inner/outer) + screentone dots + oil smoothing ----
const COMIC_KEY = "vrmSceneEditor.comic";
const COMIC_FRAG = `
    uniform sampler2D tInput; uniform vec2 uResolution;
    uniform float uEnabled, uColorRatio, uMinT, uMaxT, uFine, uDensity, uOil;
    uniform vec3 uColor, uInner, uOuter;
    varying vec2 vUv;
    float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 lin2srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
        vec4 src = texture2D(tInput, vUv);
        if (uEnabled < 0.5){ gl_FragColor = src; return; }
        // 油彩: average a 5x5 neighborhood, spread by oil (px)
        vec3 col = vec3(0.0);
        for (int y = -2; y <= 2; y++){
            for (int x = -2; x <= 2; x++){
                col += texture2D(tInput, vUv + vec2(float(x), float(y)) * uOil / uResolution).rgb;
            }
        }
        col /= 25.0;
        vec3 orig = col;
        float l = luma(col);
        vec3 ink = lin2srgb(uColor), inr = lin2srgb(uInner), out0 = lin2srgb(uOuter);
        vec3 comic;
        if (l >= uMaxT){
            comic = out0;                                   // highlights
        } else if (l <= uMinT){
            comic = ink;                                    // deep shadows (ink)
        } else {
            // midtone band -> screentone: dots of ink over inner, bigger toward the dark end
            float t = clamp((uMaxT - l) / max(uMaxT - uMinT, 1e-3), 0.0, 1.0);
            float cells = mix(30.0, 250.0, clamp(uFine / 180.0, 0.0, 1.0));
            float aspect = uResolution.x / uResolution.y;
            vec2 gv = fract(vec2(vUv.x * aspect, vUv.y) * cells) - 0.5;
            float d = length(gv);
            float r = sqrt(clamp(t * uDensity, 0.0, 1.0)) * 0.5;
            float dotv = 1.0 - smoothstep(r - 0.06, r + 0.02, d);
            comic = mix(inr, ink, dotv);
        }
        // カラーの割合: keep the comic tone structure, blend in the original hue
        float oL = max(luma(orig), 0.001);
        vec3 colorized = comic * (orig / oL);
        vec3 outc = mix(comic, colorized, clamp(uColorRatio, 0.0, 1.0));
        gl_FragColor = vec4(clamp(outc, 0.0, 1.0), src.a);
    }`;
const comic = { enabled: false, colorRatio: 0.7, minT: 0.3, maxT: 0.85, fine: 90, density: 0.5, oil: 0, color: new THREE.Color(0x1a1a1a), inner: new THREE.Color(0x4c4c4c), outer: new THREE.Color(0xcccccc) };
(function loadComic() {
    try {
        const s = JSON.parse(localStorage.getItem(COMIC_KEY) || "{}");
        if (typeof s.enabled === "boolean") comic.enabled = s.enabled;
        for (const k of ["colorRatio", "minT", "maxT", "fine", "density", "oil"]) if (isFinite(s[k])) comic[k] = s[k];
        for (const k of ["color", "inner", "outer"]) if (typeof s[k] === "string") comic[k].set(s[k]);
    } catch (_) {}
})();
function saveComic() {
    localStorage.setItem(COMIC_KEY, JSON.stringify({ enabled: comic.enabled, colorRatio: comic.colorRatio, minT: comic.minT, maxT: comic.maxT, fine: comic.fine, density: comic.density, oil: comic.oil, color: "#" + comic.color.getHexString(), inner: "#" + comic.inner.getHexString(), outer: "#" + comic.outer.getHexString() }));
}

// ---- Anti-aliasing (SSAA / supersampling) ----
const AA_KEY = "vrmSceneEditor.aa";
// Anti-aliasing = SSAA (supersampling), the app's sole AA (hardware MSAA is off):
// the whole post chain is rendered at ss× resolution into aaRT, then this pass
// box-downsamples it to the output. 4 bilinear taps over the output pixel's source
// footprint average ~ss² subsamples -> smooths geometry edges AND shading/texture/
// line-art shimmer (which MSAA alone can't do). Off => no AA at all (raw/jaggy, fast).
const AA_RESOLVE_FRAG = `
    uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uOff; varying vec2 vUv;
    void main(){
        vec2 o = uTexel * uOff;               // quarter of the output-pixel footprint, in source UV
        vec4 c = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y))
               + texture2D(tDiffuse, vUv + vec2( o.x, -o.y))
               + texture2D(tDiffuse, vUv + vec2(-o.x,  o.y))
               + texture2D(tDiffuse, vUv + vec2( o.x,  o.y));
        gl_FragColor = c * 0.25;
    }`;
const aa = { enabled: true, strength: 0.6 }; // master AA switch (no hardware MSAA); default on = SSAA-smooth
(function loadAa() {
    try {
        const s = JSON.parse(localStorage.getItem(AA_KEY) || "{}");
        if (typeof s.enabled === "boolean") aa.enabled = s.enabled;
        if (isFinite(s.strength)) aa.strength = s.strength;
    } catch (_) {}
})();
function saveAa() {
    localStorage.setItem(AA_KEY, JSON.stringify({ enabled: aa.enabled, strength: aa.strength }));
}
function bloomInit() {
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: BLOOM_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    bloom.matThresh = mk(BLOOM_THRESH_FRAG, { tDiffuse: { value: null }, uThreshold: { value: 0.85 }, uColor: { value: new THREE.Color(1, 1, 1) } });
    bloom.matBlur = mk(BLOOM_BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() } });
    bloom.matComp = mk(BLOOM_COMP_FRAG, { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0.8 } });
    bloom.matGrade = mk(GRADE_FRAG, { tInput: { value: null }, uEnabled: { value: 0 }, uTemp: { value: 0 }, uTint: { value: 0 }, uHue: { value: 0 }, uSat: { value: 0 }, uContrast: { value: 0 }, uFilter: { value: new THREE.Color(1, 1, 1) } });
    bloom.matLineart = mk(LINEART_FRAG, { tInput: { value: null }, tNormal: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uThickness: { value: 1.2 }, uDepthThresh: { value: 0.3 }, uNormalThresh: { value: 0.4 }, uNear: { value: 0.1 }, uFar: { value: 100 }, uLineColor: { value: new THREE.Color(0, 0, 0) } });
    bloom.matComic = mk(COMIC_FRAG, { tInput: { value: null }, uResolution: { value: new THREE.Vector2() }, uEnabled: { value: 0 }, uColorRatio: { value: 0.7 }, uMinT: { value: 0.3 }, uMaxT: { value: 0.85 }, uFine: { value: 90 }, uDensity: { value: 0.5 }, uOil: { value: 0 }, uColor: { value: new THREE.Color(0x1a1a1a) }, uInner: { value: new THREE.Color(0x4c4c4c) }, uOuter: { value: new THREE.Color(0xcccccc) } });
    bloom.matResolve = mk(AA_RESOLVE_FRAG, { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uOff: { value: 0.5 } });
    bloom.cam = new THREE.Camera();
    bloom.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bloom.matThresh);
    bloom.quad.frustumCulled = false;
    bloom.fxScene = new THREE.Scene();
    bloom.fxScene.add(bloom.quad);
}
function bloomEnsureRT(w, h, samples) {
    if (bloom.sceneRT && bloom._w === w && bloom._h === h && bloom._samples === samples) return;
    bloom._w = w; bloom._h = h; bloom._samples = samples;
    if (bloom.sceneRT) { bloom.sceneRT.dispose(); bloom.rtA.dispose(); bloom.rtB.dispose(); bloom.outRT.dispose(); bloom.gradeRT.dispose(); bloom.comicRT.dispose(); bloom.aaRT.dispose(); bloom.normalRT.dispose(); }
    bloom.sceneRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false, samples });
    // sceneRT stays linear (three decodes sRGB RTs on sample); post math is linear, encoded to sRGB in the grade pass.
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    bloom.rtA = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false, stencilBuffer: false });
    bloom.rtB = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false, stencilBuffer: false });
    bloom.outRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false }); // bloom-composited (linear) -> grade pass
    bloom.gradeRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false }); // display-space beauty for comic / line-art
    bloom.comicRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false }); // comic output -> line-art input
    bloom.aaRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false }); // pre-FXAA image
    bloom.normalRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false, depthTexture: new THREE.DepthTexture(w, h) }); // model-only normals + depth
}
function bloomPass(mat, target) { bloom.quad.material = mat; renderer.setRenderTarget(target); renderer.render(bloom.fxScene, bloom.cam); }
function anyPostFx() { return bloom.enabled || grade.enabled || comic.enabled || lineart.enabled || aa.enabled; }
// Render the scene with the enabled post-effects into `outTarget` (null = screen).
// scene -> sceneRT (linear); optional bloom -> outRT (linear); grade+sRGB encode -> outTarget.
function renderPost(outTarget) {
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    // AA is the master switch (hardware MSAA is off). When on, render the whole chain at
    // ss× and box-downsample in the resolve pass; 強度 maps to ss (弱 1.4× .. 強 2.0×),
    // clamped so the buffer stays within GPU limits (esp. 2048px captures). When off,
    // ss=1 and there is no anti-aliasing at all (raw/jaggy but fast). No MSAA anywhere.
    let ss = 1;
    if (aa.enabled) {
        ss = 1.4 + aa.strength * 0.6;
        const longest = Math.max(sz.x, sz.y) * ss, MAXDIM = 3840;
        if (longest > MAXDIM) ss = Math.max(1, MAXDIM / Math.max(sz.x, sz.y));
    }
    const rw = Math.max(1, Math.round(sz.x * ss)), rh = Math.max(1, Math.round(sz.y * ss));
    bloomEnsureRT(rw, rh, 0);
    renderer.setRenderTarget(bloom.sceneRT);
    renderer.render(scene, camera);
    let workTex = bloom.sceneRT.texture;
    if (bloom.enabled) {
        bloom.matThresh.uniforms.tDiffuse.value = bloom.sceneRT.texture;
        bloom.matThresh.uniforms.uThreshold.value = bloom.threshold;
        bloom.matThresh.uniforms.uColor.value.copy(bloom.color);
        bloomPass(bloom.matThresh, bloom.rtA);
        bloom.matBlur.uniforms.uTexel.value.set(1 / bloom.rtA.width, 1 / bloom.rtA.height);
        for (let i = 0; i < 5; i++) {
            bloom.matBlur.uniforms.tDiffuse.value = bloom.rtA.texture; bloom.matBlur.uniforms.uDir.value.set(1, 0); bloomPass(bloom.matBlur, bloom.rtB);
            bloom.matBlur.uniforms.tDiffuse.value = bloom.rtB.texture; bloom.matBlur.uniforms.uDir.value.set(0, 1); bloomPass(bloom.matBlur, bloom.rtA);
        }
        bloom.matComp.uniforms.tScene.value = bloom.sceneRT.texture;
        bloom.matComp.uniforms.tBloom.value = bloom.rtA.texture;
        bloom.matComp.uniforms.uStrength.value = bloom.strength;
        bloomPass(bloom.matComp, bloom.outRT);
        workTex = bloom.outRT.texture;
    }
    const g = bloom.matGrade.uniforms;
    g.tInput.value = workTex;
    g.uEnabled.value = grade.enabled ? 1 : 0;
    g.uTemp.value = grade.temp; g.uTint.value = grade.tint; g.uHue.value = grade.hue;
    g.uSat.value = grade.sat; g.uContrast.value = grade.contrast; g.uFilter.value.copy(grade.filter);
    const chain = comic.enabled || lineart.enabled;
    const finalOut = aa.enabled ? bloom.aaRT : outTarget; // FXAA, if on, is the very last pass
    bloomPass(bloom.matGrade, chain ? bloom.gradeRT : finalOut);
    let beautyTex = bloom.gradeRT.texture;
    if (comic.enabled) {
        const c = bloom.matComic.uniforms;
        c.tInput.value = beautyTex; c.uResolution.value.set(bloom._w, bloom._h); c.uEnabled.value = 1;
        c.uColorRatio.value = comic.colorRatio; c.uMinT.value = comic.minT; c.uMaxT.value = comic.maxT;
        c.uFine.value = comic.fine; c.uDensity.value = comic.density; c.uOil.value = comic.oil;
        c.uColor.value.copy(comic.color); c.uInner.value.copy(comic.inner); c.uOuter.value.copy(comic.outer);
        bloomPass(bloom.matComic, lineart.enabled ? bloom.comicRT : finalOut);
        beautyTex = bloom.comicRT.texture;
    }
    if (lineart.enabled) {
        // Model-only normal + depth pass: hide grid/floor/handles + background so the
        // detected edges belong to the avatar only.
        const sBg = scene.background, sOv = scene.overrideMaterial, sGrid = grid.visible, sFloor = studioFloor.visible, sEdit = _editVisible;
        scene.background = null; scene.overrideMaterial = NORMAL_MATERIAL;
        grid.visible = false; studioFloor.visible = false; setEditVisible(false);
        renderer.setRenderTarget(bloom.normalRT);
        renderer.render(scene, camera);
        scene.background = sBg; scene.overrideMaterial = sOv;
        grid.visible = sGrid; studioFloor.visible = sFloor; setEditVisible(sEdit);
        // Edge pass: Sobel(depth) + Sobel(normal) -> composite line color over the graded beauty.
        const l = bloom.matLineart.uniforms;
        l.tInput.value = beautyTex; l.tNormal.value = bloom.normalRT.texture; l.tDepth.value = bloom.normalRT.depthTexture;
        l.uTexel.value.set(1 / bloom._w, 1 / bloom._h);
        l.uThickness.value = lineart.thickness; l.uDepthThresh.value = lineart.depth; l.uNormalThresh.value = lineart.normal;
        l.uNear.value = camera.near; l.uFar.value = camera.far; l.uLineColor.value.copy(lineart.color);
        bloomPass(bloom.matLineart, finalOut);
    }
    if (aa.enabled) {
        // Downsample the ss× aaRT to the output resolution (box of 4 bilinear taps).
        const a = bloom.matResolve.uniforms;
        a.tDiffuse.value = bloom.aaRT.texture; a.uTexel.value.set(1 / bloom._w, 1 / bloom._h); a.uOff.value = ss * 0.25;
        bloomPass(bloom.matResolve, outTarget);
    }
    renderer.setRenderTarget(null);
}
function renderView() { if (anyPostFx()) renderPost(null); else renderer.render(scene, camera); }
// Capture render: the beauty image (no override material) gets the post-effects baked in;
// data passes (mask/depth/normal set an overrideMaterial) always render raw so they stay clean.
function renderCapture() {
    if (scene.overrideMaterial === null && anyPostFx()) renderPost(null);
    else renderer.render(scene, camera);
}
bloomInit();

// ---- Custom HSV color picker popup (hue ring + saturation/value square) ----
function setupColorPicker() {
    const popup = document.getElementById("color-popup");
    if (!popup) return null;
    const wheel = popup.querySelector(".cp-wheel"), ringEl = popup.querySelector(".cp-ring"), svEl = popup.querySelector(".cp-sv");
    const ringMk = popup.querySelector(".cp-ring-marker"), svMk = popup.querySelector(".cp-sv-marker");
    const preview = popup.querySelector(".cp-preview"), hexEl = popup.querySelector(".cp-hex");
    const C = 90, RING_R = 75, SV = 88, SV0 = C - SV / 2; // wheel center, ring marker radius, sv size, sv top-left
    let h = 0, s = 1, v = 1, onChange = null;

    const hsv2rgb = (h, s, v) => {
        h = (((h % 360) + 360) % 360) / 60; const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 1) { r = c; g = x; } else if (h < 2) { r = x; g = c; } else if (h < 3) { g = c; b = x; }
        else if (h < 4) { g = x; b = c; } else if (h < 5) { r = x; b = c; } else { r = c; b = x; }
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    };
    const rgb2hsv = (r, g, b) => {
        r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let hh = 0; if (d) { if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
        return [hh, mx ? d / mx : 0, mx];
    };
    const toHex = () => "#" + hsv2rgb(h, s, v).map((x) => x.toString(16).padStart(2, "0")).join("");
    const setFromHex = (hex) => { const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim()); if (!m) return false; const n = parseInt(m[1], 16); const t = rgb2hsv((n >> 16) & 255, (n >> 8) & 255, n & 255); h = t[0]; s = t[1]; v = t[2]; return true; };

    const render = (fire) => {
        svEl.style.backgroundColor = "hsl(" + Math.round(h) + ",100%,50%)";
        const a = (h - 90) * Math.PI / 180;
        ringMk.style.left = (C + RING_R * Math.cos(a)) + "px"; ringMk.style.top = (C + RING_R * Math.sin(a)) + "px";
        ringMk.style.background = "hsl(" + Math.round(h) + ",100%,50%)";
        svMk.style.left = (SV0 + s * SV) + "px"; svMk.style.top = (SV0 + (1 - v) * SV) + "px";
        const hex = toHex();
        preview.style.background = hex;
        if (document.activeElement !== hexEl) hexEl.value = hex;
        if (fire !== false && onChange) onChange(hex);
    };
    const ringDrag = (e) => { const r = wheel.getBoundingClientRect(); h = (Math.atan2(e.clientY - (r.top + C), e.clientX - (r.left + C)) * 180 / Math.PI + 90 + 360) % 360; render(); };
    const svDrag = (e) => { const r = svEl.getBoundingClientRect(); s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)); render(); };
    let mode = null;
    ringEl.addEventListener("pointerdown", (e) => { mode = "ring"; ringDrag(e); e.preventDefault(); });
    svEl.addEventListener("pointerdown", (e) => { mode = "sv"; svDrag(e); e.preventDefault(); });
    window.addEventListener("pointermove", (e) => { if (mode === "ring") ringDrag(e); else if (mode === "sv") svDrag(e); });
    window.addEventListener("pointerup", () => { mode = null; });
    hexEl.addEventListener("change", () => { if (setFromHex(hexEl.value)) render(); });
    window.addEventListener("pointerdown", (e) => { if (!popup.hidden && !popup.contains(e.target) && !(e.target.classList && e.target.classList.contains("fx-swatch"))) close(); });

    function open(anchor, hex, cb) {
        onChange = cb; setFromHex(hex);
        popup.hidden = false; popup.style.left = "0px"; popup.style.top = "0px";
        const r = anchor.getBoundingClientRect(), pw = popup.offsetWidth, ph = popup.offsetHeight;
        popup.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pw - 6)) + "px";
        popup.style.top = Math.max(6, Math.min(r.bottom + 6, window.innerHeight - ph - 6)) + "px";
        render(false);
    }
    function close() { popup.hidden = true; onChange = null; }
    return { open, close };
}
const colorPicker = setupColorPicker();

// ---- After-effects panel: ブルーム + カラーグレーディング (each: header checkbox + accordion) ----
(function setupFxPanel() {
    const panel = document.getElementById("fx-panel");
    if (!panel) return;

    // Shared color control: swatch (opens native picker) + hex field + eyedropper.
    const wireColor = (swatchId, hexId, eyedropId, getHex, setHexRaw) => {
        const swatch = document.getElementById(swatchId), hexEl = document.getElementById(hexId), eyedrop = document.getElementById(eyedropId);
        if (!swatch || !hexEl) return;
        const sync = () => { const h = getHex(); swatch.style.background = h; if (document.activeElement !== hexEl) hexEl.value = h; };
        const apply = (raw) => { if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return false; setHexRaw(raw[0] === "#" ? raw : "#" + raw); sync(); return true; };
        sync();
        hexEl.addEventListener("change", () => { if (!apply(hexEl.value.trim())) hexEl.value = getHex(); });
        const native = document.createElement("input"); native.type = "color"; native.style.display = "none"; panel.appendChild(native);
        native.addEventListener("input", () => apply(native.value));
        swatch.addEventListener("click", (e) => {
            if (colorPicker) { e.stopPropagation(); colorPicker.open(swatch, getHex(), apply); }
            else { native.value = getHex(); native.click(); }
        });
        if (eyedrop) eyedrop.addEventListener("click", async () => {
            if (!window.EyeDropper) { console.warn("EyeDropper API unsupported in this browser"); return; }
            try { const res = await new window.EyeDropper().open(); apply(res.sRGBHex); } catch (_) {}
        });
        return sync;
    };
    // Numeric slider bound to a state object's key (with a value readout).
    const wireSlider = (id, get, set, fmt) => {
        const el = document.getElementById(id), val = document.getElementById(id + "-val");
        if (!el) return () => {};
        const sync = () => { el.value = String(get()); if (val) val.textContent = fmt(get()); };
        sync();
        el.addEventListener("input", () => { set(parseFloat(el.value) || 0); if (val) val.textContent = fmt(get()); });
        return sync;
    };

    // --- Bloom ---
    const bEn = document.getElementById("bloom-enabled");
    bEn.checked = bloom.enabled;
    bEn.addEventListener("change", () => { bloom.enabled = bEn.checked; saveBloom(); });
    const bSync = [
        wireSlider("bloom-strength", () => bloom.strength, (v) => { bloom.strength = v; saveBloom(); }, (v) => v.toFixed(2)),
        wireSlider("bloom-threshold", () => bloom.threshold, (v) => { bloom.threshold = v; saveBloom(); }, (v) => v.toFixed(2)),
        wireColor("bloom-color-swatch", "bloom-color-hex", "bloom-eyedrop", () => "#" + bloom.color.getHexString(), (h) => { bloom.color.set(h); saveBloom(); }),
    ];
    const bReset = document.getElementById("bloom-reset");
    if (bReset) bReset.addEventListener("click", () => { bloom.strength = 0.8; bloom.threshold = 0.85; bloom.color.set(0xffffff); saveBloom(); bSync.forEach((f) => f && f()); });

    // --- Color grading ---
    const gEn = document.getElementById("grade-enabled");
    if (gEn) {
        gEn.checked = grade.enabled;
        gEn.addEventListener("change", () => { grade.enabled = gEn.checked; saveGrade(); });
        const intFmt = (v) => String(Math.round(v));
        const gKeys = ["temp", "tint", "hue", "sat", "contrast"];
        const gSync = gKeys.map((k) => wireSlider("grade-" + k, () => grade[k], (v) => { grade[k] = v; saveGrade(); }, intFmt));
        gSync.push(wireColor("grade-filter-swatch", "grade-filter-hex", "grade-eyedrop", () => "#" + grade.filter.getHexString(), (h) => { grade.filter.set(h); saveGrade(); }));
        const gReset = document.getElementById("grade-reset");
        if (gReset) gReset.addEventListener("click", () => { gKeys.forEach((k) => grade[k] = 0); grade.filter.set(0xffffff); saveGrade(); gSync.forEach((f) => f && f()); });
    }

    // --- Studio background color (shares the custom color picker) ---
    wireColor("studio-bg-swatch", "studio-bg-hex", "studio-bg-eyedrop", () => "#" + studioBgColor.getHexString(), (h) => setStudioBgColor(h));

    // --- Line art ---
    const lEn = document.getElementById("lineart-enabled");
    if (lEn) {
        lEn.checked = lineart.enabled;
        lEn.addEventListener("change", () => { lineart.enabled = lEn.checked; saveLineart(); });
        const lSync = [
            wireSlider("lineart-thickness", () => lineart.thickness, (v) => { lineart.thickness = v; saveLineart(); }, (v) => v.toFixed(1)),
            wireSlider("lineart-depth", () => lineart.depth, (v) => { lineart.depth = v; saveLineart(); }, (v) => v.toFixed(2)),
            wireSlider("lineart-normal", () => lineart.normal, (v) => { lineart.normal = v; saveLineart(); }, (v) => v.toFixed(2)),
            wireColor("lineart-color-swatch", "lineart-color-hex", "lineart-eyedrop", () => "#" + lineart.color.getHexString(), (h) => { lineart.color.set(h); saveLineart(); }),
        ];
        const lReset = document.getElementById("lineart-reset");
        if (lReset) lReset.addEventListener("click", () => { lineart.thickness = 1.2; lineart.depth = 0.3; lineart.normal = 0.4; lineart.color.set(0x000000); saveLineart(); lSync.forEach((f) => f && f()); });
    }

    // --- Comic ---
    const cEn = document.getElementById("comic-enabled");
    if (cEn) {
        cEn.checked = comic.enabled;
        cEn.addEventListener("change", () => { comic.enabled = cEn.checked; saveComic(); });
        const cSync = [
            wireSlider("comic-colorRatio", () => comic.colorRatio, (v) => { comic.colorRatio = v; saveComic(); }, (v) => v.toFixed(2)),
            wireSlider("comic-minT", () => comic.minT, (v) => { comic.minT = v; saveComic(); }, (v) => v.toFixed(2)),
            wireSlider("comic-maxT", () => comic.maxT, (v) => { comic.maxT = v; saveComic(); }, (v) => v.toFixed(2)),
            wireSlider("comic-fine", () => comic.fine, (v) => { comic.fine = v; saveComic(); }, (v) => String(Math.round(v))),
            wireSlider("comic-density", () => comic.density, (v) => { comic.density = v; saveComic(); }, (v) => v.toFixed(2)),
            wireSlider("comic-oil", () => comic.oil, (v) => { comic.oil = v; saveComic(); }, (v) => v.toFixed(2)),
            wireColor("comic-color-swatch", "comic-color-hex", "comic-color-eyedrop", () => "#" + comic.color.getHexString(), (h) => { comic.color.set(h); saveComic(); }),
            wireColor("comic-inner-swatch", "comic-inner-hex", "comic-inner-eyedrop", () => "#" + comic.inner.getHexString(), (h) => { comic.inner.set(h); saveComic(); }),
            wireColor("comic-outer-swatch", "comic-outer-hex", "comic-outer-eyedrop", () => "#" + comic.outer.getHexString(), (h) => { comic.outer.set(h); saveComic(); }),
        ];
        const cReset = document.getElementById("comic-reset");
        if (cReset) cReset.addEventListener("click", () => {
            comic.colorRatio = 0.7; comic.minT = 0.3; comic.maxT = 0.85; comic.fine = 90; comic.density = 0.5; comic.oil = 0;
            comic.color.set(0x1a1a1a); comic.inner.set(0x4c4c4c); comic.outer.set(0xcccccc); saveComic();
            cSync.forEach((f) => f && f());
        });
    }

    // --- Anti-aliasing (FXAA) ---
    const aEn = document.getElementById("aa-enabled");
    if (aEn) {
        aEn.checked = aa.enabled;
        aEn.addEventListener("change", () => { aa.enabled = aEn.checked; saveAa(); });
        wireSlider("aa-strength", () => aa.strength, (v) => { aa.strength = v; saveAa(); }, (v) => (1.4 + v * 0.6).toFixed(2) + "x");
    }

    // --- Show/hide the experimental ラインアート・コミック sections (toggled in 設定; default OFF).
    //     When hidden, the effect is also forced off so it can't keep running unseen. ---
    const SHOW_LINEART_KEY = "vrmSceneEditor.showLineart", SHOW_COMIC_KEY = "vrmSceneEditor.showComic";
    let showLineart = localStorage.getItem(SHOW_LINEART_KEY) === "1";
    let showComic = localStorage.getItem(SHOW_COMIC_KEY) === "1";
    const lineartSection = lEn ? lEn.closest(".ep-section") : null;
    const comicSection = cEn ? cEn.closest(".ep-section") : null;
    const applyLineartShow = () => {
        if (lineartSection) lineartSection.hidden = !showLineart;
        if (!showLineart && lineart.enabled) { lineart.enabled = false; saveLineart(); if (lEn) lEn.checked = false; }
    };
    const applyComicShow = () => {
        if (comicSection) comicSection.hidden = !showComic;
        if (!showComic && comic.enabled) { comic.enabled = false; saveComic(); if (cEn) cEn.checked = false; }
    };
    applyLineartShow(); applyComicShow();
    const showLineartInput = document.getElementById("show-lineart");
    if (showLineartInput) { showLineartInput.checked = showLineart; showLineartInput.addEventListener("change", () => { showLineart = showLineartInput.checked; localStorage.setItem(SHOW_LINEART_KEY, showLineart ? "1" : "0"); applyLineartShow(); }); }
    const showComicInput = document.getElementById("show-comic");
    if (showComicInput) { showComicInput.checked = showComic; showComicInput.addEventListener("change", () => { showComic = showComicInput.checked; localStorage.setItem(SHOW_COMIC_KEY, showComic ? "1" : "0"); applyComicShow(); }); }

    const fxClose = document.getElementById("fx-close");
    if (fxClose) fxClose.addEventListener("click", () => { panel.hidden = true; });
    // accordion per section: arrow + title text collapse/expand; the checkbox between them is independent
    panel.querySelectorAll(".ep-section").forEach((section) => {
        const arrow = section.querySelector(".fx-arrow"), titleB = section.querySelector(".fx-title"), content = section.querySelector(".ep-content");
        if (!content) return;
        const toggle = () => { content.hidden = !content.hidden; if (arrow) arrow.textContent = content.hidden ? "▸" : "▾"; };
        if (arrow) arrow.addEventListener("click", toggle);
        if (titleB) titleB.addEventListener("click", toggle);
    });

    const title = panel.querySelector(".ep-title");
    if (title) {
        let dx = 0, dy = 0, drag = false;
        title.addEventListener("pointerdown", (e) => { if (e.target.closest("#fx-close")) return; const r = panel.getBoundingClientRect(); panel.style.left = r.left + "px"; panel.style.top = r.top + "px"; dx = e.clientX - r.left; dy = e.clientY - r.top; drag = true; try { title.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); });
        title.addEventListener("pointermove", (e) => { if (!drag) return; panel.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - panel.offsetWidth)) + "px"; panel.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - panel.offsetHeight)) + "px"; });
        const end = (e) => { if (drag) { drag = false; try { title.releasePointerCapture(e.pointerId); } catch (_) {} } };
        title.addEventListener("pointerup", end); title.addEventListener("pointercancel", end);
    }
    const grip = panel.querySelector(".ep-resize");
    if (grip) {
        let startH = 0, startY = 0, rsz = false;
        grip.addEventListener("pointerdown", (e) => { startH = panel.offsetHeight; startY = e.clientY; rsz = true; panel.style.maxHeight = "none"; try { grip.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); e.stopPropagation(); });
        grip.addEventListener("pointermove", (e) => { if (!rsz) return; const maxH = Math.round(window.innerHeight * 0.92); panel.style.height = Math.max(120, Math.min(startH + (e.clientY - startY), maxH)) + "px"; const r = panel.getBoundingClientRect(); if (r.bottom > window.innerHeight - 4) panel.style.top = Math.max(4, window.innerHeight - 4 - r.height) + "px"; });
        const end = (e) => { if (rsz) { rsz = false; try { grip.releasePointerCapture(e.pointerId); } catch (_) {} } };
        grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
    }
})();

// ---- Floating panels: clicking or showing a window raises it above the others ----
(function setupPanelStacking() {
    const ids = ["settings-panel", "transform-panel", "tool-panel", "ref-panel", "scene-panel", "camera-panel", "preview-panel", "expr-panel", "fx-panel", "hand-pose-panel", "pose-lib-panel"];
    let z = 20;
    const toFront = (p) => { p.style.zIndex = String(++z); };
    ids.map((id) => document.getElementById(id)).filter(Boolean).forEach((p) => {
        p.addEventListener("pointerdown", () => toFront(p), true); // capture: raise even if an inner handler stops propagation
        new MutationObserver(() => { if (!p.hidden) toFront(p); }).observe(p, { attributes: true, attributeFilter: ["hidden"] }); // raise when shown
    });

    // ---- Toolbar dropdown menus ("ファイル" / "リセット" / "ウィンドウ") ----
    // Each .menu-wrap holds a toggle button + a .tb-menu list. Opening one closes
    // the others; clicking any item or anywhere outside closes the menus. The
    // items' own actions (load / reset / show-window) are wired elsewhere via
    // their stable ids -- here we only manage open/close.
    const menuWraps = [...document.querySelectorAll("#toolbar .menu-wrap")];
    const tbMenus = menuWraps.map((w) => w.querySelector(".tb-menu")).filter(Boolean);
    const closeMenus = (keep) => tbMenus.forEach((m) => { if (m !== keep) m.hidden = true; });
    menuWraps.forEach((wrap) => {
        const btn = wrap.querySelector("button");
        const menu = wrap.querySelector(".tb-menu");
        if (!btn || !menu) return;
        // mousedown toggles this menu (and stops the document handler from re-closing it)
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            const willOpen = menu.hidden;
            closeMenus(willOpen ? menu : null); // close the siblings
            menu.hidden = !willOpen;
        });
        // clicking an item runs its own handler, then closes the menus
        menu.querySelectorAll("button").forEach((item) => item.addEventListener("click", () => closeMenus()));
    });
    // click anywhere outside any toolbar menu closes them all
    document.addEventListener("mousedown", (e) => { if (!e.target.closest("#toolbar .menu-wrap")) closeMenus(); });

    // "ウィンドウ" items: data-target -> reveal that floating panel and raise it.
    document.querySelectorAll("#window-menu button[data-target]").forEach((item) => {
        item.addEventListener("click", () => {
            const p = document.getElementById(item.dataset.target);
            if (p) { p.hidden = false; toFront(p); }
        });
    });
})();

// ---- ハンドフォーカス: 手首から先だけをクリッピング表示し、手首を中心に編集 ----
// 親(腕/IK/体)の影響を止めるため、モード中は親IK解決を凍結。指のローカル回転は
// 親に依存しないので、見た目を安定させるだけで編集データは汚れない。
let handFocusActive = false;
let handFocusSide = null; // "left" | "right"
const HAND_FOCUS_HANDLE_SCALE = 0.5; // フォーカス中の指ハンドル縮小率
const _handClipPlane = new THREE.Plane();
let _handFocusSaved = null; // { camPos, target, prevBoneEdit }
const _hfWrist = new THREE.Vector3(), _hfElbow = new THREE.Vector3(), _hfNormal = new THREE.Vector3();

function handFocusBones(side) {
    if (!currentVRM || !currentVRM.humanoid) return null;
    const h = currentVRM.humanoid;
    const hand = h.getRawBoneNode(side + "Hand");   // 実際に変形するボーン = メッシュに一致
    const fore = h.getRawBoneNode(side + "LowerArm");
    return (hand && fore) ? { hand, fore } : null;
}
function updateHandFocus() {
    if (!handFocusActive) return;
    const b = handFocusBones(handFocusSide);
    if (!b) return;
    b.hand.getWorldPosition(_hfWrist);
    b.fore.getWorldPosition(_hfElbow);
    _hfNormal.subVectors(_hfWrist, _hfElbow); // 前腕→手 の向き
    if (_hfNormal.lengthSq() < 1e-8) _hfNormal.set(0, 1, 0);
    _hfNormal.normalize();
    // 手首より少し肘側へ平面を置き、手のひら/手首まで残す（法線側=手を保持、反対側=体を切る）
    _hfElbow.copy(_hfWrist).addScaledVector(_hfNormal, -0.02);
    _handClipPlane.setFromNormalAndCoplanarPoint(_hfNormal, _hfElbow);
    // 注: orbit.target は enter 時に手首へ合わせるだけにする。毎フレーム上書きすると
    //     右ドラッグ(パン)が効かなくなるため、ここでは更新しない（フォーカス中は手首は静止）。
}
function enterHandFocus(side) {
    if (!currentVRM) { showToast("VRMが読み込まれていません", "error", 2000); return; }
    const b = handFocusBones(side);
    if (!b) { showToast("手のボーンが見つかりません", "error", 2000); return; }
    handFocusSide = side;
    _handFocusSaved = { camPos: camera.position.clone(), target: orbit.target.clone(), prevBoneEdit: boneEditEnabled };
    handFocusActive = true;
    setBoneEdit(true);                       // 指の制御点を表示（focus分岐で指のみ表示）
    // 制御点が近接カメラで大きく見えるので、フォーカス中の指/手首ハンドルは縮小
    for (const h of boneHandles) if (isHandFocusBone(h.name)) h.mesh.scale.setScalar(HAND_FOCUS_HANDLE_SCALE);
    renderer.clippingPlanes = [_handClipPlane]; // 手首から先だけ描画
    updateHandFocus();
    // カメラを手に寄せる（現在の視線方向を維持して距離だけ詰める）
    b.hand.getWorldPosition(_hfWrist);
    const dir = camera.position.clone().sub(_hfWrist);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    camera.position.copy(_hfWrist).addScaledVector(dir.normalize(), 0.32);
    orbit.target.copy(_hfWrist);
    orbit.update();
    const bar = document.getElementById("hand-focus-bar");
    const label = document.getElementById("hand-focus-label");
    if (label) label.textContent = `ハンドフォーカス: ${side === "left" ? "左手" : "右手"}`;
    if (bar) bar.hidden = false;
    showHandEditPanel(side); // 指ごとスライダーパネルを表示
}
function exitHandFocus() {
    if (!handFocusActive) return;
    for (const h of boneHandles) h.mesh.scale.setScalar(1); // ハンドル縮小を戻す
    handFocusActive = false;
    handFocusSide = null;
    renderer.clippingPlanes = []; // クリッピング解除
    if (_handFocusSaved) {
        camera.position.copy(_handFocusSaved.camPos);
        orbit.target.copy(_handFocusSaved.target);
        orbit.update();
        setBoneEdit(_handFocusSaved.prevBoneEdit);
        _handFocusSaved = null;
    }
    handFocusSide = null;
    hideHandEditPanel();
    const bar = document.getElementById("hand-focus-bar");
    if (bar) bar.hidden = true;
}
// ---- 指ごと curl/splay ＋ 握り/カッピング の手続き的エディタ（案B） ----
// スライダー＝土台（restから手続き計算で上書き）／3Dハンドル＝仕上げ。スライダーを
// 動かし直すとその指は rest から再計算される（手の微調整はリセット）。
const FINGER_LABELS_JP = ["親指", "人差し指", "中指", "薬指", "小指"];
const HAND_EDIT_CURL_MAX = { finger: [70, 100, 70], thumb: [40, 55, 55] }; // curl=1 の各関節角(度)
const HAND_EDIT_SPLAY_MAX = 22;             // splay=±1 の角(度)
const CUP_CURL_W = [0, 0, 0.15, 0.4, 0.7];  // カッピングが各指curlに足す重み(親〜小)
const CUP_SPLAY_DEG = [0, 0, -3, -7, -12];  // カッピングが各指splayに足す角(収束)
function mkHandEditState() { return { curl: [0, 0, 0, 0, 0], splay: [0, 0, 0, 0, 0], grip: 0, cupping: 0 }; }
const handEditState = { left: mkHandEditState(), right: mkHandEditState() };

function applyHandEditFinger(side, fi) {
    const bones = handPoseBones[side];
    if (!bones || !bones.length) return;
    const st = handEditState[side];
    const eff = clamp01(st.curl[fi] + st.grip + st.cupping * CUP_CURL_W[fi]);
    const splayDeg = st.splay[fi] * HAND_EDIT_SPLAY_MAX + st.cupping * CUP_SPLAY_DEG[fi];
    for (const b of bones) {
        if (b.finger !== fi) continue;
        const maxArr = b.isThumb ? HAND_EDIT_CURL_MAX.thumb : HAND_EDIT_CURL_MAX.finger;
        const curlDeg = eff * (maxArr[b.joint] || 0);
        _hpOffset.identity();
        if (b.joint === 0 && splayDeg) _hpOffset.setFromAxisAngle(b.splayAxis, THREE.MathUtils.degToRad(splayDeg));
        _hpCurl.setFromAxisAngle(b.curlAxis, THREE.MathUtils.degToRad(curlDeg));
        _hpOffset.multiply(_hpCurl);
        b.node.quaternion.copy(b.restQuat).multiply(_hpOffset);
    }
    if (currentVRM) currentVRM.humanoid.update();
}
function applyHandEditAll(side) { for (let fi = 0; fi < FINGERS.length; fi++) applyHandEditFinger(side, fi); }

function buildHandEditPanel(side) {
    const body = document.getElementById("hand-edit-body");
    if (!body) return;
    body.innerHTML = "";
    const st = handEditState[side];
    const row = (label, min, max, step, val, oninput) => {
        const r = document.createElement("div"); r.className = "he-row";
        const lab = document.createElement("span"); lab.className = "he-label"; lab.textContent = label;
        const inp = document.createElement("input"); inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val); inp.className = "he-range";
        const num = document.createElement("span"); num.className = "he-num";
        const upd = () => { num.textContent = (+inp.value).toFixed(2); };
        inp.addEventListener("input", () => { upd(); oninput(+inp.value); });
        upd();
        r.append(lab, inp, num);
        body.appendChild(r);
    };
    const sec = (t) => { const d = document.createElement("div"); d.className = "he-sec"; d.textContent = t; body.appendChild(d); };

    sec("全体");
    row("握り", 0, 1, 0.01, st.grip, (v) => { st.grip = v; applyHandEditAll(side); });
    row("カッピング", 0, 1, 0.01, st.cupping, (v) => { st.cupping = v; applyHandEditAll(side); });
    for (let fi = 0; fi < FINGERS.length; fi++) {
        sec(FINGER_LABELS_JP[fi]);
        row("曲げ", 0, 1, 0.01, st.curl[fi], (v) => { st.curl[fi] = v; applyHandEditFinger(side, fi); });
        row("開き", -1, 1, 0.01, st.splay[fi], (v) => { st.splay[fi] = v; applyHandEditFinger(side, fi); });
    }
}
function showHandEditPanel(side) {
    handEditState[side] = mkHandEditState(); // 入室時はスライダーを初期化（現在のポーズは保持）
    buildHandEditPanel(side);
    const ep = document.getElementById("hand-edit-panel");
    const t = document.getElementById("hand-edit-title");
    if (t) t.textContent = `ハンド編集: ${side === "left" ? "左手" : "右手"}`;
    if (ep) ep.hidden = false;
    const pal = document.getElementById("hand-pose-palette");
    if (pal) { pal.hidden = false; renderHandPalette(); }
}
function hideHandEditPanel() {
    const ep = document.getElementById("hand-edit-panel"); if (ep) ep.hidden = true;
    const pal = document.getElementById("hand-pose-palette"); if (pal) pal.hidden = true;
}

// ---- ハンドポーズ・ライブラリ（左右共通のパラメータとして保存） ----
// 保存するのは curl/splay/grip/cupping のパラメータ。手に依存しない中立値なので、
// 適用先の手で applyHandEdit すれば自動的にミラーされた正しい形になる（座標変換不要）。
const HAND_LIB_KEY = "vrmSceneEditor.handPoseLib";
function loadHandLib() { try { const s = JSON.parse(localStorage.getItem(HAND_LIB_KEY)); if (Array.isArray(s)) return s; } catch (_) {} return []; }
let handPoseLib = loadHandLib();
function saveHandLib() { localStorage.setItem(HAND_LIB_KEY, JSON.stringify(handPoseLib)); }
function cloneHandParams(st) { return { curl: st.curl.slice(), splay: st.splay.slice(), grip: st.grip, cupping: st.cupping }; }
function applyHandPoseLib(idx) {
    if (!handFocusActive) return;
    const p = handPoseLib[idx]; if (!p || !p.params) return;
    const side = handFocusSide;
    handEditState[side] = {
        curl: (p.params.curl || [0, 0, 0, 0, 0]).slice(),
        splay: (p.params.splay || [0, 0, 0, 0, 0]).slice(),
        grip: p.params.grip || 0, cupping: p.params.cupping || 0,
    };
    buildHandEditPanel(side);   // スライダーを読み込んだ値に
    applyHandEditAll(side);     // 選んだ手に適用（左右自動ミラー）
}
// 現在フォーカス中の手を正方形サムネに（補助点を隠し、手首クリップ＋クリーン背景でオフスクリーン描画）
const HAND_THUMB_SIZE = 64;        // 縮小保存（小さめ）
const HAND_THUMB_QUALITY = 0.72;   // JPEG品質（PNGより大幅に軽量）
function renderHandThumb() {
    if (!handFocusActive) return "";
    try { _initThumb(); } catch (_) { return ""; }
    const prevEdit = _editVisible;
    setEditVisible(false);                 // 制御点を隠す
    const prevBg = scene.background;
    scene.background = null;
    _thumbR.setSize(HAND_THUMB_SIZE, HAND_THUMB_SIZE, false);
    _thumbR.setClearColor(0x1a1a1a, 1);
    _thumbCam.aspect = 1; _thumbCam.fov = camera.fov;
    _thumbCam.position.copy(camera.position);
    _thumbCam.quaternion.copy(camera.quaternion);
    _thumbCam.updateProjectionMatrix();
    const prevClip = _thumbR.clippingPlanes;
    _thumbR.clippingPlanes = [_handClipPlane];
    let url = "";
    try { _thumbR.render(scene, _thumbCam); url = _thumbR.domElement.toDataURL("image/jpeg", HAND_THUMB_QUALITY); } catch (_) {}
    _thumbR.clippingPlanes = prevClip;
    _thumbR.setSize(THUMB_W, THUMB_H, false); // モデルサムネ用サイズに戻す
    scene.background = prevBg;
    setEditVisible(prevEdit);               // 制御点を戻す
    return url;
}

let selectedHandPose = -1;
function updateHplStatus() {
    const cnt = document.getElementById("hpl-count"); if (cnt) cnt.textContent = `${handPoseLib.length}件`;
    const del = document.getElementById("hpl-del"); if (del) del.disabled = selectedHandPose < 0;
    const add = document.getElementById("hpl-add"); if (add) add.disabled = !handFocusActive;
}
function renderHandPalette() {
    const list = document.getElementById("hpl-list"); if (!list) return;
    list.innerHTML = "";
    if (selectedHandPose >= handPoseLib.length) selectedHandPose = -1;
    if (!handPoseLib.length) { list.innerHTML = '<div class="hpl-empty">登録なし</div>'; updateHplStatus(); return; }
    handPoseLib.forEach((p, idx) => {
        const card = document.createElement("div"); card.className = "hpl-card" + (idx === selectedHandPose ? " selected" : ""); card.title = p.name;
        let thumbEl;
        if (p.thumb) { thumbEl = document.createElement("img"); thumbEl.className = "hpl-thumb"; thumbEl.alt = ""; thumbEl.src = p.thumb; }
        else { thumbEl = document.createElement("div"); thumbEl.className = "hpl-thumb"; }
        const nm = document.createElement("span"); nm.className = "hpl-name"; nm.textContent = p.name;
        card.append(thumbEl, nm);
        card.addEventListener("click", () => {
            selectedHandPose = idx;
            for (const c of list.querySelectorAll(".hpl-card.selected")) c.classList.remove("selected");
            card.classList.add("selected"); updateHplStatus();
        });
        card.addEventListener("dblclick", () => applyHandPoseLib(idx)); // ダブルクリックで適用
        list.appendChild(card);
    });
    updateHplStatus();
}
function addHandPoseWithName(name) {
    if (!handFocusActive) { showToast("ハンド編集中に追加できます", "error", 2000); return; }
    name = (name || "").trim() || `hand-${handPoseLib.length + 1}`;
    const thumb = renderHandThumb();
    handPoseLib.push({ name, params: cloneHandParams(handEditState[handFocusSide]), thumb });
    saveHandLib();
    selectedHandPose = handPoseLib.length - 1;
    renderHandPalette();
    showToast(`ハンドポーズ登録: ${name}`, "success", 2000);
}
function deleteSelectedHandPose() {
    if (selectedHandPose < 0) return;
    const p = handPoseLib[selectedHandPose]; if (!p) return;
    confirmDialog(`「${p.name}」を削除しますか？`, () => {
        handPoseLib.splice(selectedHandPose, 1);
        selectedHandPose = -1;
        saveHandLib();
        renderHandPalette();
    });
}

(function setupHandFocusUI() {
    const l = document.getElementById("hp-focus-left");
    const r = document.getElementById("hp-focus-right");
    const exit = document.getElementById("hand-focus-exit");
    const reset = document.getElementById("hand-edit-reset");
    if (l) l.addEventListener("click", () => enterHandFocus("left"));
    if (r) r.addEventListener("click", () => enterHandFocus("right"));
    if (exit) exit.addEventListener("click", exitHandFocus);
    if (reset) reset.addEventListener("click", () => {
        if (!handFocusActive) return;
        handEditState[handFocusSide] = mkHandEditState();
        buildHandEditPanel(handFocusSide);
        applyHandEditAll(handFocusSide); // 平手化
    });
    setupFloatingPanel("hand-edit-panel"); // タイトルでドラッグ移動
    persistPanelGeometry("hand-edit-panel", "vrmSceneEditor.handEditGeom"); // 位置・サイズを記憶
    // ハンドポーズパレット
    setupFloatingPanel("hand-pose-palette");
    persistPanelGeometry("hand-pose-palette", "vrmSceneEditor.handPalGeom");
    const hplDel = document.getElementById("hpl-del");
    if (hplDel) hplDel.addEventListener("click", deleteSelectedHandPose);
    // 追加 → ポーズ名登録オーバーレイ
    const nameModal = document.getElementById("hand-pose-name-modal");
    const nameInput = document.getElementById("hpn-input");
    const nameOk = document.getElementById("hpn-ok");
    const hplAdd = document.getElementById("hpl-add");
    const closeName = () => { if (nameModal) nameModal.hidden = true; };
    const openName = () => {
        if (!handFocusActive) { showToast("ハンド編集中に追加できます", "error", 2000); return; }
        if (nameInput) { nameInput.value = ""; nameInput.placeholder = `hand-${handPoseLib.length + 1}`; }
        if (nameModal) nameModal.hidden = false;
        if (nameInput) nameInput.focus();
    };
    const submitName = () => { addHandPoseWithName(nameInput ? nameInput.value : ""); closeName(); };
    if (hplAdd) hplAdd.addEventListener("click", openName);
    if (nameOk) nameOk.addEventListener("click", submitName);
    if (nameInput) nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });
    if (nameModal) nameModal.addEventListener("click", (e) => { if (e.target === nameModal || e.target.closest("[data-close]")) closeName(); });
    renderHandPalette();
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (nameModal && !nameModal.hidden) { e.preventDefault(); closeName(); return; } // モーダル優先で閉じる
        if (handFocusActive) { e.preventDefault(); exitHandFocus(); }
    });
})();

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (ikChains.length && !handFocusActive) solveAnchoredChains(); // ハンドフォーカス中は親IKを凍結
    if (currentVRM) { currentVRM.update(delta); applyFaceMorphs(); applyEyeAim(); } // morphs + per-eye aim last
    if (ikProxies.length) snapProxies(false); // keep IK/hip/shoulder balls on the limbs when idle
    updateHandFocus(); // 手首クリッピング平面＋ピボットを毎フレーム更新
    orbit.update();
    // Re-apply roll each frame: orbit.update() just reset the orientation to
    // level via lookAt(), so this rotation around the view axis doesn't
    // accumulate. rotateZ uses the camera's local Z = its line of sight.
    if (rollAngle !== 0) camera.rotateZ(rollAngle);
    if (_pvFrame++ % 4 === 0) renderFramePreview(); // ~15fps composite preview
    if (boneTreePanel && !boneTreePanel.hidden && _btTick++ % 6 === 0) updateBoneTreeValues(); // live bone rotations
    renderView(); // bloom-on -> offscreen pipeline; off -> direct render
}
animate();

// Auto-load the bundled sample model on open (silently fall back to the prompt
// if it is not present). Tag it with the sentinel file so it can be saved/restored.
const promptMessage = "VRM / GLB / GLTF を読み込んでください(ボタン または ドラッグ&ドロップ)";
setStatus("サンプルVRMを読込中 ...");
loader.load(
    DEFAULT_MODEL_URL,
    (gltf) => onModelLoaded(gltf, false, DEFAULT_MODEL_FILE),
    undefined,
    () => setStatus(promptMessage),
);

// ---- 操作モードパネル: 矢印(ボーン編集OFF) / ボーン(ボーン編集ON) ----
// 設定の「ボーン編集」チェックボックスと同じ状態を、2ボタンのラジオ式で切り替える。
(function setupBoneToolPanel() {
    const panel = document.getElementById("tool-panel");
    if (!panel) return;
    boneToolButtons.length = 0;
    boneToolButtons.push(...panel.querySelectorAll(".tl-btn"));
    for (const b of boneToolButtons) b.addEventListener("click", () => setBoneEdit(b.dataset.bone === "on"));

    // Drag by the slim title grip (same pattern as the transform panel).
    const title = panel.querySelector(".tl-title");
    if (title) {
        let dx = 0, dy = 0, dragging = false;
        title.addEventListener("pointerdown", (e) => {
            const r = panel.getBoundingClientRect();
            panel.style.left = r.left + "px"; panel.style.top = r.top + "px"; panel.style.bottom = "auto";
            dx = e.clientX - r.left; dy = e.clientY - r.top; dragging = true;
            try { title.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        title.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const x = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - panel.offsetWidth));
            const y = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - panel.offsetHeight));
            panel.style.left = x + "px"; panel.style.top = y + "px";
        });
        const end = (e) => { if (dragging) { dragging = false; try { title.releasePointerCapture(e.pointerId); } catch (_) {} } };
        title.addEventListener("pointerup", end);
        title.addEventListener("pointercancel", end);
    }

    setBoneEdit(boneEditEnabled); // reflect the current state on the buttons
})();

// ---- シーン保存: ウィンドウ配置・設定・カメラ・モデル＋ポーズ＋サムネを保存 ----
function defaultSceneName() {
    const d = new Date(); const p = (n) => String(n).padStart(2, "0");
    return `scene-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const SCENE_PANEL_IDS = ["settings-panel", "transform-panel", "tool-panel", "ref-panel", "scene-panel", "camera-panel", "preview-panel", "expr-panel", "fx-panel", "hand-pose-panel", "pose-lib-panel"];
function serializeModelPose(vrm) {
    if (!vrm || !vrm.humanoid) return null;
    const names = Object.keys(vrm.humanoid.humanBones || {});
    const bones = {}; const locks = [];
    for (const bn of names) {
        const node = vrm.humanoid.getNormalizedBoneNode(bn);
        if (!node) continue;
        bones[bn] = node.quaternion.toArray();
        if (lockedBones.has(node)) locks.push(bn);
    }
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    return { bones, hipPos: hips ? hips.position.toArray() : null, locks };
}
function serializeScene(name) {
    const layout = {};
    for (const id of SCENE_PANEL_IDS) {
        const el = document.getElementById(id); if (!el) continue;
        const r = el.getBoundingClientRect();
        layout[id] = { hidden: !!el.hidden, left: Math.round(r.left), top: Math.round(r.top), w: el.offsetWidth, h: el.offsetHeight };
    }
    const models = loadedModels.map((e) => ({
        id: e.id, file: e.file || null, name: e.name, active: e.root === modelRoot,
        transform: { p: e.root.position.toArray(), rq: e.root.quaternion.toArray(), tq: e.tilt.quaternion.toArray(), ts: e.tilt.scale.toArray() },
        pose: serializeModelPose(e.vrm),
    }));
    const view = { camPos: camera.position.toArray(), target: orbit.target.toArray() }; // ビューポート(回転/ズーム)
    return { name, created: new Date().toISOString(), layout, models, cameras: cameraConfigs, activeCamera, boneEdit: boneEditEnabled, view };
}
(function setupSceneSave() {
    const btn = document.getElementById("scene-save-btn");
    const modal = document.getElementById("scene-save-modal");
    const input = document.getElementById("scene-name-input");
    const ok = document.getElementById("scene-save-ok");
    if (!btn || !modal) return;
    const close = () => { modal.hidden = true; };
    const open = () => { if (input) { input.value = ""; input.placeholder = defaultSceneName(); } modal.hidden = false; if (input) input.focus(); };
    async function doSave() {
        const name = (input && input.value.trim()) || defaultSceneName();
        const thumbnail = previewCanvas ? previewCanvas.toDataURL("image/png") : "";
        try {
            const res = await fetch("/vrm-scene-editor/save-scene", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, data: serializeScene(name), thumbnail }),
            });
            const r = await res.json();
            if (!res.ok) throw new Error(r.error || res.status);
            showToast(`シーン保存: ${r.name}`, "success", 2500);
            close();
        } catch (e) { showToast(`保存失敗: ${e.message || e}`, "error", 3000); }
    }
    btn.addEventListener("click", open);
    if (ok) ok.addEventListener("click", doSave);
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
})();

// ---- シーンロード: 保存したシーン (models/scene/*.json) を復元 ----
function deserializeModelPose(vrm, pose) {
    if (!vrm || !vrm.humanoid || !pose) return;
    const h = vrm.humanoid;
    for (const [bn, arr] of Object.entries(pose.bones || {})) {
        const node = h.getNormalizedBoneNode(bn);
        if (node && Array.isArray(arr)) node.quaternion.fromArray(arr);
    }
    if (pose.hipPos) { const hips = h.getNormalizedBoneNode("hips"); if (hips) hips.position.fromArray(pose.hipPos); }
    h.update();
    vrm.scene.updateMatrixWorld(true);
    if (Array.isArray(pose.locks)) for (const bn of pose.locks) { const node = h.getNormalizedBoneNode(bn); if (node) lockedBones.add(node); }
}
function applyModelTransform(entry, t) {
    if (!t) return;
    if (Array.isArray(t.p)) entry.root.position.fromArray(t.p);
    if (Array.isArray(t.rq)) entry.root.quaternion.fromArray(t.rq);
    if (Array.isArray(t.tq)) entry.tilt.quaternion.fromArray(t.tq);
    if (Array.isArray(t.ts)) entry.tilt.scale.fromArray(t.ts);
}
async function loadSceneData(data) {
    if (!data || !Array.isArray(data.models)) { showToast("シーンデータが不正です", "error", 2500); return; }
    clearAllModels();
    lockedBones.clear();

    const idMap = {}; // 旧モデルid -> 新モデルid（カメラの除外設定の付け替え用）
    const loaded = []; // {entry, ms} 復元後にポーズを再適用するため保持
    let activeIdx = 0;
    for (const ms of data.models) {
        if (!ms.file) continue; // 外部ドロップ由来のモデルは再読込不可
        const ok = await loadModelFromLibrary({ name: ms.name || ms.file, file: ms.file }, true);
        if (!ok) continue;
        const entry = loadedModels[loadedModels.length - 1];
        if (ms.name) entry.name = ms.name;
        applyModelTransform(entry, ms.transform);
        deserializeModelPose(entry.vrm, ms.pose);
        if (ms.id != null) idMap[ms.id] = entry.id;
        if (ms.active) activeIdx = loadedModels.length - 1;
        loaded.push({ entry, ms });
    }

    // カメラ設定の復元（除外モデルidは新idへ付け替え）
    if (data.cameras) {
        for (const c of CAMERA_LIST) {
            const o = data.cameras[c]; if (!o) continue;
            if (typeof o.enabled === "boolean") cameraConfigs[c].enabled = o.enabled;
            else if (o.type) cameraConfigs[c].enabled = (c === "camera1");
            cameraConfigs[c].types = Array.isArray(o.types) ? o.types.filter((t) => OUTPUT_TYPES.includes(t))
                : (o.type && OUTPUT_TYPES.includes(o.type) ? [o.type] : cameraConfigs[c].types);
            if (!cameraConfigs[c].types.length) cameraConfigs[c].types = ["image"];
            cameraConfigs[c].exclude = Array.isArray(o.exclude) ? o.exclude.map((old) => idMap[old]).filter((v) => v != null) : [];
        }
        if (CAMERA_LIST.includes(data.activeCamera)) activeCamera = data.activeCamera;
        saveCameras();
        if (typeof syncCameraUI === "function") syncCameraUI();
    }

    // ボーン編集モードの復元
    if (typeof data.boneEdit === "boolean" && typeof setBoneEdit === "function") setBoneEdit(data.boneEdit);

    // ウィンドウ配置の復元
    if (data.layout) for (const id of SCENE_PANEL_IDS) {
        const L = data.layout[id]; const el = document.getElementById(id);
        if (!L || !el) continue;
        el.hidden = !!L.hidden;
        if (!L.hidden) {
            if (typeof L.left === "number") el.style.left = L.left + "px";
            if (typeof L.top === "number") { el.style.top = L.top + "px"; el.style.bottom = "auto"; }
            if (typeof L.w === "number") el.style.width = L.w + "px";
            if (typeof L.h === "number") el.style.height = L.h + "px";
        }
    }

    if (loadedModels.length) activateModel(loadedModels[Math.min(activeIdx, loadedModels.length - 1)]);

    // activateModel が applyCurrentHandPose 等でポーズに触れるため、最後にもう一度確実に適用
    for (const { entry, ms } of loaded) { applyModelTransform(entry, ms.transform); deserializeModelPose(entry.vrm, ms.pose); }
    snapProxies(true); // IK/hip ボールを復元後のポーズに合わせる

    // ビューポート(カメラの回転方向・ズーム)の復元 — frameCamera より後に上書き
    if (data.view) {
        if (Array.isArray(data.view.camPos)) camera.position.fromArray(data.view.camPos);
        if (Array.isArray(data.view.target)) orbit.target.fromArray(data.view.target);
        orbit.update();
    }

    updateModelListUI();
    renderFramePreview();
    showToast(`シーン読込: ${data.name || ""}`, "success", 2500);
}
(function setupSceneLibrary() {
    const modal = document.getElementById("scene-modal");
    if (!modal) return;
    const body = modal.querySelector(".pl-body");
    const reloadBtn = document.getElementById("scene-reload");
    const openBtn = document.getElementById("scene-load-btn"); // ファイル ▾ → シーンロード
    const okBtn = document.getElementById("scene-load-ok");
    const closeFootBtn = document.getElementById("scene-load-close");
    let scenes = [];
    let selectedFile = null;
    const updateOk = () => { if (okBtn) okBtn.disabled = !selectedFile; };
    const close = () => { modal.hidden = true; };
    const open = () => { modal.hidden = false; load(); };
    const thumbUrl = (thumb) => "/vrm-scene-models/scene/" + encodeURIComponent(thumb);

    async function doLoad(file) {
        if (!file) return;
        close();
        setStatus("シーン読込中 ...");
        let data;
        try {
            const res = await fetch("/vrm-scene-editor/scene?file=" + encodeURIComponent(file));
            if (!res.ok) throw new Error("HTTP " + res.status);
            data = await res.json();
        } catch (e) {
            showToast(`シーン読込に失敗しました (${e.message})`, "error", 3000);
            return;
        }
        await loadSceneData(data);
    }

    async function doDelete(s) {
        try {
            const res = await fetch("/vrm-scene-editor/delete-scene", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ file: s.file }),
            });
            const r = await res.json();
            if (!res.ok) throw new Error(r.error || res.status);
            if (selectedFile === s.file) { selectedFile = null; updateOk(); }
            showToast(`シーン削除: ${s.name}`, "success", 2000);
            load(); // 一覧を更新
        } catch (e) { showToast(`削除失敗: ${e.message || e}`, "error", 3000); }
    }

    async function load() {
        body.innerHTML = '<div class="pl-empty">読込中 ...</div>';
        selectedFile = null; updateOk();
        let data;
        try {
            const res = await fetch("/vrm-scene-editor/scenes");
            if (!res.ok) throw new Error("HTTP " + res.status);
            data = await res.json();
        } catch (e) {
            body.innerHTML = `<div class="pl-empty">一覧の取得に失敗しました (${e.message})<br>ComfyUI の再起動が必要かもしれません</div>`;
            return;
        }
        scenes = data.scenes ?? [];
        if (!scenes.length) { body.innerHTML = '<div class="pl-empty">models/scene に保存済みシーンがありません</div>'; return; }
        body.innerHTML = "";
        for (const s of scenes) {
            const card = document.createElement("button");
            card.type = "button"; card.className = "ml-card"; card.title = s.file;
            let thumbEl;
            if (s.thumb) {
                thumbEl = document.createElement("img"); thumbEl.className = "ml-thumb"; thumbEl.alt = ""; thumbEl.src = thumbUrl(s.thumb);
                thumbEl.addEventListener("error", () => { const ph = document.createElement("div"); ph.className = "ml-noimg"; ph.textContent = "No Image"; thumbEl.replaceWith(ph); });
            } else {
                thumbEl = document.createElement("div"); thumbEl.className = "ml-noimg"; thumbEl.textContent = "No Image";
            }
            const nm = document.createElement("span"); nm.className = "ml-name"; nm.textContent = s.name;
            card.append(thumbEl, nm);
            card.addEventListener("click", () => { // 単一選択
                selectedFile = s.file;
                for (const c of body.querySelectorAll(".ml-card.selected")) c.classList.remove("selected");
                card.classList.add("selected");
                updateOk();
            });
            card.addEventListener("dblclick", () => doLoad(s.file)); // ダブルクリックで即読込
            const del = document.createElement("button"); // 削除（確認オーバーレイ）
            del.type = "button"; del.className = "sc-del"; del.textContent = "×"; del.title = "削除";
            del.addEventListener("click", (ev) => {
                ev.stopPropagation();
                confirmDialog(`シーン「${s.name}」を削除しますか？`, () => doDelete(s));
            });
            const wrap = document.createElement("div"); wrap.className = "sc-card-wrap";
            wrap.append(card, del);
            body.appendChild(wrap);
        }
    }

    if (reloadBtn) reloadBtn.addEventListener("click", load);
    if (okBtn) okBtn.addEventListener("click", () => doLoad(selectedFile));
    if (closeFootBtn) closeFootBtn.addEventListener("click", close);
    if (openBtn) openBtn.addEventListener("click", open);
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
})();

// ---- Help menu: バージョン情報 / ライセンス dialogs ----
// APP_VERSION is the single source of truth: it fills both the bottom-right
// watermark badge and the about dialog. Bump it here on release.
// ---- 背景画像（参照アンダーレイ） ----
// A reference image drawn behind the (transparent) canvas so the model can be posed
// to match it. DOM-only -> never appears in captures. Toggling it flips the live
// background to transparent via updateLiveBackground().
let _refObjURL = null;
function loadRefImage(file) {
    const img = document.getElementById("ref-image");
    if (!img) return;
    if (!file || !file.type || !file.type.startsWith("image/")) { if (file) setStatus("画像ファイルを選んでください"); return; }
    if (_refObjURL) URL.revokeObjectURL(_refObjURL);
    _refObjURL = URL.createObjectURL(file);
    img.src = _refObjURL;
    const showCb = document.getElementById("ref-show");
    if (showCb) showCb.checked = true;
    refImageActive = true;
    img.style.display = "block";
    updateLiveBackground();
    const panel = document.getElementById("ref-panel");
    if (panel) panel.hidden = false; // surface the panel so the controls are reachable
    setStatus(`背景画像: ${file.name}`);
}

(function setupRefPanel() {
    const panel = document.getElementById("ref-panel");
    const img = document.getElementById("ref-image");
    if (!panel || !img) return;
    const input = document.getElementById("ref-input");
    const showCb = document.getElementById("ref-show");
    const frontCb = document.getElementById("ref-front");
    const opacityEl = document.getElementById("ref-opacity");
    const scaleEl = document.getElementById("ref-scale");
    const rotEl = document.getElementById("ref-rot");
    const xEl = document.getElementById("ref-x");
    const yEl = document.getElementById("ref-y");
    const setVal = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    const applyTransform = () => { img.style.transform = `translate(${xEl.value}%, ${yEl.value}%) rotate(${rotEl.value}deg) scale(${scaleEl.value})`; };
    const applyShow = () => {
        refImageActive = showCb.checked && !!img.getAttribute("src");
        img.style.display = refImageActive ? "block" : "none";
        updateLiveBackground();
    };
    // Front mode: lift the image above the canvas (model) but keep it pointer-events:none,
    // so it overlays the model visually while control stays on the model.
    const applyFront = () => { img.style.zIndex = (frontCb && frontCb.checked) ? "2" : "0"; };

    document.getElementById("ref-load").addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => { loadRefImage(e.target.files?.[0]); input.value = ""; });
    document.getElementById("ref-clear").addEventListener("click", () => {
        if (_refObjURL) { URL.revokeObjectURL(_refObjURL); _refObjURL = null; }
        img.removeAttribute("src");
        showCb.checked = false;
        applyShow();
        setStatus("背景画像をクリアしました");
    });
    showCb.addEventListener("change", applyShow);
    if (frontCb) frontCb.addEventListener("change", applyFront);
    opacityEl.addEventListener("input", () => { img.style.opacity = opacityEl.value; setVal("ref-opacity-val", Number(opacityEl.value).toFixed(2)); });
    scaleEl.addEventListener("input", () => { applyTransform(); setVal("ref-scale-val", Number(scaleEl.value).toFixed(2)); });
    rotEl.addEventListener("input", () => { applyTransform(); setVal("ref-rot-val", Number(rotEl.value).toFixed(1) + "°"); });
    xEl.addEventListener("input", () => { applyTransform(); setVal("ref-x-val", Number(xEl.value).toFixed(1)); });
    yEl.addEventListener("input", () => { applyTransform(); setVal("ref-y-val", Number(yEl.value).toFixed(1)); });

    img.style.opacity = opacityEl.value;
    applyTransform();
    applyFront();

    const closeBtn = document.getElementById("ref-close");
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.hidden = true; });

    // Drag the panel by its title bar (same pattern as the other floating panels).
    const title = panel.querySelector(".rf-title");
    if (title) {
        let dx = 0, dy = 0, dragging = false;
        title.addEventListener("pointerdown", (e) => {
            if (e.target.closest("#ref-close")) return;
            const r = panel.getBoundingClientRect();
            panel.style.left = r.left + "px"; panel.style.top = r.top + "px";
            dx = e.clientX - r.left; dy = e.clientY - r.top; dragging = true;
            try { title.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        title.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const x = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - panel.offsetWidth));
            const y = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - panel.offsetHeight));
            panel.style.left = x + "px"; panel.style.top = y + "px";
        });
        const end = (e) => { if (dragging) { dragging = false; try { title.releasePointerCapture(e.pointerId); } catch (_) {} } };
        title.addEventListener("pointerup", end);
        title.addEventListener("pointercancel", end);
    }
})();

(function setupHelpDialogs() {
    const APP_VERSION = "v0.1a";
    const badgeVer = document.querySelector("#app-badge .ver");
    const aboutVer = document.getElementById("about-version");
    if (badgeVer) badgeVer.textContent = APP_VERSION;
    if (aboutVer) aboutVer.textContent = APP_VERSION;

    const aboutModal = document.getElementById("about-modal");
    const licenseModal = document.getElementById("license-modal");
    const controlsModal = document.getElementById("controls-modal");
    const modals = [aboutModal, licenseModal, controlsModal];
    const open = (m) => { if (m) m.hidden = false; };
    const closeAll = () => modals.forEach((m) => { if (m) m.hidden = true; });

    const aboutBtn = document.getElementById("about-btn");
    const licenseBtn = document.getElementById("license-btn");
    const controlsBtn = document.getElementById("controls-btn");
    if (aboutBtn) aboutBtn.addEventListener("click", () => open(aboutModal));
    if (licenseBtn) licenseBtn.addEventListener("click", () => open(licenseModal));
    if (controlsBtn) controlsBtn.addEventListener("click", () => open(controlsModal));

    // Close on × button, or on clicking the dimmed backdrop (but not the card).
    modals.forEach((m) => {
        if (!m) return;
        m.addEventListener("click", (e) => {
            if (e.target === m || e.target.closest("[data-close]")) closeAll();
        });
    });
    // Esc closes whichever dialog is open.
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modals.some((m) => m && !m.hidden)) closeAll();
    });
})();

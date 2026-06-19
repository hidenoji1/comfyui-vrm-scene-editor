import { app } from "../../scripts/app.js";

// Launch button for the VRM Scene Editor, placed in the same spot as the
// LoRA Manager button (just before the ComfyUI settings button group).

const BUTTON_TOOLTIP = "Launch VRM Scene Editor (Shift+Click opens in new window)";
const VRM_SCENE_EDITOR_PATH = "/vrm-scene-editor";
const NEW_WINDOW_FEATURES = "width=1280,height=860,resizable=yes,scrollbars=yes,status=yes";
const MAX_ATTACH_ATTEMPTS = 120;
const BUTTON_GROUP_CLASS = "vrm-scene-editor-top-menu-group";

// ComfyUI frontend versions >= 1.33.9 expose the actionBarButtons API.
const MIN_VERSION_FOR_ACTION_BAR = [1, 33, 9];

// White rounded square with a solid human figure (MDI "human-handsup") on top
// -- same style as the LoRA Manager button. Colors are baked into the SVG so
// the icon stays opaque and consistent regardless of the button background or
// hover state (no see-through effect).
const ICON_BOX_COLOR = "#D3E2E7";   // light blue-gray box (matches LoRA Manager)
const ICON_FIGURE_COLOR = "#236692"; // theme primary blue (--primary-bg)
const getSceneEditorIcon = () => `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path fill="${ICON_BOX_COLOR}"
            d="M4,0 H20 A4,4 0 0 1 24,4 V20 A4,4 0 0 1 20,24 H4 A4,4 0 0 1 0,20 V4 A4,4 0 0 1 4,0 Z" />
        <path fill="${ICON_FIGURE_COLOR}"
            d="M12,2A2,2 0 0,1 14,4A2,2 0 0,1 12,6A2,2 0 0,1 10,4A2,2 0 0,1 12,2M15.89,8.11C15.5,7.72 15,7.5 14.5,7.5H9.5C9,7.5 8.5,7.72 8.11,8.11C7.72,8.5 4.5,12.5 4.5,12.5L5.91,13.91L9,11V13L6,21H8L10.25,14.5H13.75L16,21H18L15,13V11L18.09,13.91L19.5,12.5C19.5,12.5 16.28,8.5 15.89,8.11Z" />
    </svg>
`;

const openSceneEditor = (event) => {
    const url = `${window.location.origin}${VRM_SCENE_EDITOR_PATH}`;
    if (event && event.shiftKey) {
        // Shift+Click: intentionally open a fresh, separate window.
        window.open(url, "_blank", NEW_WINDOW_FEATURES);
        return;
    }
    // Normal click: reuse a single named tab -- focus it if already open
    // instead of spawning another instance.
    const win = window.open(url, "vrmSceneEditor");
    if (win) win.focus();
};

const getComfyUIFrontendVersion = async () => {
    if (window["__COMFYUI_FRONTEND_VERSION__"]) {
        return window["__COMFYUI_FRONTEND_VERSION__"];
    }
    try {
        const response = await fetch("/system_stats");
        const data = await response.json();
        return (
            data?.system?.comfyui_frontend_version ||
            data?.system?.required_frontend_version ||
            "0.0.0"
        );
    } catch (error) {
        console.warn("VRM Scene Editor: unable to fetch system_stats:", error);
        return "0.0.0";
    }
};

const parseVersion = (versionStr) => {
    if (!versionStr || typeof versionStr !== "string") return [0, 0, 0];
    const clean = versionStr.replace(/^[vV]/, "").split("-")[0];
    const parts = clean.split(".").map((p) => parseInt(p, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts;
};

const isAtLeast = (versionStr, target) => {
    const v = parseVersion(versionStr);
    for (let i = 0; i < 3; i++) {
        if (v[i] > target[i]) return true;
        if (v[i] < target[i]) return false;
    }
    return true;
};

// --- Legacy attachment (frontend < 1.33.9) -------------------------------

const createTopMenuButton = async () => {
    const { ComfyButton } = await import("../../scripts/ui/components/button.js");

    const button = new ComfyButton({
        icon: "vrmsceneeditor",
        tooltip: BUTTON_TOOLTIP,
        app,
        enabled: true,
        classList: "comfyui-button comfyui-menu-mobile-collapse primary",
    });

    button.element.setAttribute("aria-label", BUTTON_TOOLTIP);
    button.element.title = BUTTON_TOOLTIP;

    if (button.iconElement) {
        button.iconElement.innerHTML = getSceneEditorIcon();
        button.iconElement.style.width = "1.2rem";
        button.iconElement.style.height = "1.2rem";
    }

    button.element.addEventListener("click", openSceneEditor);
    return button;
};

const attachTopMenuButton = async (attempt = 0) => {
    if (document.querySelector(`.${BUTTON_GROUP_CLASS}`)) return;

    const settingsGroup = app.menu?.settingsGroup;
    if (!settingsGroup?.element?.parentElement) {
        if (attempt >= MAX_ATTACH_ATTEMPTS) {
            console.warn("VRM Scene Editor: unable to locate the ComfyUI settings button group.");
            return;
        }
        requestAnimationFrame(() => attachTopMenuButton(attempt + 1));
        return;
    }

    const button = await createTopMenuButton();
    const { ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js");

    const buttonGroup = new ComfyButtonGroup(button);
    buttonGroup.element.classList.add(BUTTON_GROUP_CLASS);
    settingsGroup.element.before(buttonGroup.element);
};

// --- Extension registration ----------------------------------------------

const injectStyles = () => {
    const styleId = "vrm-scene-editor-top-menu-button-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        button[aria-label="${BUTTON_TOOLTIP}"].vrm-scene-editor-top-menu-button {
            transition: all 0.2s ease;
            border: 1px solid transparent;
        }
        button[aria-label="${BUTTON_TOOLTIP}"].vrm-scene-editor-top-menu-button:hover {
            background-color: var(--primary-hover-bg) !important;
        }
    `;
    document.head.appendChild(style);
};

// Guarantee the human-figure icon is shown on the action-bar button even if
// the iconify class fails to resolve.
const replaceButtonIcon = () => {
    const buttons = document.querySelectorAll(`button[aria-label="${BUTTON_TOOLTIP}"]`);
    buttons.forEach((button) => {
        button.classList.add("vrm-scene-editor-top-menu-button");
        button.innerHTML = getSceneEditorIcon();
        button.style.borderRadius = "4px";
        button.style.padding = "6px";
        button.style.backgroundColor = "var(--primary-bg)";
        const svg = button.querySelector("svg");
        if (svg) {
            svg.style.width = "20px";
            svg.style.height = "20px";
        }
    });
    if (buttons.length === 0) {
        requestAnimationFrame(replaceButtonIcon);
    }
};

(async () => {
    const version = await getComfyUIFrontendVersion();
    const useActionBar = isAtLeast(version, MIN_VERSION_FOR_ACTION_BAR);

    const extensionObj = {
        name: "VrmSceneEditor.TopMenu",
        async setup() {
            injectStyles();
            if (useActionBar) {
                requestAnimationFrame(replaceButtonIcon);
            } else {
                await attachTopMenuButton();
            }
        },
    };

    if (useActionBar) {
        extensionObj.actionBarButtons = [
            {
                icon: "icon-[mdi--human-handsup] size-4",
                tooltip: BUTTON_TOOLTIP,
                onClick: openSceneEditor,
            },
        ];
    }

    app.registerExtension(extensionObj);
})();

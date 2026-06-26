# ComfyUI VRM Scene Editor

VRM / GLB / GLTF の3Dモデルをブラウザ上でポーズ付け・カメラ調整し、その画像（通常画像 / マスク / 深度 / 法線 / OpenPose など）を **ComfyUI のワークフローに取り込める** カスタムノードです。three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) で動作します。

ComfyUI の設定（歯車）ボタンの隣に「**VRM Scene Editor**」起動ボタンが追加され、クリックすると専用エディタが開きます（LoRA Manager と同じ仕組み）。

## 特長

- VRM / GLB / GLTF モデルを読み込んでポーズ・カメラを調整
- 撮影タイプ：`image` / `mask` / `mask(hands)` / `depth` / `normal` / `openpose(body)` / `openpose(hands)` / `openpose(body+hands)`
- 撮影した画像を **`VRM Scene Capture`** ノードでワークフローに読み込み（`IMAGE` 出力）
- **追加の pip インストール不要**（必要なライブラリは ComfyUI に同梱）

## 動作環境

- ComfyUI（最近のバージョン）
- WebGL 対応のモダンブラウザ（Chrome / Edge など）
- 追加の Python パッケージ不要（`aiohttp` / `numpy` / `torch` / `Pillow` は ComfyUI 同梱）

## インストール

### 方法A：git clone（推奨）

ComfyUI の `custom_nodes` フォルダで以下を実行します。

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/hidenoji1/comfyui-vrm-scene-editor.git
```

Windows ポータブル版の場合（例）：

```powershell
cd C:\path\to\ComfyUI_windows_portable\ComfyUI\custom_nodes
git clone https://github.com/hidenoji1/comfyui-vrm-scene-editor.git
```

完了したら **ComfyUI を再起動** してください。

### 方法B：ZIP ダウンロード

1. GitHub の **Code → Download ZIP** をクリック
2. 解凍してできた `comfyui-vrm-scene-editor-main` を `ComfyUI/custom_nodes/` に移動
3. フォルダ名を **`comfyui-vrm-scene-editor`** にリネーム
4. **ComfyUI を再起動**

### 方法C：ComfyUI Manager（任意）

ComfyUI Manager の **Install via Git URL** に次の URL を貼り付けてもインストールできます。

```
https://github.com/hidenoji1/comfyui-vrm-scene-editor.git
```

## 使い方

1. ComfyUI を再起動し、ブラウザを再読み込みする
2. 画面の設定（歯車）ボタン付近にある **VRM Scene Editor** ボタンをクリック
3. エディタでモデルを読み込み（同梱の `sample.vrm` あり）、ポーズ・カメラを調整 → 撮影タイプを選んで **撮影**
4. ComfyUI のグラフに **`VRM Scene Capture`** ノード（カテゴリ：**VRM Scene Editor**）を追加
5. ノードの `camera` / `type` をエディタの撮影内容に合わせると、その画像が `IMAGE` 出力としてワークフローに流れます

## 更新

```bash
cd ComfyUI/custom_nodes/comfyui-vrm-scene-editor
git pull
```

更新後は ComfyUI を再起動してください。

## アンインストール

`ComfyUI/custom_nodes/comfyui-vrm-scene-editor` フォルダを削除して、ComfyUI を再起動するだけです。

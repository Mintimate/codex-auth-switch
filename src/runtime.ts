// 公开演示必须显式构建；桌面正式包不会因缺少 Tauri 而退回演示数据。
export const isPublicDemo = import.meta.env.MODE === "demo";

export const isBrowserPreview = () =>
  isPublicDemo || (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window));

export const demoReadOnlyError = () =>
  new Error("在线预览仅支持浏览，请下载桌面版进行此操作");

import { useEffect } from "react";

const textInputTypes = new Set([
  "text",
  "search",
  "email",
  "password",
  "tel",
  "url",
  "number",
]);
const editingKeys = new Set(["a", "c", "v", "x", "y", "z"]);

function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Node ? target : null;
  if (element instanceof HTMLInputElement) {
    return !element.disabled && textInputTypes.has(element.type);
  }
  if (element instanceof HTMLTextAreaElement) return !element.disabled;
  const container =
    element instanceof HTMLElement ? element : element?.parentElement;
  return container?.isContentEditable === true;
}

export function useDesktopInteractions() {
  useEffect(() => {
    const preventOutsideEditor = (event: Event) => {
      if (!isTextEditingTarget(event.target)) event.preventDefault();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.isComposing &&
        editingKeys.has(event.key.toLowerCase())
      ) {
        preventOutsideEditor(event);
      }
    };
    // 剪贴板和选择事件也覆盖系统菜单触发的操作；显式复制按钮仍正常工作。
    const guardedEvents = ["copy", "cut", "paste", "selectstart"] as const;
    document.addEventListener("keydown", handleKeyDown, true);
    guardedEvents.forEach((name) =>
      document.addEventListener(name, preventOutsideEditor, true),
    );
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      guardedEvents.forEach((name) =>
        document.removeEventListener(name, preventOutsideEditor, true),
      );
    };
  }, []);
}

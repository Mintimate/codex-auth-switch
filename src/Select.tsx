import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

// 保留原生菜单和键盘操作，统一各平台的箭头、留白和交互状态。
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-control">
      <select {...props} />
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}

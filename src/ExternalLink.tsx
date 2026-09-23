import { openUrl } from "@tauri-apps/plugin-opener";
import { isPublicDemo } from "./runtime";
import type { ComponentPropsWithoutRef, MouseEvent } from "react";

type ExternalLinkProps = Omit<
  ComponentPropsWithoutRef<"a">,
  "href" | "target" | "rel" | "onClick"
> & {
  href: string;
  onOpen?: () => void;
  onOpenError: () => void;
};

export function ExternalLink({
  href,
  onOpen,
  onOpenError,
  ...props
}: ExternalLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onOpen?.();
    if (isPublicDemo || !("__TAURI_INTERNALS__" in window)) return;
    event.preventDefault();
    void openUrl(event.currentTarget.href).catch(() => onOpenError());
  }

  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={handleClick}
    />
  );
}

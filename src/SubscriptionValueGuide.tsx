import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, MousePointer2, X } from "lucide-react";
import type { Translate } from "./i18n";
import "./SubscriptionValueGuide.css";

type Bounds = { left: number; top: number; width: number; height: number };
type Placement = {
  target: Bounds;
  card: Bounds;
  side: "top" | "bottom" | "left" | "right";
  arrow: number;
};
const focusable =
  'button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]';
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

export function SubscriptionValueGuide({
  targetSelector,
  step,
  total,
  title,
  description,
  hint,
  nextDisabled = false,
  onNext,
  onPrevious,
  onClose,
  action,
  t,
}: {
  targetSelector: string;
  step: number;
  total: number;
  title: string;
  description: string;
  hint?: string;
  nextDisabled?: boolean;
  onNext: () => void;
  onPrevious?: () => void;
  onClose: () => void;
  action?: { label: string; onClick: () => void; disabled: boolean };
  t: Translate;
}) {
  const id = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [placement, setPlacement] = useState<Placement | null>(null);
  const positioned = placement !== null;

  useEffect(() => {
    if (positioned) titleRef.current?.focus({ preventScroll: true });
  }, [step, positioned]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      // 引导中的真实控件和气泡按钮一起参与键盘导航。
      const controls = [targetRef.current, cardRef.current]
        .flatMap((root) =>
          root
            ? [
                ...(root.matches(focusable) ? [root] : []),
                ...root.querySelectorAll<HTMLElement>(focusable),
              ]
            : [],
        )
        .filter((node) => node.getClientRects().length > 0);
      if (!controls.length) return;
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next =
        index < 0
          ? event.shiftKey
            ? controls.length - 1
            : 0
          : (index + (event.shiftKey ? -1 : 1) + controls.length) %
            controls.length;
      event.preventDefault();
      controls[next].focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    const card = cardRef.current;
    targetRef.current = target;
    if (!target || !card) {
      setPlacement(null);
      return;
    }
    let frame = 0;
    const update = () => {
      let rect = target.getBoundingClientRect();
      const width = window.innerWidth;
      const height = window.innerHeight;
      const margin = 12;
      const gap = 16;
      const cardWidth = card.offsetWidth;
      const cardHeight = card.offsetHeight;
      if (rect.top > height - margin || rect.bottom < margin) {
        target.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        });
        rect = target.getBoundingClientRect();
      }
      if (
        rect.right + gap + cardWidth > width - margin &&
        rect.left - gap - cardWidth < margin &&
        rect.top - gap - cardHeight < margin &&
        rect.bottom + gap + cardHeight > height - margin
      ) {
        target.scrollIntoView({
          block: "end",
          inline: "nearest",
          behavior: "instant",
        });
        rect = target.getBoundingClientRect();
      }
      const left = clamp(rect.left - 7, 4, width - 4);
      const top = clamp(rect.top - 7, 4, height - 4);
      const right = clamp(rect.right + 7, left, width - 4);
      const bottom = clamp(rect.bottom + 7, top, height - 4);
      let side: Placement["side"] = "bottom";
      let x = clamp(left, margin, width - cardWidth - margin);
      let y = bottom + gap;
      if (right + gap + cardWidth <= width - margin) {
        side = "right";
        x = right + gap;
        y = clamp(
          (top + bottom - cardHeight) / 2,
          margin,
          height - cardHeight - margin,
        );
      } else if (left - gap - cardWidth >= margin) {
        side = "left";
        x = left - gap - cardWidth;
        y = clamp(
          (top + bottom - cardHeight) / 2,
          margin,
          height - cardHeight - margin,
        );
      } else if (bottom + gap + cardHeight <= height - margin) {
        y = bottom + gap;
      } else {
        side = "top";
        y = clamp(top - gap - cardHeight, margin, height - cardHeight - margin);
      }
      setPlacement({
        target: { left, top, width: right - left, height: bottom - top },
        card: { left: x, top: y, width: cardWidth, height: cardHeight },
        side,
        arrow:
          side === "left" || side === "right"
            ? clamp((top + bottom) / 2 - y, 20, cardHeight - 20)
            : clamp((left + right) / 2 - x, 20, cardWidth - 20),
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    target.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    });
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    observer.observe(card);
    const page = target.closest(".subscription-value-page");
    if (page) observer.observe(page);
    // capture 同时覆盖桌面工作区、演示页和详情展开后的滚动。
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [targetSelector, step]);

  const target = placement?.target;
  return createPortal(
    <div className="cost-tour-layer">
      {target && (
        <>
          <div
            className="cost-tour-shade"
            style={{ inset: `0 0 auto 0`, height: target.top }}
            aria-hidden="true"
          />
          <div
            className="cost-tour-shade"
            style={{
              left: 0,
              top: target.top,
              width: target.left,
              height: target.height,
            }}
            aria-hidden="true"
          />
          <div
            className="cost-tour-shade"
            style={{
              left: target.left + target.width,
              right: 0,
              top: target.top,
              height: target.height,
            }}
            aria-hidden="true"
          />
          <div
            className="cost-tour-shade"
            style={{
              left: 0,
              right: 0,
              top: target.top + target.height,
              bottom: 0,
            }}
            aria-hidden="true"
          />
          <div
            className="cost-tour-spotlight"
            style={target}
            aria-hidden="true"
          >
            <MousePointer2 className="cost-tour-pointer" size={28} />
          </div>
        </>
      )}
      {placement && (
        <span
          className="cost-tour-arrow"
          aria-hidden="true"
          style={{
            left:
              placement.side === "right"
                ? placement.card.left
                : placement.side === "left"
                  ? placement.card.left + placement.card.width
                  : placement.card.left + placement.arrow,
            top:
              placement.side === "bottom"
                ? placement.card.top
                : placement.side === "top"
                  ? placement.card.top + placement.card.height
                  : placement.card.top + placement.arrow,
          }}
        />
      )}
      <div
        ref={cardRef}
        className="cost-tour-card"
        role="dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        style={{
          left: placement?.card.left ?? 12,
          top: placement?.card.top ?? 12,
          visibility: placement ? "visible" : "hidden",
        }}
        data-placement={placement?.side}
      >
        <div className="cost-tour-heading">
          <span>{t("costStepProgress", { step: step + 1, total })}</span>
          <button
            type="button"
            className="quota-icon-button"
            onClick={onClose}
            aria-label={t("costWelcomeClose")}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        <p id={`${id}-description`}>{description}</p>
        {hint && (
          <p className="cost-tour-hint" role="status">
            {hint}
          </p>
        )}
        {action && (
          <button
            type="button"
            className="text-button cost-tour-retry"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        )}
        <div className="cost-tour-actions">
          <button
            type="button"
            className="text-button cost-tour-skip"
            onClick={onClose}
          >
            {t("costWelcomeSkip")}
          </button>
          {onPrevious && (
            <button
              type="button"
              className="button secondary"
              onClick={onPrevious}
              aria-label={t("costPreviousStep")}
              title={t("costPreviousStep")}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="button primary"
            disabled={nextDisabled}
            onClick={onNext}
          >
            {t(step === total - 1 ? "costTourDone" : "costWelcomeNext")}
            {step === total - 1 ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <ArrowRight size={15} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

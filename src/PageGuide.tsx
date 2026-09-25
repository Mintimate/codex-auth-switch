import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  MousePointer2,
  X,
} from "lucide-react";
import type { Translate } from "./i18n";
import "./PageGuide.css";
import {
  guideStorageKey,
  readGuideOutcome,
  saveGuideOutcome,
  type GuideOutcome,
} from "./guideState";

type Bounds = { left: number; top: number; width: number; height: number };
type Placement = {
  target: Bounds | null;
  card: Bounds;
  side: "top" | "bottom" | "left" | "right";
  arrow: number;
};
const focusable =
  'button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]';
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

function hasBusinessDialog() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'dialog[open], [role="dialog"][aria-modal="true"]',
    ),
  ].some(
    (node) =>
      !node.closest('[aria-hidden="true"]') && node.getClientRects().length > 0,
  );
}

export function GuideSpotlight({
  targetSelector,
  interactive = true,
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
  interactive?: boolean;
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
  const [suspended, setSuspended] = useState(false);
  const positioned = placement !== null;

  useEffect(() => {
    if (positioned && !suspended)
      titleRef.current?.focus({ preventScroll: true });
  }, [step, positioned, suspended]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      // 原生业务弹窗拥有顶层与焦点，引导暂停处理按键。
      if (hasBusinessDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      // 引导中的真实控件和气泡按钮一起参与键盘导航。
      const controls = [interactive ? targetRef.current : null, cardRef.current]
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
      if (!hasBusinessDialog()) {
        const returnTarget =
          previousFocus instanceof HTMLElement &&
          previousFocus.isConnected &&
          previousFocus !== document.body
            ? previousFocus
            : document.querySelector<HTMLElement>(
                ".page-guide-button, .cost-page-actions button",
              );
        returnTarget?.focus({ preventScroll: true });
      }
    };
  }, [interactive]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let frame = 0;
    let observedTarget: HTMLElement | null = null;
    const update = () => {
      const modalOpen = hasBusinessDialog();
      setSuspended(modalOpen);
      if (modalOpen) return;
      const target = document.querySelector<HTMLElement>(targetSelector);
      targetRef.current = target;
      if (target !== observedTarget) {
        if (observedTarget) observer.unobserve(observedTarget);
        observedTarget = target;
        if (target) {
          observer.observe(target);
          target.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "instant",
          });
        }
      }
      if (!target || !target.getClientRects().length) {
        // 异步区域未出现或被过滤时，仍提供可关闭的说明卡，不留下隐形焦点约束。
        setPlacement({
          target: null,
          card: {
            left: Math.max(12, (window.innerWidth - card.offsetWidth) / 2),
            top: Math.max(12, (window.innerHeight - card.offsetHeight) / 2),
            width: card.offsetWidth,
            height: card.offsetHeight,
          },
          side: "bottom",
          arrow: 0,
        });
        return;
      }
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
    const observer = new ResizeObserver(schedule);
    observer.observe(card);
    const page = document
      .querySelector<HTMLElement>(targetSelector)
      ?.closest('[role="tabpanel"]');
    if (page) observer.observe(page);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "hidden", "aria-hidden", "class"],
    });
    update();
    // capture 同时覆盖桌面工作区、演示页和详情展开后的滚动。
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [targetSelector, step]);

  const target = placement?.target;
  // 挖洞和描边共用同一条圆角轮廓，描边覆盖抗锯齿边缘，避免圆角处漏出亮缝。
  const outline = target
    ? {
        x: target.left + 1,
        y: target.top + 1,
        width: Math.max(0, target.width - 2),
        height: Math.max(0, target.height - 2),
        rx: 11,
      }
    : null;
  return createPortal(
    <div
      className="page-tour-layer"
      style={{ display: suspended ? "none" : undefined }}
    >
      {!target && (
        <div
          className="page-tour-shade"
          style={{ inset: 0 }}
          aria-hidden="true"
        />
      )}
      {target && outline && (
        <>
          <svg className="page-tour-mask" aria-hidden="true">
            <defs>
              <mask
                id={`${id}-mask`}
                maskUnits="userSpaceOnUse"
                x="0"
                y="0"
                width="100%"
                height="100%"
              >
                <rect width="100%" height="100%" fill="white" />
                <rect {...outline} fill="black" />
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="var(--overlay)"
              mask={`url(#${id}-mask)`}
            />
            <rect
              {...outline}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
            />
          </svg>
          <div
            className="page-tour-shield"
            style={{ inset: `0 0 auto 0`, height: target.top }}
            aria-hidden="true"
          />
          <div
            className="page-tour-shield"
            style={{
              left: 0,
              top: target.top,
              width: target.left,
              height: target.height,
            }}
            aria-hidden="true"
          />
          <div
            className="page-tour-shield"
            style={{
              left: target.left + target.width,
              right: 0,
              top: target.top,
              height: target.height,
            }}
            aria-hidden="true"
          />
          <div
            className="page-tour-shield"
            style={{
              left: 0,
              right: 0,
              top: target.top + target.height,
              bottom: 0,
            }}
            aria-hidden="true"
          />
          {!interactive && (
            <div
              className="page-tour-blocker"
              style={target}
              aria-hidden="true"
            />
          )}
          <div
            className="page-tour-spotlight"
            style={target}
            aria-hidden="true"
          >
            {interactive && (
              <MousePointer2 className="page-tour-pointer" size={28} />
            )}
          </div>
        </>
      )}
      {placement?.target && (
        <span
          className="page-tour-arrow"
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
        className="page-tour-card"
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
        <div className="page-tour-heading">
          <span>{t("guideStepProgress", { step: step + 1, total })}</span>
          <button
            type="button"
            className="quota-icon-button"
            onClick={onClose}
            aria-label={t("guideClose")}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        <p id={`${id}-description`}>{description}</p>
        {placement && !placement.target && (
          <p className="page-tour-hint">{t("guideTargetUnavailable")}</p>
        )}
        {hint && (
          <p className="page-tour-hint" role="status">
            {hint}
          </p>
        )}
        {action && (
          <button
            type="button"
            className="text-button page-tour-retry"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        )}
        <div className="page-tour-actions">
          <button
            type="button"
            className="text-button page-tour-skip"
            onClick={onClose}
          >
            {t("guideSkip")}
          </button>
          {onPrevious && (
            <button
              type="button"
              className="button secondary"
              onClick={onPrevious}
              aria-label={t("guidePrevious")}
              title={t("guidePrevious")}
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
            {t(step === total - 1 ? "guideDone" : "guideNext")}
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

export function usePageGuide({
  page,
  variant,
  ready,
  automatic = false,
}: {
  page: string;
  variant: string;
  ready: boolean;
  automatic?: boolean;
}) {
  const key = guideStorageKey(page, variant);
  const initialOutcome = useMemo(() => readGuideOutcome(key), [key]);
  const [saved, setSaved] = useState<{
    key: string;
    outcome: GuideOutcome;
  } | null>(null);
  const outcome = saved?.key === key ? saved.outcome : initialOutcome;
  const [tour, setTour] = useState<{ key: string; step: number } | null>(null);
  const open = ready && tour?.key === key;

  useEffect(() => {
    setTour((current) => {
      // 状态变化后丢弃旧步骤；之后重回空态或错误态不自动复活手动指引。
      const sameVariant = current?.key === key ? current : null;
      return (
        sameVariant ??
        (automatic && ready && !outcome ? { key, step: 0 } : null)
      );
    });
  }, [automatic, ready, outcome, key]);

  const remember = (value: GuideOutcome) => {
    saveGuideOutcome(key, value);
    setSaved({ key, outcome: value });
    setTour(null);
  };
  return {
    key,
    open,
    ready,
    step: tour?.key === key ? tour.step : 0,
    showInvitation: ready && !automatic && !open && !outcome,
    start: () => {
      if (ready) setTour({ key, step: 0 });
    },
    setStep: (step: number) => setTour({ key, step }),
    close: () => remember("skipped"),
    finish: () => remember("completed"),
  };
}

type PageGuideState = ReturnType<typeof usePageGuide>;
export type GuideStep = {
  target: string;
  title: string;
  description: string;
  interactive?: boolean;
};

export function GuideButton({
  onClick,
  disabled = false,
  t,
}: {
  onClick: () => void;
  disabled?: boolean;
  t: Translate;
}) {
  return (
    <button
      type="button"
      className="text-button page-guide-button"
      onClick={onClick}
      disabled={disabled}
    >
      <CircleHelp size={15} aria-hidden="true" />
      {t("guideOpen")}
    </button>
  );
}

export function GuideInvitation({
  guide,
  t,
}: {
  guide: PageGuideState;
  t: Translate;
}) {
  if (!guide.showInvitation) return null;
  return (
    <aside
      className="page-guide-invitation"
      aria-label={t("guideInvitationTitle")}
    >
      <div>
        <strong>{t("guideInvitationTitle")}</strong>
        <p>{t("guideInvitationBody")}</p>
      </div>
      <div className="page-guide-actions">
        <button type="button" className="text-button" onClick={guide.start}>
          {t("guideStart")}
        </button>
        <button
          type="button"
          className="quota-icon-button"
          onClick={guide.close}
          aria-label={t("guideDismissInvitation")}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}

export function PageGuide({
  guide,
  steps,
  t,
}: {
  guide: PageGuideState;
  steps: GuideStep[];
  t: Translate;
}) {
  if (!guide.open || !steps.length) return null;
  const index = Math.min(guide.step, steps.length - 1);
  const step = steps[index];
  return (
    <GuideSpotlight
      key={guide.key}
      targetSelector={step.target}
      interactive={step.interactive ?? false}
      step={index}
      total={steps.length}
      title={step.title}
      description={step.description}
      hint={step.interactive ? undefined : t("guideReadOnlyHint")}
      onNext={() =>
        index === steps.length - 1 ? guide.finish() : guide.setStep(index + 1)
      }
      onPrevious={index ? () => guide.setStep(index - 1) : undefined}
      onClose={guide.close}
      t={t}
    />
  );
}

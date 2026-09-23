import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { AccountQuota, AccountSummary } from "./api";
import type { Locale, Translate } from "./i18n";
import { QuotaHistoryPanel } from "./QuotaHistoryPanel";
import { QuotaCard } from "./QuotaCard";
import type { QuotaDetailView } from "./quotaView";

type Props = {
  accounts: AccountSummary[];
  account: AccountSummary;
  activeAccountId: string | null;
  displayLabel: (label: string) => string;
  locale: Locale;
  t: Translate;
  initialView: QuotaDetailView;
  onAccountChange: (id: string) => void;
  onClose: () => void;
  quota: AccountQuota | null;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
};

export function QuotaDetailDialog({
  accounts,
  account,
  activeAccountId,
  displayLabel,
  locale,
  t,
  initialView,
  onAccountChange,
  onClose,
  quota,
  refreshing,
  refreshError,
  onRefresh,
}: Props) {
  const [view, setView] = useState(initialView);
  const id = useId();
  const tabsRef = useRef<
    Partial<Record<QuotaDetailView, HTMLButtonElement | null>>
  >({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="quota-detail-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <div className="quota-detail-header">
        <h2 id={`${id}-title`}>{t("quotaAccountDetails")}</h2>
        <select
          aria-label={t("quotaSelectAccount")}
          value={account.id}
          onChange={(event) => onAccountChange(event.target.value)}
        >
          {accounts.map((item) => (
            <option key={item.id} value={item.id}>
              {displayLabel(item.label)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="quota-icon-button"
          autoFocus
          onClick={onClose}
          title={t("close")}
          aria-label={t("close")}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div
        className="quota-detail-tabs"
        role="tablist"
        aria-label={t("quotaAccountDetails")}
      >
        {(["quota", "usage", "history"] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            ref={(element) => {
              tabsRef.current[tab] = element;
            }}
            id={`${id}-tab-${tab}`}
            aria-selected={view === tab}
            aria-controls={`${id}-content`}
            tabIndex={view === tab ? 0 : -1}
            onClick={() => setView(tab)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const tabs = ["quota", "usage", "history"] as const;
              const index = tabs.indexOf(view);
              const next =
                tabs[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 2
                      : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3
                ];
              setView(next);
              tabsRef.current[next]?.focus();
            }}
          >
            {t(
              tab === "quota"
                ? "quotaTab"
                : tab === "history"
                  ? "historyTitle"
                  : "officialAccountUsage",
            )}
          </button>
        ))}
      </div>
      <div
        className="quota-detail-body"
        id={`${id}-content`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${view}`}
        tabIndex={0}
      >
        {view === "history" ? (
          <QuotaHistoryPanel
            key={account.id}
            profileId={account.id}
            revision={quota?.queriedAt}
            warning={quota?.historyWarning}
            queryFailed={Boolean(refreshError)}
            refreshing={refreshing}
            locale={locale}
            t={t}
            onRefreshQuota={onRefresh}
          />
        ) : (
          <QuotaCard
            activeAccountId={activeAccountId}
            account={account}
            accountLabel={displayLabel(account.label)}
            locale={locale}
            quota={quota}
            refreshing={refreshing}
            refreshError={refreshError}
            onRefresh={onRefresh}
            view={view}
            t={t}
          />
        )}
      </div>
    </dialog>,
    document.body,
  );
}

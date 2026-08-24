import {
  AccountQuota,
  TokenBreakdown,
  UsageOverview,
  UsageWindow,
} from "./api";

type UsagePanelProps = {
  usage: UsageOverview | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

const compactNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fullNumber = new Intl.NumberFormat("zh-CN");

const formatTokens = (value: number) => compactNumber.format(value);

const formatWindow = (minutes: number | null) => {
  if (!minutes) return "额度窗口";
  if (minutes === 300) return "5 小时窗口";
  if (minutes === 10080) return "7 天窗口";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
};

const formatReset = (timestamp: number | null) => {
  if (!timestamp) return "重置时间未知";
  return `重置于 ${new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000)}`;
};

function MetricCard({
  label,
  tokens,
  emphasis = false,
}: {
  label: string;
  tokens: TokenBreakdown;
  emphasis?: boolean;
}) {
  return (
    <article className={`usage-metric ${emphasis ? "emphasis" : ""}`}>
      <span>{label}</span>
      <strong title={`${fullNumber.format(tokens.totalTokens)} tokens`}>
        {formatTokens(tokens.totalTokens)}
      </strong>
      <small>tokens</small>
    </article>
  );
}

function QuotaWindow({ window }: { window: UsageWindow }) {
  const percent = Math.round(window.usedPercent * 10) / 10;
  return (
    <div className="quota-window">
      <div className="quota-window-copy">
        <span>{formatWindow(window.windowMinutes)}</span>
        <strong>{percent}%</strong>
      </div>
      <div
        className="quota-track"
        role="progressbar"
        aria-label={`${formatWindow(window.windowMinutes)}已使用`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <small>{formatReset(window.resetsAt)}</small>
    </div>
  );
}

function QuotaCard({
  quota,
  accountTokens,
}: {
  quota: AccountQuota;
  accountTokens: TokenBreakdown | undefined;
}) {
  return (
    <article className="quota-card">
      <div className="quota-account">
        <div>
          <strong>{quota.label}</strong>
          <span>
            {accountTokens ? "近 30 天本机归属用量" : "暂无本机归属用量"}
          </span>
        </div>
        <b
          title={
            accountTokens
              ? fullNumber.format(accountTokens.totalTokens)
              : undefined
          }
        >
          {accountTokens ? (
            <>
              {formatTokens(accountTokens.totalTokens)}
              <small>tokens</small>
            </>
          ) : (
            "—"
          )}
        </b>
      </div>
      {quota.success ? (
        <div className="quota-windows">
          {quota.primary && <QuotaWindow window={quota.primary} />}
          {quota.secondary && <QuotaWindow window={quota.secondary} />}
          {!quota.primary && !quota.secondary && (
            <p className="quota-empty">当前账号没有返回可展示的额度窗口。</p>
          )}
        </div>
      ) : (
        <p className="quota-error">{quota.error ?? "额度查询失败"}</p>
      )}
    </article>
  );
}

export function UsagePanel({
  usage,
  loading,
  error,
  onRefresh,
}: UsagePanelProps) {
  const maxDaily = Math.max(
    1,
    ...(usage?.local.daily.map((day) => day.tokens.totalTokens) ?? []),
  );
  const byAccount = new Map(
    usage?.local.byAccount.map((account) => [
      account.accountId,
      account.tokens,
    ]),
  );
  const breakdown = usage?.local.thirtyDays;

  return (
    <section className="usage-section">
      <div className="section-heading usage-heading">
        <div>
          <span className="eyebrow">Usage insight</span>
          <h2>Token 用量与订阅额度</h2>
          <p>Token 来自本机会话，额度百分比来自在线窗口查询。</p>
        </div>
        <button className="text-button" disabled={loading} onClick={onRefresh}>
          {loading ? "统计中…" : "刷新用量"}
        </button>
      </div>

      {error && (
        <div className="usage-inline-error">
          <span>{error}</span>
          <button type="button" onClick={onRefresh}>
            重试
          </button>
        </div>
      )}

      {!usage && loading ? (
        <div className="usage-loading" role="status">
          正在汇总本机 Token 并查询账号额度…
        </div>
      ) : usage ? (
        <>
          <div className="usage-metrics">
            <MetricCard label="今天" tokens={usage.local.today} emphasis />
            <MetricCard label="近 7 天" tokens={usage.local.sevenDays} />
            <MetricCard label="近 30 天" tokens={usage.local.thirtyDays} />
          </div>

          <div className="usage-insights">
            <article className="trend-card">
              <div className="usage-card-title">
                <div>
                  <strong>14 天趋势</strong>
                  <span>{usage.local.eventsCount} 个用量事件</span>
                </div>
                <small>{usage.local.filesScanned} 个会话文件</small>
              </div>
              <div
                className="trend-bars"
                aria-label="最近 14 天 Token 用量趋势"
              >
                {usage.local.daily.map((day) => (
                  <div className="trend-column" key={day.date}>
                    <span
                      title={`${day.date} · ${fullNumber.format(day.tokens.totalTokens)} tokens`}
                      style={{
                        height: `${Math.max(5, (day.tokens.totalTokens / maxDaily) * 100)}%`,
                      }}
                    />
                    <small>{day.date.slice(8)}</small>
                  </div>
                ))}
              </div>
            </article>

            {breakdown && (
              <article className="breakdown-card">
                <div className="usage-card-title">
                  <div>
                    <strong>近 30 天构成</strong>
                    <span>缓存与推理为对应 Token 的子集</span>
                  </div>
                </div>
                <dl className="breakdown-list">
                  <div>
                    <dt>输入</dt>
                    <dd>{formatTokens(breakdown.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>缓存输入</dt>
                    <dd>{formatTokens(breakdown.cachedInputTokens)}</dd>
                  </div>
                  <div>
                    <dt>输出</dt>
                    <dd>{formatTokens(breakdown.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>推理输出</dt>
                    <dd>{formatTokens(breakdown.reasoningOutputTokens)}</dd>
                  </div>
                </dl>
              </article>
            )}
          </div>

          <div className="quota-heading">
            <div>
              <strong>账号归属与额度</strong>
              <span>
                数字为近 30 天本机归属 Token，下方百分比为订阅窗口已用额度
              </span>
            </div>
            {usage.local.unassigned.totalTokens > 0 && (
              <small
                title={`${fullNumber.format(usage.local.unassigned.totalTokens)} tokens`}
              >
                历史未归属 {formatTokens(usage.local.unassigned.totalTokens)}
              </small>
            )}
          </div>
          {usage.quotas.length ? (
            <div className="quota-list">
              {usage.quotas.map((quota) => (
                <QuotaCard
                  key={quota.profileId}
                  quota={quota}
                  accountTokens={byAccount.get(quota.accountId)}
                />
              ))}
            </div>
          ) : (
            <div className="quota-empty standalone">
              保存账号后即可查看订阅窗口。
            </div>
          )}

          <p className="usage-privacy-note">
            只提取会话中的 token_count 元数据，不解析提示词或回复正文。Token
            数字不是订阅总额度；账号归属从本版本记录切换历史后开始生效。
          </p>
        </>
      ) : null}
    </section>
  );
}

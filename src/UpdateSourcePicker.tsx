import { ArrowUpRight } from "lucide-react";
import { useId, useState } from "react";
import type { AppUpdateSource } from "./api";
import { BrandIcon } from "./BrandIcon";
import { ExternalLink } from "./ExternalLink";
import type { MessageKey, Translate } from "./i18n";
import { PROJECT_LINKS } from "./projectLinks";
import "./UpdateSourcePicker.css";

const sources = [
  {
    value: "github",
    name: "GitHub",
    caption: "updateSourceGitHubCaption",
    description: "updateSourceGitHubDescription",
    releasesUrl: PROJECT_LINKS.githubReleases,
  },
  {
    value: "cnb",
    name: "CNB",
    caption: "updateSourceCnbCaption",
    description: "updateSourceCnbDescription",
    releasesUrl: PROJECT_LINKS.cnbReleases,
  },
] satisfies {
  value: AppUpdateSource;
  name: string;
  caption: MessageKey;
  description: MessageKey;
  releasesUrl: string;
}[];

export function UpdateSourcePicker({
  value,
  disabled,
  onChange,
  t,
}: {
  value: AppUpdateSource;
  disabled: boolean;
  onChange: (source: AppUpdateSource) => void;
  t: Translate;
}) {
  const id = useId();
  const [linkFailed, setLinkFailed] = useState(false);

  return (
    <div className="settings-update-sources">
      <fieldset
        className="update-source-picker"
        aria-describedby={`${id}-hint`}
      >
        <legend>{t("updateSource")}</legend>
        <div className="update-source-grid">
          {sources.map(
            ({ value: source, name, caption, description, releasesUrl }) => (
              <article
                className={`update-source-card${value === source ? " is-selected" : ""}`}
                data-source={source}
                key={source}
              >
                <label
                  className={`update-source-option${disabled ? " is-disabled" : ""}`}
                >
                  <span className="update-source-card-heading">
                    <BrandIcon
                      brand={source}
                      size={21}
                      className="update-source-icon"
                    />
                    <span className="update-source-title">
                      <strong>{name}</strong>
                      <span>{t(caption)}</span>
                    </span>
                    <input
                      type="radio"
                      name={`${id}-source`}
                      value={source}
                      checked={value === source}
                      disabled={disabled}
                      aria-label={name}
                      aria-describedby={`${id}-${source}-description`}
                      onChange={() => onChange(source)}
                    />
                  </span>
                  <span
                    className="update-source-description"
                    id={`${id}-${source}-description`}
                  >
                    {t(description)}
                  </span>
                </label>
                <ExternalLink
                  className="update-source-release-link"
                  href={releasesUrl}
                  aria-label={t("openSourceReleases", { source: name })}
                  onOpen={() => setLinkFailed(false)}
                  onOpenError={() => setLinkFailed(true)}
                >
                  {t("openReleases")}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </ExternalLink>
              </article>
            ),
          )}
        </div>
      </fieldset>
      <div className="update-source-notes">
        <p>
          {t("updateSourceCnbThanks")}{" "}
          <span id={`${id}-hint`}>{t("updateSourceHint")}</span>
        </p>
      </div>
      {linkFailed && (
        <p className="update-source-link-error" role="alert">
          {t("openReleasesFailed")}
        </p>
      )}
    </div>
  );
}

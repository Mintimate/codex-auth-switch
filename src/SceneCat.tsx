import "./SceneCat.css";

type SceneCatProps = {
  className?: string;
};

export function SceneCat({ className }: SceneCatProps) {
  const classes = ["scene-cat", className].filter(Boolean).join(" ");

  return (
    <svg
      className={classes}
      viewBox="0 0 72 62"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="scene-cat-tail"
        d="M48 45c11 5 20-1 18-11-1-6-7-8-10-4-2 3 0 7 4 7"
      />
      <ellipse className="scene-cat-fur" cx="36" cy="45" rx="18" ry="12" />
      <path
        className="scene-cat-fur scene-cat-head"
        d="M18.5 24.5 17 7l11 7.2a18 18 0 0 1 9-.3L47 6l-1 18.3c2 3.2 1.3 8.1-1.5 11-2.7 2.8-7 4.2-12 4.2-5.1 0-9.3-1.4-12-4.2-2.8-2.8-3.6-7.6-2-10.8Z"
      />
      <path
        className="scene-cat-inner-ear"
        d="m20.5 12 6.2 4.4-5.4 2.3Zm22.8 4.1L44 11l-5.7 5.4Z"
      />
      <path
        className="scene-cat-stripe"
        d="m29 16 1.2 4m4-4.8v4.4m4.1-3.2-1 3.8"
      />
      <ellipse className="scene-cat-eye" cx="27.2" cy="26" rx="1.7" ry="2" />
      <ellipse className="scene-cat-eye" cx="38.8" cy="26" rx="1.7" ry="2" />
      <path className="scene-cat-nose" d="m30.7 30.2 2.3 1.7 2.3-1.7Z" />
      <path
        className="scene-cat-face"
        d="M33 31.8v2m0 0c-2.1 0-3.1 1-3.7 2m3.7-2c2.1 0 3.1 1 3.7 2"
      />
      <path
        className="scene-cat-whisker"
        d="m25 31-8-1m8.3 3.7-7.6 1.8m23.3-4.4 8-1m-8.3 3.7 7.6 1.8"
      />
      <path
        className="scene-cat-chest"
        d="M31 40c1.1 2.1 2.6 3.2 5 3.2 2.2 0 3.8-1.1 5-3.2"
      />
      <path
        className="scene-cat-paw"
        d="M27 50v7h8v-7m2 0v7h8v-7M29.5 57v-2m10 2v-2"
      />
    </svg>
  );
}

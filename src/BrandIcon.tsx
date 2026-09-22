import githubIcon from "./assets/brands/github.svg";
import cnbIcon from "./assets/brands/cnb.svg";
import "./BrandIcon.css";

const icons = { github: githubIcon, cnb: cnbIcon };

export type Brand = keyof typeof icons;

export function BrandIcon({
  brand,
  size = 20,
  className = "",
}: {
  brand: Brand;
  size?: number;
  className?: string;
}) {
  const maskImage = `url("${icons[brand]}")`;
  return (
    <span
      className={`brand-icon ${className}`.trim()}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        maskImage,
        WebkitMaskImage: maskImage,
      }}
    />
  );
}

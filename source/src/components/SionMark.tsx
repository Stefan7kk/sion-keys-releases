import originalLogo from "../assets/about-logo.png";

export function SionMark({ className }: { className?: string }) {
  return (
    <img
      className={className ? `sion-mark ${className}` : "sion-mark"}
      src={originalLogo}
      alt=""
      draggable={false}
      width={1254}
      height={1254}
    />
  );
}

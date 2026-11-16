import wordmark from "../assets/sion-wordmark-ice.png";

export function SionWordmark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <img
      className={className ? `sion-wordmark ${className}` : "sion-wordmark"}
      src={wordmark}
      alt={decorative ? "" : "Sion Keys"}
      width={1777}
      height={436}
      draggable={false}
    />
  );
}

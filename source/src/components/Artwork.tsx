import { useId } from "react";

export function SongArt({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg className={className} viewBox="0 0 96 64" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-p`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#4b2f9e" />
          <stop offset=".55" stopColor="#332178" />
          <stop offset="1" stopColor="#1c1450" />
        </linearGradient>
        <radialGradient id={`${id}-g`}>
          <stop stopColor="#c07bff" stopOpacity=".8" />
          <stop offset="1" stopColor="#c07bff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="96" height="64" fill={`url(#${id}-p)`} />
      <circle cx="66" cy="20" r="22" fill={`url(#${id}-g)`} />
      <path d="M0 44 18 28l14 12 20-16 18 16 14-10 12 10V64H0Z" fill="#241a62" />
      <path d="m52 24 7 7-4-.5-3 3-3-3-4 .5Z" fill="#e6d9ff" opacity=".8" />
      <path d="M0 52 24 40l22 10 26-12 24 10V64H0Z" fill="#170f45" />
    </svg>
  );
}

export function RibbonWave({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <g fill="none" stroke="currentColor" strokeWidth=".8">
      {Array.from({ length: 16 }, (_, i) => <path key={i} opacity={.18 + (15 - i) * .032} d={`M-30 ${10 + i * 4} C60 ${5 + i * 5} 96 ${95 + i} 220 ${72 + i * 1.4} S345 ${42 + i * 3} 440 ${69 + i * 1.5} S572 ${42 + i * 2.8} 655 ${64 + i * 1.9} S788 ${93 + i} 860 ${70 + i * 1.6} S952 ${42 + i * 2.8} 1030 ${48 + i * 2.8}`} />)}
    </g>
  </svg>;
}

export function ThemeWave() {
  const id = useId();
  const crest = "M0 44C32 47 43 65 77 57S126 19 178 18";
  return <svg viewBox="0 0 180 80" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-fill`} x2="0" y2="1"><stop stopColor="currentColor" stopOpacity=".5" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
      <filter id={`${id}-blur`}><feGaussianBlur stdDeviation="3" /></filter>
    </defs>
    <path d="M0 44C32 47 43 65 77 57S126 19 178 18V3C118 9 98 67 57 54S21 40 0 44Z" fill={`url(#${id}-fill)`} />
    <path d="M0 44C39 46 51 74 86 54S142 23 180 44V80H0Z" fill={`url(#${id}-fill)`} opacity=".55" />
    <g fill="none" stroke="currentColor">
      <path d={crest} strokeWidth="5" filter={`url(#${id}-blur)`} opacity=".8" />
      <path d={crest} strokeWidth="1.7" />
      <path d="M0 44C37 45 48 66 81 53S140 13 180 38 M0 45C40 50 59 65 93 48S138 38 180 53" strokeWidth=".7" opacity=".7" />
    </g>
  </svg>;
}

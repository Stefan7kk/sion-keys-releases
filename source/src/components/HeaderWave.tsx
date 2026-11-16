import type { ThemeId } from "../lib/types";
import blue from "../assets/banner-blue.png";
import ice from "../assets/banner-ice.png";
import orange from "../assets/banner-orange.png";
import purple from "../assets/banner-purple.png";

const banners: Record<ThemeId, string> = { blue, white: ice, orange, purple };

export function HeaderWave({ theme }: { theme: ThemeId }) {
  return <img className="header-wave" src={banners[theme]} alt="" aria-hidden="true" draggable={false} />;
}

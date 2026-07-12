const PRIVATE_SPA_ROBOTS = "noindex, nofollow";

export function robotsHeaderForSpaPath(pathname: string): string | null {
  return pathname === "/" ? null : PRIVATE_SPA_ROBOTS;
}

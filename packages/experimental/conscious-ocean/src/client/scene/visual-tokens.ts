/** Color palette shared by the viewport and region navigation. */

/** Temp-pre material colors shared with the CSS viewport. */
export const visualTokens = {
  void: "#030712",
  ink: "#06172a",
  blue: "#0a66dd",
  cyan: "#38efff",
  mint: "#a8ffe1",
  pearl: "#fcfec4",
  warm: "#ffd9b5",
  coral: "#fcaec1",
  white: "#e8fbff",
  muted: "#9cb7c8",
  violet: "#eed0f2",
  sky: "#96dff5",
}

/** Base field color per known cognitive region kind. */
export const regionTokens = {
  memory: visualTokens.cyan,
  persona: visualTokens.violet,
  goal: visualTokens.warm,
  plan: visualTokens.pearl,
  skill: visualTokens.mint,
  tool: visualTokens.sky,
  session: visualTokens.white,
  environment: visualTokens.warm,
}


/** Region kinds with a dedicated palette entry. */
export type RegionColor = keyof typeof regionTokens

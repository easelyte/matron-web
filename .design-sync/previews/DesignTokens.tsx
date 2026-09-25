import { DesignTokens, MatronThemeProvider } from "matron-web";

export const Surfaces = () => <DesignTokens group="color" match={["-bg-"]} />;

export const InkAndBorders = () => (
  <DesignTokens group="color" match={["color-text-", "color-icon-", "color-border-", "--mj-", "color-usage-"]} />
);

export const SurfacesDark = () => (
  <MatronThemeProvider theme="dark">
    <DesignTokens group="color" match={["-bg-"]} />
  </MatronThemeProvider>
);

export const InkDark = () => (
  <MatronThemeProvider theme="dark">
    <DesignTokens group="color" match={["color-text-", "color-icon-", "color-usage-"]} />
  </MatronThemeProvider>
);

export const TypeRoles = () => <DesignTokens group="font" />;

export const RadiiAndSpacing = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <DesignTokens group="radius" />
    <DesignTokens group="space" />
  </div>
);

export const ShadowsAndStates = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <DesignTokens group="shadow" />
    <DesignTokens group="state" />
  </div>
);

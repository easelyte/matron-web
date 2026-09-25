import { IconCatalog, MatronThemeProvider } from "matron-web";

export const AppIcons = () => <IconCatalog set="icons" />;

export const TrackerGlyphs = () => <IconCatalog set="glyphs" size={24} />;

export const FileKindIcons = () => <IconCatalog set="icons" filter="File" size={24} />;

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <IconCatalog set="icons" filter="Icon" size={18} />
  </MatronThemeProvider>
);

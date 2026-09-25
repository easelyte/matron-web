import { ThemeToggle, MatronThemeProvider } from "matron-web";

export const Default = () => <ThemeToggle />;

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <ThemeToggle />
    </MatronThemeProvider>
);

import { createRoot } from "react-dom/client";
import { TREASURY_ONLY } from "./treasury-surface";
import { TreasuryRoot } from "./treasury-root";
import "./styles.css";
import "./treasury-theme.css";

document.documentElement.classList.toggle("treasury-theme", TREASURY_ONLY);

// Treasury uses dark mode; the shared workspace follows the system theme.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", TREASURY_ONLY || dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(<TreasuryRoot />);

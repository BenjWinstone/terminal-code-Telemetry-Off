import { createRoot } from "react-dom/client";

import "../shared/base.css";
import "./style.css";
import { App } from "./app";
import type { ManagerState } from "./app";

const state = (await (await fetch("/state")).json()) as ManagerState;
createRoot(document.getElementById("root")!).render(<App state={state} />);

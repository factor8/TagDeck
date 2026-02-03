import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LogsWindow } from "./LogsWindow";

const query = new URLSearchParams(window.location.search);
const isLogs = query.get("page") === "logs";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isLogs ? <LogsWindow /> : <App />}
  </React.StrictMode>,
);

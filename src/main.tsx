import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./themes.css";
import "./demo.css";
import { isPublicDemo } from "./runtime";

if (isPublicDemo) {
  document.documentElement.dataset.demo = "true";
  document.title = "Codex Auth Switch · 在线预览";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { Router, type AroundNavHandler } from "wouter";
import { App, preloadRoute } from "./App";
import "./index.css";

let pendingNavigation = 0;

const navigateAfterPreload: AroundNavHandler = (navigate, to, options) => {
  const navigationId = ++pendingNavigation;

  void preloadRoute(to)
    .catch(() => undefined)
    .then(() => {
      // A second click can overtake an earlier, slower chunk request. Only
      // honor the newest destination so late imports cannot pull users back.
      if (navigationId !== pendingNavigation) return;
      React.startTransition(() => navigate(to, options));
    });
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Router aroundNav={navigateAfterPreload}>
      <App />
    </Router>
  </React.StrictMode>
);

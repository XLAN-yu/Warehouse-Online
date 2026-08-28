import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WarehouseApp } from "../../app/WarehouseApp";
import "../../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><WarehouseApp /></StrictMode>,
);

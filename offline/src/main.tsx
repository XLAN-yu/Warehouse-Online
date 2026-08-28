import { createRoot } from "react-dom/client";
import { SignalWorkbench } from "../../app/SignalWorkbench";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Signal Lab offline entry point was not found.");
}

createRoot(root).render(<SignalWorkbench />);

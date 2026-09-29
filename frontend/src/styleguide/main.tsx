import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "maplibre-gl/dist/maplibre-gl.css"
import "../index.css"
import { StyleGuide } from "./StyleGuide"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StyleGuide />
  </StrictMode>,
)

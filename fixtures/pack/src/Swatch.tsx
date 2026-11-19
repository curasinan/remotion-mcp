import { loadFont } from "@remotion/fonts";
import { AbsoluteFill, staticFile } from "remotion";
import type { z } from "zod";
import type { swatchSchema } from "./schemas";

/** The pack's own font, served from public/. A pack never loads a web font: a deployment has no outbound route. */
const FONT_FAMILY = "Pack DejaVu Sans";

let fontLoading: Promise<void> | undefined;

/**
 * Starts loading the pack font, once. loadFont holds the frame with delayRender until the font is ready, and cancels
 * the render if it cannot load. It runs on first render, not at module scope: build-pack imports this module in Node
 * to read the schemas, and Node has no FontFace.
 */
function loadPackFont(): void {
  fontLoading ??= loadFont({ family: FONT_FAMILY, url: staticFile("DejaVuSans-Bold.ttf"), weight: "700" });
}

export const Swatch = ({ label, color }: z.infer<typeof swatchSchema>) => {
  loadPackFont();
  return (
    <AbsoluteFill style={{ backgroundColor: color, justifyContent: "center", alignItems: "center" }}>
      <div style={{ color: "white", fontSize: 96, fontWeight: 700, fontFamily: `"${FONT_FAMILY}"`, whiteSpace: "nowrap" }}>
        {label}
      </div>
    </AbsoluteFill>
  );
};

import { useState } from "react";
import { AbsoluteFill, delayRender } from "remotion";

/**
 * Never finishes its frame. The handle's own 120 s timeout exceeds the CLI's --timeout (60 s), which exceeds the
 * service's 45 s still deadline, so the service deadline, not either Remotion timeout, is what ends the render.
 */
export const Slow = () => {
  useState(() => delayRender("slow", { timeoutInMilliseconds: 120_000 }));
  return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
};

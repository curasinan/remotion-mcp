import { Composition } from "remotion";
import { slowSchema, swatchSchema } from "./schemas";
import { Slow } from "./Slow";
import { Swatch } from "./Swatch";

/**
 * Every composition is registered here, at the top of the tree, with a static size, fps and duration and a schema:
 * scripts/build-pack.mjs calls this function in Node to discover them. Each id is also the template id.
 */
export const RemotionRoot = () => (
  <>
    <Composition
      id="swatch"
      component={Swatch}
      schema={swatchSchema}
      defaultProps={{ label: "Swatch", color: "#1d4ed8" }}
      width={1280}
      height={720}
      fps={30}
      durationInFrames={1}
    />
    <Composition
      id="slow"
      component={Slow}
      schema={slowSchema}
      defaultProps={{}}
      width={64}
      height={64}
      fps={30}
      durationInFrames={1}
    />
  </>
);

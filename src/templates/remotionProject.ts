/**
 * Template for a minimal, correct Remotion 4 project.
 *
 * Kept deliberately small. Every file here exists because omitting it causes a
 * concrete first-run failure: no registerRoot means the CLI finds no
 * compositions, no remotion.config.ts means overrides silently do nothing, and
 * a mismatched React version pair breaks the renderer at bundle time.
 */

export function PROJECT_TEMPLATE(
  remotionVersion: string,
  projectName: string,
): Record<string, string> {
  const safeName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "remotion-video";

  return {
    "package.json": `{
  "name": "${safeName}",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "studio": "remotion studio",
    "render": "remotion render",
    "still": "remotion still",
    "compositions": "remotion compositions",
    "upgrade": "remotion upgrade"
  },
  "dependencies": {
    "@remotion/cli": "${remotionVersion}",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "remotion": "${remotionVersion}"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.2"
  }
}
`,

    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*", "remotion.config.ts"]
}
`,

    "remotion.config.ts": `import { Config } from "@remotion/cli/config";

// Values here are defaults. Every one can be overridden per render by a CLI
// flag, which is what the MCP render tools do.
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(null); // null lets Remotion pick based on CPU count
`,

    ".gitignore": `node_modules
out
dist
.remotion
`,

    "src/index.ts": `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

// The CLI looks for this call. Without it, every command reports zero
// compositions even though the code compiles cleanly.
registerRoot(RemotionRoot);
`,

    "src/Root.tsx": `import React from "react";
import { Composition } from "remotion";
import { Example, exampleSchema } from "./Example";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Example"
        component={Example}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={exampleSchema}
        defaultProps={{ title: "Hello from Remotion" }}
      />
    </>
  );
};
`,

    "src/Example.tsx": `import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const exampleSchema = z.object({
  title: z.string(),
});

export const Example: React.FC<z.infer<typeof exampleSchema>> = ({ title }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const entrance = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(
    frame,
    [durationInFrames - 20, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b0e14",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <h1
        style={{
          color: "#e6edf3",
          fontFamily: "sans-serif",
          fontSize: 96,
          opacity: exit,
          transform: \`scale(\${entrance})\`,
        }}
      >
        {title}
      </h1>
    </AbsoluteFill>
  );
};
`,
  };
}

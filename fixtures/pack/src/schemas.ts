import { z } from "zod";

/** A label on a full-frame colour. Both props are bounded, as the pack gate requires. */
export const swatchSchema = z.strictObject({
  label: z.string().max(80),
  color: z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/),
});

/** No props: the slow template only ever holds its frame. */
export const slowSchema = z.strictObject({});

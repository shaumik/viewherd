export const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export const designIdSchema = { type: "string", minLength: 1, maxLength: 80 };
export const designDataSchema = {
  type: "object",
  properties: { designId: designIdSchema },
  required: ["designId"],
  additionalProperties: false,
};
export const designEditsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    theme: { type: "string", enum: ["sand", "midnight", "cobalt"] },
    format: { type: "string", enum: ["square", "story"] },
    headline: { type: "string", minLength: 1, maxLength: 80 },
    subhead: { type: "string", maxLength: 140 },
    eyebrow: { type: "string", maxLength: 48 },
    cta: { type: "string", minLength: 1, maxLength: 32 },
  },
};
export const targetedEditsSchema = {
  ...designEditsSchema,
  properties: { ...designEditsSchema.properties, designId: designIdSchema },
};

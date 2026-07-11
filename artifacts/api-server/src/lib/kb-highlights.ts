import { z } from "zod";

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue"] as const;
export const MAX_HIGHLIGHT_CHARS = 5_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export const createHighlightSchema = z
  .object({
    documentVersionId: z.string().uuid(),
    highlightedText: z
      .string()
      .min(1)
      .max(MAX_HIGHLIGHT_CHARS)
      .refine((value) => value.trim().length > 0),
    startOffset: z.number().int().min(0).max(MAX_POSTGRES_INTEGER),
    endOffset: z.number().int().positive().max(MAX_POSTGRES_INTEGER),
    color: z.enum(HIGHLIGHT_COLORS)
  })
  .strict()
  .refine((value) => value.endOffset > value.startOffset, {
    message: "endOffset must be greater than startOffset"
  })
  .refine(
    (value) => value.endOffset - value.startOffset === value.highlightedText.length,
    { message: "The selected text must match the highlight range" }
  );

export const updateHighlightSchema = z
  .object({
    color: z.enum(HIGHLIGHT_COLORS)
  })
  .strict();

export interface KbHighlightRow {
  id: string;
  highlighted_text: string;
  start_offset: number;
  end_offset: number;
  color: (typeof HIGHLIGHT_COLORS)[number];
  created_at: Date | string;
  updated_at: Date | string;
}

export function serializeHighlight(row: KbHighlightRow) {
  return {
    id: row.id,
    highlightedText: row.highlighted_text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    color: row.color,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

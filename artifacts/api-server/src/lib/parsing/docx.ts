/**
 * DOCX → markdown via the `mammoth` library.
 *
 * mammoth's convertToMarkdown returns { value, messages }. We discard the
 * messages (formatting warnings, not errors). The output is plain markdown
 * suitable for the same chunker we use for OCR output.
 */

interface MammothResult {
  value: string;
  messages?: unknown[];
}

interface MammothModule {
  convertToMarkdown(input: { buffer: Buffer }): Promise<MammothResult>;
}

export async function docxToMarkdown(buffer: Buffer): Promise<string> {
  // mammoth's bundled types only declare convertToHtml/extractRawText;
  // convertToMarkdown exists at runtime but is undocumented, hence the
  // through-unknown cast to our own minimal interface.
  const mod = (await import("mammoth")) as unknown as MammothModule;
  const result = await mod.convertToMarkdown({ buffer });
  return result.value;
}

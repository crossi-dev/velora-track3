interface PdfLinkLike {
  url?: string | null;
}

export function appendPdfToWhatsAppMessage(text: string, pdfLink?: PdfLinkLike | null) {
  const baseText = text.trim();
  const mediaUrl = typeof pdfLink?.url === "string" && pdfLink.url.trim()
    ? pdfLink.url.trim()
    : undefined;

  if (!mediaUrl) {
    return {
      text: baseText,
      mediaUrl: undefined,
    };
  }

  return {
    text: baseText,
    mediaUrl,
  };
}

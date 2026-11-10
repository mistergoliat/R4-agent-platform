import type { StructuredLogger } from '@r4/observability';
import type { QuoteDocumentDelivery } from './quote-v2.js';

/** The store seam it needs: the production store's platform notice with a document. */
export interface QuoteDocumentNoticeSink {
  createPlatformNotice(command: {
    readonly taskId: string;
    readonly noticeKey: string;
    readonly text: string;
    readonly correlationId: string;
    readonly document: { readonly contentType: 'application/pdf'; readonly filename: string; readonly sha256: string; readonly bytes: Uint8Array };
  }): Promise<{ readonly replayed: boolean }>;
}

/** One notice per issued quote: a repeated settlement (replay, reconciliation) is a replay, never a second document. */
export const quoteDocumentNoticeKey = (quoteId: string) => `sales.quote-document:${quoteId.toLowerCase()}`;
export const quoteDocumentFilename = (quoteNumber: string) => `Cotizacion-${quoteNumber.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`.slice(0, 120);
/** The owner's validity instant (exclusive), as date and time in Chile (America/Santiago, daylight saving included). */
export function chileDateTime(instant: string): { readonly date: string; readonly time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return { date: `${parts.day}-${parts.month}-${parts.year}`, time: `${parts.hour}:${parts.minute}` };
}
export const quoteDocumentCaption = (quoteNumber: string, validUntilExclusive: string) => {
  const until = chileDateTime(validUntilExclusive);
  return `Cotización N° ${quoteNumber} (PDF). Válida hasta el ${until.date} a las ${until.time} (hora de Chile).`;
};

/**
 * (Quote PDF delivery, sales-production@18) Queues the issued quote's own PDF to its conversation as a platform notice
 * with the document: the single delivery owner sends it to the conversation's contact, under the agent-output gates.
 * Never throws — the quote is already issued and must stay so: a failure is reported (`quote.document.not_queued`,
 * without the file, its name or the recipient) and leaves the quote untouched.
 */
export function quoteDocumentDelivery(notices: QuoteDocumentNoticeSink, logger: StructuredLogger): QuoteDocumentDelivery {
  return {
    async queue(d) {
      try {
        const { replayed } = await notices.createPlatformNotice({
          taskId: d.taskId,
          noticeKey: quoteDocumentNoticeKey(d.quoteId),
          text: quoteDocumentCaption(d.quoteNumber, d.validUntilExclusive),
          correlationId: d.correlationId,
          document: { contentType: 'application/pdf', filename: quoteDocumentFilename(d.quoteNumber), sha256: d.sha256, bytes: d.bytes },
        });
        logger.info({ event: 'quote.document.queued', taskId: d.taskId, quoteId: d.quoteId, replayed, correlationId: d.correlationId }, 'quote document queued');
      } catch (error) {
        const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unexpected';
        logger.warn({ event: 'quote.document.not_queued', taskId: d.taskId, quoteId: d.quoteId, errorCode: code, correlationId: d.correlationId }, 'quote document not queued');
      }
    },
  };
}

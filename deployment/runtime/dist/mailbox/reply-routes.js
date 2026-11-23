import { parse, z } from '../http/validation.js';
import { MailboxReplyService } from './reply-service.js';
export function mailboxReplyRoutes(app, identity, archive) {
    const service = new MailboxReplyService(identity, archive);
    const source = (input) => parse(z.object({ mailboxId: z.string(), messageKey: z.string() }).strict(), input);
    app.get('/api/v4/mailbox-replies/templates', req => service.catalog(req.actor));
    app.post('/api/v4/mailbox-replies/test/preview', req => service.preview(req.actor, undefined, req.body));
    app.post('/api/v4/mailbox-replies/test/send', req => service.send(req.actor, undefined, req.body, req.headers['idempotency-key']));
    app.get('/api/v4/mailbox-replies/test/receipts', req => service.receipts(req.actor));
    app.get('/api/v4/mailboxes/:mailboxId/messages/:messageKey/reply-context', req => service.context(req.actor, source(req.params)));
    app.post('/api/v4/mailboxes/:mailboxId/messages/:messageKey/reply-preview', req => service.preview(req.actor, source(req.params), req.body));
    app.post('/api/v4/mailboxes/:mailboxId/messages/:messageKey/replies', req => service.send(req.actor, source(req.params), req.body, req.headers['idempotency-key']));
    app.get('/api/v4/mailboxes/:mailboxId/messages/:messageKey/replies', req => service.receipts(req.actor, source(req.params)));
}
//# sourceMappingURL=reply-routes.js.map
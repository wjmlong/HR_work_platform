import { EventDispatcher, WSClient, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { InterviewFeedback } from './service.js';
export function createCardActionRouter(handlers) {
    const routes = new Map(Object.entries(handlers));
    return async (data) => {
        const kind = data?.action?.value?.kind, handler = typeof kind === 'string' ? routes.get(kind) : undefined;
        return handler ? handler(data) : { toast: { type: 'error', content: '此卡片暂无法处理，请联系对应业务负责人。' } };
    };
}
export function startInterviewFeedbackListener(identity, additionalHandlers = {}) {
    const service = new InterviewFeedback(identity);
    if (!service.enabled)
        return { close() { } };
    const f = identity.config.feishu;
    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
        'card.action.trigger': createCardActionRouter({ ...additionalHandlers, interview_confirmation: data => service.handleCardAction(data) }),
    });
    const client = new WSClient({ appId: f.appId, appSecret: f.appSecret, loggerLevel: LoggerLevel.error });
    void client.start({ eventDispatcher: dispatcher }).catch(() => console.error('Feishu interview feedback connection unavailable'));
    return { close() { client.close({ force: true }); } };
}
//# sourceMappingURL=listener.js.map
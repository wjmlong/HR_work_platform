const plain = (content) => ({ tag: 'plain_text', content });
export function confirmationCard(input, jobName) {
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(input.startsAt));
    const button = (decision, label) => ({ tag: 'button', name: decision, text: plain(label), type: decision === 'accepted' ? 'primary' : 'default', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { kind: 'interview_confirmation', id: input.id, token: input.token, decision } }] });
    return { schema: '2.0', config: { update_multi: true, enable_forward: false }, header: { title: plain('请确认面试安排'), template: 'blue' }, body: { elements: [
                { tag: 'div', text: plain(`${jobName}\n第 ${input.round} 轮 · ${time}（北京时间）\n${input.durationMinutes} 分钟 · 安排编号 ${input.id.slice(0, 8)}`) },
                { tag: 'form', name: 'attendance', elements: [
                        { tag: 'input', name: 'reason', placeholder: plain('拒绝时请填写原因，最多 500 字；提交后 HR 可见'), max_length: 500 },
                        button('accepted', '确认参加'), button('declined', '拒绝并反馈原因'),
                    ] },
            ] } };
}
//# sourceMappingURL=card.js.map
import { targetForBand } from './gears.ts';
import { parseObserverEvent } from './observer-routing.ts';
import type { CapabilityProfile, GearSettings, ObserverStateV1 } from './types.ts';

export interface ObserverStatusActivity {
	pending?: 'turn' | 'handoff' | undefined;
	/** Ephemeral SDK coverage notice only; never routing authority. */
	accountingUnknown?: boolean;
}
const profiles: Record<CapabilityProfile, string> = { converge: '收敛', implement: '实施', verify: '验证', respond: '回应' };
const reasons: Record<string, string> = {
	'timeout': 'Jev 超时', 'transport': '观察服务传输失败', 'service-or-adapter-error': '观察服务不可用',
	'model-unavailable': '观察模型不可用', 'auth-unavailable': '观察认证不可用', 'aborted': '观察已取消',
	'invalid-shape': '观察格式无效', 'invalid-probabilities': '观察概率无效', 'missing-field': '观察字段缺失',
	'readiness-not-accepted': '交接证据不足·保持', 'method-or-control-wait': '方法／控制等待',
	'new-input': '新输入使交接失效', 'catalog-changed': '目录变化使交接失效',
	'runtime-changed': '运行环境变化使交接失效', 'mode-changed': '模式变化使交接失效',
	'readiness-unavailable-or-stale': '交接不可用或已过期', 'candidate-invalidated': '交接候选失效',
	'accounting-coverage-unknown': '用量记账覆盖不足', 'reservation-failed': '调用预留失败',
	'accounting-failed': '用量记账失败', 'budget-exhausted': '观察额度耗尽',
};
/** Remove terminal control sequences, including OSC links. Never render raw diagnostic/packet text. */
function safe(value: string, max = 100): string {
	const chars = [...value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')];
	return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}
/** Read-only presentation of validated state and current-branch events. No IO, policy updates or classification. */
export function observerStatus(state: ObserverStateV1, branch: readonly unknown[], settings: GearSettings, activity: ObserverStatusActivity = {}) {
	const events = branch.flatMap(entry => { const e = parseObserverEvent(entry); return e ? [e] : []; });
	const current = events.filter(e => e.data.identity.sessionId === state.turn.sessionId
		&& e.data.identity.userEntryId === state.turn.userEntryId && e.data.identity.userContentDigest === state.turn.userContentDigest
		&& e.data.identity.policyFingerprint === state.turn.policyFingerprint && e.data.identity.catalogVersion === state.turn.catalogVersion);
	const capabilities = current.flatMap(e => e.customType === 'pi-gear-router.capability.v1' ? [e.data] : []);
	const last = capabilities.at(-1), handoff = last ? capabilities.filter(e => e.id === last.id && e.packetDigest === last.packetDigest) : [];
	const accepted = handoff.some(e => e.kind === 'accepted'), consumed = handoff.some(e => e.kind === 'consumed');
	const responded = handoff.some(e => e.kind === 'physical-response-observed');
	const invalidated = handoff.at(-1)?.kind === 'invalidated';
	const target = targetForBand(settings, state.capability.protectedBand);
	const fallback = state.dispatch.provider !== settings.gears[target.gear].provider || state.dispatch.model !== settings.gears[target.gear].model
		|| state.dispatch.thinkingLevel !== target.thinkingLevel;
	const observation = state.observation, fields = Object.values(observation?.fields ?? {});
	const partial = observation?.outcome === 'partial' || observation?.outcome === 'invalid';
	const waiting = state.task?.methodObservations.some(f => !!f.waitingFor);
	const effect = observation?.fields.messageEffect;
	const explain = effect?.status === 'valid' && effect.type === 'choice' && effect.choice === 'explain' && state.capability.turnProfile === 'respond';
	const temporary = state.capability.turnProfile === 'respond' && state.capability.protectedBand < state.capability.taskBand;
	const exhausted = state.budget.exhausted || state.budget.logicalCalls >= settings.observer.maxCallsPerTask;
	let key = '', warning = false, error = false;
	if (activity.pending) key = activity.pending === 'handoff' ? '交接评估中…' : 'Jev 观察中…';
	else if (exhausted) { key = '观察额度耗尽'; warning = true; }
	else if (activity.accountingUnknown) { key = '用量记账覆盖不足'; warning = true; }
	else if (fallback) { key = '目标不可用／thinking 裁剪·回退'; warning = true; }
	else if (waiting) { key = '方法等待／待核对'; warning = true; }
	else if (invalidated) { key = reasons[last?.reason ?? ''] ?? '交接已失效·保持'; warning = true; }
	else if (observation?.failure) { key = reasons[observation.failure] ?? '观察不可用'; warning = true; error = ['invalid-shape', 'invalid-probabilities'].includes(observation.failure); }
	else if (partial) { key = '观察字段无效／缺失'; warning = true; error = observation?.outcome === 'invalid'; }
	else if (state.diagnostics.reasons.includes('inherited')) key = '沿用，无新观察';
	else if (state.diagnostics.coverage !== 'known') { key = '事件覆盖不足'; warning = true; }
	else if (temporary) key = '临时降档';
	else if (responded && consumed) key = '交接已生效';
	else if (consumed) key = '交接已消费·待响应';
	else if (accepted) key = '交接已接受·未消费';
	else if (last?.kind === 'proposed') key = '交接候选';
	else if (state.capability.protectedBand > state.capability.requestedBand) key = '能力保护';
	else if (!observation) key = '沿用';
	if (activity.pending && key) key += '（沿用最近记录）';
	const work = observation?.failure ? '沿用' : explain ? '解释' : profiles[state.capability.turnProfile];
	const model = safe(state.dispatch.model.split('/').at(-1) ?? state.dispatch.model, 42);
	const text = `路由 ${work} → ${model} · ${state.dispatch.thinkingLevel}${key ? ` ｜ ${key}` : ''} ｜ Jev ${state.budget.logicalCalls}/${settings.observer.maxCallsPerTask}`;
	const guide = current.flatMap(e => e.customType === 'pi-gear-router.observer.v1' && e.data.guidance?.key === state.guidance?.key ? [e.data.guidance] : []).at(-1);
	const facts = current.flatMap(e => e.customType === 'pi-gear-router.observer.v1' && e.data.fact?.catalogVersion === state.turn.catalogVersion && e.data.fact ? [e.data.fact] : []);
	const read = facts.some(f => f.kind === 'body-read-observed'), explicit = facts.some(f => f.kind === 'explicit-expansion-observed');
	const skill = `${state.guidance?.candidateIds.length ? `建议候选 ${state.guidance.candidateIds.length} 个` : '无当前建议'}；${read ? '已观察读取' : explicit ? '已观察显式展开' : '读取未观察到'}；遵循未知`;
	const chain = invalidated ? '已失效' : [accepted ? '已接受' : '', consumed ? '已消费' : '', responded ? '已观察实际响应' : ''].filter(Boolean).join(' → ') || (last ? '候选' : '无当前交接');
	const sources = new Set(branch.flatMap(entry => {
		const e = entry as { id?: unknown; type?: unknown; message?: { role?: unknown } } | null;
		return e?.type === 'message' && e.message?.role === 'user' && typeof e.id === 'string' ? [e.id] : [];
	}));
	const observerEvents = events.flatMap(e => e.customType === 'pi-gear-router.observer.v1' && e.data.budgetOwnerId === state.budget.ownerId && e.data.call
		&& (e.data.identity.sessionId === state.turn.sessionId || sources.has(e.data.identity.userEntryId)) ? [e.data] : []);
	const calls = new Map(observerEvents.map(e => [e.call!.callId, e]));
	const reportedUsage = observerEvents.filter(e => e.usage).length;
	const detail = [
		'模式：observer（能力路由，不表示实施批准或业务完成）',
		`本轮工作：${work}（${state.capability.turnProfile}）${temporary ? '，临时降档' : ''}`,
		`持续任务：${profiles[state.capability.persistentProfile]}，能力 band ${state.capability.taskBand}`,
		`本轮请求／保护能力：${state.capability.requestedBand} → ${state.capability.protectedBand}`,
		`实际派发：${safe(state.dispatch.provider)}/${safe(state.dispatch.model)} · ${state.dispatch.thinkingLevel}`,
		`派发准备／响应：${responded && consumed ? '当前交接已观察响应' : '已准备；不据此保证响应成功'}${fallback ? '；目标不可用或thinking裁剪' : ''}`,
		`能力交接：${chain}${accepted && !consumed && !invalidated ? '（仅持久接受事实，不保证仍可消费）' : ''}`,
		`观察调用：${state.budget.logicalCalls}/${settings.observer.maxCallsPerTask}；transport attempts：${state.budget.transportAttempts}`,
		`能力转换：${state.budget.transitions}/${settings.observer.maxTransitions}；引导：${state.budget.guides}/${settings.observer.guidance.maxPerTask}`,
		`观察：${activity.pending ? '正在评估；以下为最近已记录状态' : state.diagnostics.reasons.includes('inherited') ? '沿用，无新观察' : observation ? observation.outcome === 'valid' ? '字段格式有效，不等于判断可信' : partial ? '字段无效／缺失' : '不可用／取消' : '沿用，无新观察'}`,
		`字段：有效 ${fields.filter(f => f.status === 'valid').length}；无效 ${fields.filter(f => f.status === 'invalid').length}；缺失 ${fields.filter(f => f.status === 'missing').length}`,
		`覆盖：事件 ${state.diagnostics.coverage}${activity.accountingUnknown ? '；用量记账不足' : ''}；目录 ${state.diagnostics.reasons.some(r => r.startsWith('catalog-coverage-')) ? '不足' : '未单独证实完整覆盖'}`,
		`Skill：${skill}；引导${guide?.status === 'response-observed' ? '已观察响应' : guide?.status === 'projected' ? '已投影' : state.guidance ? '已准备' : '无'}`,
		`用量：${reportedUsage ? `有 ${new Set(observerEvents.filter(e => e.usage).map(e => e.call!.callId)).size} 个调用报告usage` : '未报告'}，price=0或缺失不代表免费；调用记录 ${calls.size}`,
		...Object.entries(observation?.fields ?? {}).map(([name, f]) => `${name}：${f.status === 'valid' ? f.type === 'score' ? `score ${f.score}，confidence ${f.confidence}` : f.type === 'choice' ? `${safe(f.choice)}，confidence ${f.confidence}，p ${f.probabilities[f.choice]}` : `p ${f.probability}` : f.status}`),
		...(key ? [`当前提示：${key}`] : []),
	];
	return { text, details: detail.join('\n'), tone: error ? 'error' as const : warning ? 'warning' as const : 'accent' as const };
}

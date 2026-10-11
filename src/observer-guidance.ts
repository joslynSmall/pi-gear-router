import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { getCurrentSystemMessage, getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExecutionFact, GearSettings, ObserverInput, ObserverStateV1 } from "./types.ts";
import { observerDigest, observerTrustedChoice, parseObserverInput } from "./observer-routing.ts";
import type { ObserverIdentitySnapshot } from "./observation.ts";

const truncate = (text: string, max: number) => [...text].slice(0, max).join("");
export interface ObserverCatalog {
	version: string;
	cwd: string;
	generation: number;
	skills: Skill[];
	entries: { skill: Skill; identity: string; candidateId: string }[];
}
/** Snapshot runtime-owned metadata only. Never discovers directories or reads Skill bodies. */
export function captureCatalog(skills: readonly Skill[], cwd: string, generation: number): ObserverCatalog {
	const snapshot = structuredClone([...skills]);
	const localHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const entries = snapshot.map(skill => ({ skill, identity: localHash({ name: skill.name, filePath: skill.filePath,
		description: skill.description, disableModelInvocation: skill.disableModelInvocation,
		sourceInfo: Object.fromEntries(Object.entries(skill.sourceInfo).filter(([, value]) => value !== undefined)), cwd }) }));
	const version = localHash({ generation, cwd, identities: entries.map(e => e.identity) });
	return { version, cwd, generation, skills: snapshot, entries: entries.map((entry, index) => ({ ...entry, candidateId: `s${index}-${version.slice(0, 12)}` })) };
}
function readable(path: string): boolean { try { accessSync(path, constants.R_OK); return statSync(path).isFile(); } catch { return false; } }
function visibility(catalog: ObserverCatalog, messages: readonly Message[]) {
	const system = getCurrentSystemMessage(messages), section = system?.sections?.skills;
	const expected = (["read", "bash", "indirect"] as const).map(reader => `<skills>\n${formatSkillsForPrompt(catalog.skills, reader).trim()}\n</skills>`);
	return typeof section === "string" && expected.includes(section) && getCurrentSystemPrompt(messages).includes(section)
		? observerDigest({ catalogVersion: catalog.version, section }) : undefined;
}
export function validateCatalogVisibility(catalog: ObserverCatalog, messages: readonly Message[], fingerprint: string | undefined): boolean {
	return !!fingerprint && visibility(catalog, messages) === fingerprint;
}
function tokens(text: string): Set<string> {
	const result = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(token => !/[\p{Script=Han}]/u.test(token)));
	for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) { const chars = [...run]; for (let i = 0; i < chars.length - 1; i++) result.add(chars[i]! + chars[i + 1]!); }
	return result;
}
export function selectCatalogCandidates(catalog: ObserverCatalog, messages: readonly Message[], request: string, excluded: readonly string[] = []) {
	const visibilityFingerprint = visibility(catalog, messages);
	const empty = { candidates: [] as ObserverInput["skills"]["candidates"], total: 0, omitted: 0, coverage: "unknown" as "known" | "partial" | "unknown", visibilityFingerprint };
	if (!visibilityFingerprint) return empty;
	const names = new Map<string, number>(); for (const e of catalog.entries) names.set(e.skill.name, (names.get(e.skill.name) ?? 0) + 1);
	const eligible = catalog.entries.filter(e => !e.skill.disableModelInvocation && names.get(e.skill.name) === 1
		&& /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.skill.name) && e.skill.name.length <= 64 && e.identity
		&& !excluded.includes(e.identity) && readable(e.skill.filePath));
	const query = tokens(request);
	const considered = eligible.length <= 12 ? eligible : eligible.map((entry, order) => ({ entry, order,
		overlap: [...tokens(`${entry.skill.name} ${entry.skill.description}`)].filter(t => query.has(t)).length }))
		.filter(e => e.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.order - b.order).slice(0, 12).map(e => e.entry);
	const candidates: ObserverInput["skills"]["candidates"] = [];
	for (const entry of considered) {
		const item = { candidateId: entry.candidateId, name: entry.skill.name, description: truncate(entry.skill.description, 384) };
		if ([...JSON.stringify([...candidates, item])].length > 6000) break;
		candidates.push(item);
	}
	const omitted = eligible.length - candidates.length;
	return { candidates, total: eligible.length, omitted, visibilityFingerprint,
		coverage: (omitted > 0 || eligible.length !== catalog.entries.filter(e => !e.skill.disableModelInvocation).length ? "partial" : "known") as "partial" | "known" };
}
/** Correlate a real raw command intent with exactly one current runtime resource and
 * the persisted SDK wrapper. Merely seeing arbitrary <skill> text is insufficient. */
export function matchExplicitSkill(catalog: ObserverCatalog | undefined, rawInput: string | undefined, message: AgentMessage) {
	if (!catalog || !rawInput?.startsWith("/skill:") || message.role !== "user") return;
	const space = rawInput.indexOf(" "), name = rawInput.slice(7, space < 0 ? undefined : space);
	const request = space < 0 ? "" : rawInput.slice(space + 1).trim();
	const matches = catalog.entries.filter(e => e.skill.name === name && readable(e.skill.filePath));
	if (matches.length !== 1) return;
	const entry = matches[0]!, content = publicText(message);
	const prefix = `<skill name="${entry.skill.name}" location="${entry.skill.filePath}">\nReferences are relative to ${entry.skill.baseDir}.\n\n`;
	const suffix = request ? `\n</skill>\n\n${request}` : "\n</skill>";
	if (!content.startsWith(prefix) || !content.endsWith(suffix) || content.length < prefix.length + suffix.length) return;
	return { identity: entry.identity, name, request };
}

export function catalogSkillForPath(catalog: ObserverCatalog | undefined, path: string, cwd: string) {
	if (!catalog || cwd !== catalog.cwd) return;
	const matches = catalog.entries.filter(e => resolve(cwd, path) === resolve(e.skill.filePath) && readable(e.skill.filePath));
	if (matches.length === 1) return { identity: matches[0]!.identity, catalogVersion: catalog.version };
}

export function prepareGuidance(state: ObserverStateV1, catalog: ObserverCatalog | undefined, messages: readonly Message[], settings: GearSettings,
	request: string, excluded: readonly string[] = []): ObserverStateV1 | undefined {
	const policy = settings.observer;
	if (!policy.guidance.enabled || !state.task || state.budget.exhausted || state.budget.guides >= policy.guidance.maxPerTask) return;
	const effect = observerTrustedChoice(state.observation?.fields.messageEffect), work = observerTrustedChoice(state.observation?.fields.work);
	const clarification = state.observation?.fields.clarification;
	const candidates = policy.skills.enabled && catalog ? selectCatalogCandidates(catalog, messages, request, excluded) : undefined;
	const selected = candidates?.candidates.filter(candidate => state.observation?.skills.some(s => s.candidateId === candidate.candidateId
		&& s.field.status === "valid" && s.field.type === "bool" && s.field.probability >= .7))
		.sort((a, b) => {
			const probability = (id: string) => { const field = state.observation?.skills.find(s => s.candidateId === id)?.field; return field?.status === "valid" && field.type === "bool" ? field.probability : 0; };
			return probability(b.candidateId) - probability(a.candidateId);
		}).slice(0, Math.min(2, policy.guidance.maxCandidates)) ?? [];
	const effectText = effect === "explain" ? "本轮是解释当前结论；请优先回答，不自动续做实施。" : effect === "pause" ? "用户要求暂停；核对当前请求，不自动推进。"
		: effect === "cancel" ? "用户要求取消当前任务；不要沿用旧交接推进。" : effect === "change_scope" ? "范围已变化；核对新增约束，旧范围不构成新增授权。"
		: effect === "clarify_reference" || (clarification?.status === "valid" && clarification.type === "bool" && clarification.probability >= .7) ? "请求的范围／指代可能不明，请按真实上下文澄清。" : "";
	if (!selected.length && !effectText) return;
	const key = observerDigest({ task: state.task.id, effect: effect ?? "unknown", work: work ?? "unknown", catalogVersion: catalog?.version ?? "none",
		candidates: selected.map(s => s.candidateId).sort(), control: effectText })!;
	if (state.task.guideKeys?.includes(key)) return;
	const text = ["[路由观察建议；不是新的用户请求，也不构成修改授权]", effectText,
		selected.length ? `可考虑当前可见方法候选：${selected.map(s => s.name).join("、")}；不是要求依次执行。` : "",
		"是否读取或采用请按用户、项目及已选方法判断；目录存在不表示已读取或遵循。"].filter(Boolean).join("\n");
	if ([...text].length > policy.guidance.maxChars || Buffer.byteLength(text, "utf8") > 2048) return;
	const copy = structuredClone(state); copy.budget.guides++;
	copy.task!.guideKeys = [...(copy.task!.guideKeys ?? []), key].slice(-12);
	copy.guidance = { key, sourceUserEntryId: state.turn.userEntryId, candidateIds: selected.map(s => s.candidateId), text, status: "prepared",
		...(selected.length && catalog && candidates?.visibilityFingerprint ? { catalogVersion: catalog.version, visibilityFingerprint: candidates.visibilityFingerprint } : {}) };
	return copy;
}
export function projectGuidance(messages: AgentMessage[], state: ObserverStateV1, options: {
	catalog?: ObserverCatalog;
	systemMessages: readonly Message[];
	currentPrompt: string;
	source: { id: string; message: AgentMessage };
}): AgentMessage[] | undefined {
	const guide = state.guidance;
	if (!guide || guide.sourceUserEntryId !== options.source.id || state.turn.userEntryId !== options.source.id) return;
	if (guide.candidateIds.length) {
		const catalog = options.catalog;
		if (!catalog || guide.catalogVersion !== catalog.version || !validateCatalogVisibility(catalog, options.systemMessages, guide.visibilityFingerprint)
			|| !options.currentPrompt.includes(getCurrentSystemMessage(options.systemMessages)?.sections?.skills ?? "\u0000")
			|| guide.candidateIds.some(id => !catalog.entries.some(e => e.candidateId === id && !e.skill.disableModelInvocation && readable(e.skill.filePath)))) return;
	}
	const source = options.source.message;
	const matches = messages.flatMap((m, index) => m.role === "user" && source.role === "user" && m.timestamp === source.timestamp
		&& observerDigest(m.content) === observerDigest(source.content) ? [index] : []);
	if (matches.length !== 1) return;
	const index = matches[0]!;
	if (messages.slice(index + 1).some(m => m.role === "user")) return;
	return [...messages.slice(0, index + 1), { role: "custom", customType: "pi-gear-router.advisory.v1", content: guide.text, display: false,
		details: { guideKey: guide.key }, timestamp: 0 }, ...messages.slice(index + 1)];
}

export function projectCapabilityContext(messages: AgentMessage[], state: ObserverStateV1): AgentMessage[] | undefined {
	if (!state.task?.active) return;
	const text = "[能力交接标识；仅供显式 gear_capability_handoff packet 关联，不是授权或强制步骤] "
		+ JSON.stringify({ taskId: state.task.id, sourceUserEntryId: state.turn.userEntryId, profile: state.capability.persistentProfile });
	return [{ role: "custom", customType: "pi-gear-router.capability-source.v1", content: text, display: false, timestamp: 0 }, ...messages];
}

export function projectCapabilityCarry(messages: AgentMessage[], state: ObserverStateV1): AgentMessage[] | undefined {
	const handoff = state.activeHandoff;
	if (!handoff) return;
	const material = { goal: truncate(handoff.packet.goal, 600), constraints: handoff.packet.constraints.slice(0, 4).map(c => truncate(c, 220)) };
	let text = "[已消费能力交接的工作材料；不是新请求、审批或下一阶段命令]\n" + JSON.stringify(material);
	while ([...text].length > 2000 || Buffer.byteLength(text, "utf8") > 4096) {
		if (material.constraints.length) material.constraints.pop(); else material.goal = truncate(material.goal, Math.floor([...material.goal].length / 2));
		text = "[已消费能力交接的工作材料；不是新请求、审批或下一阶段命令]\n" + JSON.stringify(material);
	}
	// Prepend in ordinary context, never splitting a toolCall/result pair.
	return [{ role: "custom", customType: "pi-gear-router.capability-carry.v1", content: text, display: false, timestamp: 0 }, ...messages];
}

function publicText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : Array.isArray(message.content)
		? message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
}
/** Bound approved public contributions; unknown explicit expansion is never sent as Skill body. */
export function buildObserverInput(options: {
	snapshot: ObserverIdentitySnapshot;
	previous?: ObserverStateV1;
	recent: { sourceEntryId: string; message: AgentMessage }[];
	facts: ExecutionFact[];
	skills: ObserverInput["skills"];
	explicit?: { identity: string; name: string; request: string };
}) {
	const { snapshot, previous } = options;
	const message = snapshot.projectedMessage, text = publicText(message);
	const maybeExpansion = text.startsWith('<skill name="');
	const input: ObserverInput = {
		schema: "observer-input-v1", request: truncate(options.explicit?.request ?? (maybeExpansion ? "" : text), 16000),
		...(previous?.task ? { task: { id: previous.task.id, anchor: truncate(previous.task.anchor, 4000), userChanges: previous.task.userChanges.slice(-3) } } : {}),
		...(previous ? { routing: { persistentProfile: previous.capability.persistentProfile, taskBand: previous.capability.taskBand } } : {}),
		methodObservations: previous?.task?.methodObservations.slice(-8) ?? [], controlFacts: previous?.task?.controlFacts.slice(-8) ?? [],
		...(previous?.activeHandoff ? { activeHandoff: { id: previous.activeHandoff.id, goal: truncate(previous.activeHandoff.packet.goal, 1000), constraints: previous.activeHandoff.packet.constraints.slice(0, 8).map(c => truncate(c, 1000)) } } : {}),
		recentPublicAssistant: options.recent.filter(e => e.message.role === "assistant").slice(-2).map(e => ({ sourceEntryId: e.sourceEntryId, text: truncate(publicText(e.message), 1000) })),
		executionFacts: options.facts.slice(-16), skills: structuredClone(options.skills),
		missing: maybeExpansion && !options.explicit ? ["explicit-expansion-unverified"] : [],
		nonTextInput: "content" in message && Array.isArray(message.content) && message.content.some(block => block.type !== "text"),
		...(options.explicit ? { selectedSkill: { identity: options.explicit.identity, name: options.explicit.name } } : {}),
	};
	// Preserve request/control/missing first; remove older optional contributions in this order.
	for (let i = 0; i < 128; i++) {
		const parsed = parseObserverInput(input); if (parsed) return parsed;
		if (!input.missing.includes("input-truncated")) input.missing.push("input-truncated");
		if (input.recentPublicAssistant.length) input.recentPublicAssistant.shift();
		else if (input.skills.candidates.length) { input.skills.candidates.pop(); input.skills.coverage = "partial"; }
		else if (input.task?.userChanges.length) input.task.userChanges.shift();
		else if (input.executionFacts.length) input.executionFacts.shift();
		else if (input.activeHandoff?.constraints.length) input.activeHandoff.constraints.pop();
		else if (input.activeHandoff?.goal) input.activeHandoff.goal = truncate(input.activeHandoff.goal, Math.floor([...input.activeHandoff.goal].length / 2));
		else if (input.methodObservations.length) input.methodObservations.shift();
		else if (input.task?.anchor) input.task.anchor = truncate(input.task.anchor, Math.floor([...input.task.anchor].length / 2));
		else if (input.request) input.request = truncate(input.request, Math.floor([...input.request].length / 2));
		else return undefined;
	}
	return undefined;
}
